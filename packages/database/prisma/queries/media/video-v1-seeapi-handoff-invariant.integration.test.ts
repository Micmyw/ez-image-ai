import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countSeeapiVideoHandoffViolations } from "../../../../../tests/load/video-seeapi-handoff-invariant";
import { isExplicitVideoVerificationTarget } from "../../../../../tests/load/video-verification-target";
import { runWithDatabaseClient } from "../../client";
import { PrismaClient, type Prisma } from "../../generated/client";
import {
	markSeeapiVideoModerationWebhookNotified,
	persistSeeapiVideoModerationWebhook,
} from "./video-v1-seeapi-events";

let client: PrismaClient;
const jobs: string[] = [];
const quotes: string[] = [];
const assets: string[] = [];
const events: string[] = [];

beforeAll(() => {
	const value = process.env.TEST_DATABASE_URL;
	if (
		!value ||
		value !== process.env.DATABASE_URL ||
		!isExplicitVideoVerificationTarget(new URL(value))
	)
		throw new Error("ISOLATED_VIDEO_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: value, max: 4 }) });
});
afterAll(async () => {
	if (!client) return;
	try {
		await client.providerWebhookEvent.deleteMany({ where: { id: { in: events } } });
		await client.generationJob.deleteMany({ where: { id: { in: jobs } } });
		await client.mediaAsset.deleteMany({ where: { id: { in: assets } } });
		await client.generationQuote.deleteMany({ where: { id: { in: quotes } } });
	} finally {
		await client.$disconnect();
	}
});

async function fixture(rawBody = '{"event":"opaque-body-without-task-id"}') {
	const ownerId = `seeapi-handoff-invariant-${randomUUID()}`;
	const profile = createVideoVisualSafetyProfile("seeapi", 5);
	const inputSnapshot = { duration: 5, visualSafetyProfile: profile };
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "video-kling-2-6-v1",
			catalogVersion: "TEST",
			pricingVersion: "TEST",
			credits: 1n,
			costMicros: 1n,
			inputSnapshot,
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	quotes.push(quote.id);
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			productKey: quote.productKey,
			catalogVersion: "TEST",
			pricingVersion: "TEST",
			creditsReserved: 1n,
			inputSnapshot,
			pricingSnapshot: {},
			executionEngine: "video-workflow-v1",
			// Fixtures must never occupy another suite's provider-capacity slots.
			status: "FAILED",
			terminalAt: new Date(),
			failureCode: "ISOLATED_TEST_FIXTURE",
		},
	});
	jobs.push(job.id);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			verificationEngine: "video-workflow-v1",
			verificationProvider: "seeapi",
			verificationRuleVersion: profile.ruleVersion,
			verificationPolicyVersion: profile.policyVersion,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationSubmittedAt: new Date(),
			verificationSubmissionToken: randomUUID(),
			verificationSubmissionUncertain: true,
			verificationProviderTaskId: null,
			objectKey: `test/${ownerId}/sealed.mp4`,
			mimeType: "video/mp4",
			byteSize: 1000n,
			durationMillis: 5000n,
			checksum: "b".repeat(64),
			storageEtag: `etag-${randomUUID()}`,
			finalizedAt: new Date(),
		},
	});
	assets.push(asset.id);
	const binding = await client.generationJobAsset.create({
		data: {
			jobId: job.id,
			assetId: asset.id,
			role: "OUTPUT",
			position: 0,
			assetChecksum: asset.checksum!,
		},
	});
	const outputSpec = {
		assetId: asset.id,
		checksum: asset.checksum,
		etag: asset.storageEtag,
		audioTracks: 0,
	};
	await client.videoExecution.create({
		data: {
			jobId: job.id,
			workflowInstanceId: `video-v1-${job.id}`,
			modelContractVersion: "TEST",
			stage: "OUTPUT_REVIEW",
			stageData: { outputSpec },
		},
	});
	const persisted = await runWithDatabaseClient(client, () =>
		persistSeeapiVideoModerationWebhook({
			assetId: asset.id,
			generation: 1,
			attemptNumber: 1,
			rawBody,
			eventHash: createHash("sha256").update(rawBody).digest("hex"),
			receivedAt: new Date(),
		}),
	);
	events.push(persisted.eventId);
	const event = await client.providerWebhookEvent.findUniqueOrThrow({
		where: { id: persisted.eventId },
	});
	return { job, asset, binding, event, outputSpec };
}

const count = (eventId: string) =>
	countSeeapiVideoHandoffViolations(client, { eventIds: [eventId] });
async function changeEnvelope(
	eventId: string,
	mutate: (value: Prisma.InputJsonObject) => Prisma.InputJsonObject,
) {
	const event = await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
	await client.providerWebhookEvent.update({
		where: { id: eventId },
		data: { envelope: mutate(event.envelope as Prisma.InputJsonObject) },
	});
}

describe("SeeAPI durable handoff invariant on isolated PostgreSQL", () => {
	it("accepts an authentic early callback without a task ID or global Outbox", async () => {
		const f = await fixture();
		expect(f.event.providerTaskId).toBeNull();
		expect(f.event.envelope).not.toHaveProperty("taskId");
		expect(f.event.envelope).toMatchObject({ notifiedAt: null });
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: { in: [f.job.id, f.asset.id, f.event.id] } },
			}),
		).toBe(0);
		await expect(count(f.event.id)).resolves.toBe(0n);
	});

	it("accepts notification after task binding while the early event still has a null task ID", async () => {
		const f = await fixture();
		await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: { verificationProviderTaskId: "later-task" },
		});
		await runWithDatabaseClient(client, () => markSeeapiVideoModerationWebhookNotified(f.event.id));
		const event = await client.providerWebhookEvent.findUniqueOrThrow({
			where: { id: f.event.id },
		});
		expect(event.providerTaskId).toBeNull();
		expect(event.envelope).toMatchObject({ notifiedAt: expect.any(String) });
		await expect(count(f.event.id)).resolves.toBe(0n);
	});

	it("preserves valid historical generations after recheck, task change and soft deletion", async () => {
		const f = await fixture();
		await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: {
				verificationGeneration: 3,
				verificationAttemptCount: 5,
				verificationProviderTaskId: "different-task",
				deletedAt: new Date(),
			},
		});
		await client.videoExecution.update({ where: { jobId: f.job.id }, data: { stage: "FAILED" } });
		await expect(count(f.event.id)).resolves.toBe(0n);
	});

	it("hashes original UTF-8 including BOM without interpreting body status or task ID", async () => {
		const f = await fixture('\uFEFF{"status":"approved","taskId":"untrusted","text":"字"}');
		await expect(count(f.event.id)).resolves.toBe(0n);
	});

	it.each([
		["engine", { executionEngine: "legacy" }],
		["job", { jobId: "missing-job" }],
		["workflow", { workflowInstanceId: "video-v1-foreign" }],
		["asset", { assetId: "missing-asset" }],
		["generation", { generation: 2 }],
		["attempt", { attemptNumber: 2 }],
		["checksum", { checksum: "c".repeat(64) }],
		["etag", { etag: "different-etag" }],
		["hash", { eventHash: "c".repeat(64) }],
		["raw body", { rawBody: '{"tampered":true}' }],
		["profile contract", { visualSafetyContractVersion: "foreign-contract" }],
		["notified type", { notifiedAt: 123 }],
		["notified date", { notifiedAt: "2026-99-99T00:00:00.000Z" }],
	] satisfies Array<[string, Prisma.InputJsonObject]>)(
		"detects corrupted envelope %s",
		async (_name, fields) => {
			const f = await fixture();
			await changeEnvelope(f.event.id, (value) => ({ ...value, ...fields }));
			await expect(count(f.event.id)).resolves.toBe(1n);
		},
	);

	it("detects a missing notification marker", async () => {
		const f = await fixture();
		await changeEnvelope(f.event.id, ({ notifiedAt: _notifiedAt, ...value }) => value);
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
		"rejects invalid generation/attempt %s even with a matching event key",
		async (value) => {
			const f = await fixture();
			await changeEnvelope(f.event.id, (envelope) => ({
				...envelope,
				generation: value,
				attemptNumber: value,
			}));
			await client.providerWebhookEvent.update({
				where: { id: f.event.id },
				data: { providerEventId: `video-v1:${f.asset.id}:${value}:${value}` },
			});
			await expect(count(f.event.id)).resolves.toBe(1n);
		},
	);

	it("rejects a noncanonical event key", async () => {
		const f = await fixture();
		await client.providerWebhookEvent.update({
			where: { id: f.event.id },
			data: { providerEventId: `legacy:${f.asset.id}` },
		});
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it.each(["assetId", "checksum", "etag"] as const)(
		"detects corrupted durable output spec %s",
		async (field) => {
			const f = await fixture();
			await client.videoExecution.update({
				where: { jobId: f.job.id },
				data: { stageData: { outputSpec: { ...f.outputSpec, [field]: "foreign" } } },
			});
			await expect(count(f.event.id)).resolves.toBe(1n);
		},
	);

	it("detects a missing output binding", async () => {
		const f = await fixture();
		await client.generationJobAsset.delete({ where: { id: f.binding.id } });
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it("detects a mismatched output-binding checksum", async () => {
		const f = await fixture();
		await client.generationJobAsset.update({
			where: { id: f.binding.id },
			data: { assetChecksum: "c".repeat(64) },
		});
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it("detects a missing durable Workflow", async () => {
		const f = await fixture();
		await client.videoExecution.delete({ where: { jobId: f.job.id } });
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it("detects a mismatched asset owner", async () => {
		const f = await fixture();
		await client.mediaAsset.update({
			where: { id: f.asset.id },
			data: { ownerId: "foreign-owner" },
		});
		await expect(count(f.event.id)).resolves.toBe(1n);
	});

	it("limits regression checks to the requested event IDs and the SeeAPI namespace", async () => {
		const good = await fixture();
		const bad = await fixture();
		await changeEnvelope(bad.event.id, () => ({}));
		await expect(count(good.event.id)).resolves.toBe(0n);
		await expect(count(bad.event.id)).resolves.toBe(1n);
		await expect(countSeeapiVideoHandoffViolations(client, { eventIds: [] })).resolves.toBe(0n);
		await client.providerWebhookEvent.update({
			where: { id: bad.event.id },
			data: { provider: "kie-video-v1" },
		});
		await expect(count(bad.event.id)).resolves.toBe(0n);
	});
});
