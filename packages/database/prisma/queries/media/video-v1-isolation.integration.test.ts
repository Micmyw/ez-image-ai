import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import {
	requeueAdminMediaVerification,
	retryAdminMediaJobStage,
	resolveAdminUncertainSubmission,
} from "./admin-operations";
import { createGenerationAttempt, bindProviderTask } from "./attempts";
import { transitionGenerationJob } from "./jobs";
import { wakeKieGenerationAttempt } from "./kie-callback";
import { ingestProviderEvent } from "./webhooks";

const prefix = `video-isolation-${randomUUID()}`;
let db: PrismaClient;
const jobs: string[] = [];
const quotes: string[] = [];
const assets: string[] = [];

async function fixture(engine: "legacy" | "video-workflow-v1" = "legacy") {
	const quote = await db.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId: prefix,
			submittedByUserId: prefix,
			productKey: "video-kling-2-6-v1",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 10n,
			costMicros: 0n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60000),
		},
	});
	quotes.push(quote.id);
	const job = await db.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId: prefix,
			submittedByUserId: prefix,
			quoteId: quote.id,
			idempotencyKey: randomUUID(),
			productKey: quote.productKey,
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 10n,
			inputSnapshot: {},
			pricingSnapshot: {},
			...(engine === "legacy" ? {} : { executionEngine: engine }),
		},
	});
	jobs.push(job.id);
	return job;
}

describe("video V1 database engine ownership", () => {
	beforeAll(() => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error("TEST_DATABASE_URL required");
		const parsed = new URL(url);
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
			!/(?:^|[_-])test(?:[_-]|$)/.test(parsed.pathname.slice(1))
		)
			throw new Error("Only explicit isolated local test database is allowed");
		db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
	});
	afterAll(async () => {
		if (!db) return;
		await db.generationJob.deleteMany({ where: { id: { in: jobs } } });
		await db.generationQuote.deleteMany({ where: { id: { in: quotes } } });
		await db.mediaAsset.deleteMany({ where: { id: { in: assets } } });
		await db.$disconnect();
	});
	it("preserves legacy defaults and prevents ownership changes", async () => {
		const job = await fixture();
		expect(job.executionEngine).toBe("legacy");
		await expect(
			db.generationJob.update({
				where: { id: job.id },
				data: { executionEngine: "video-workflow-v1" },
			}),
		).rejects.toThrow();
		const asset = await db.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: prefix,
				kind: "INPUT",
				objectKey: randomUUID(),
				mimeType: "image/png",
				byteSize: 1n,
			},
		});
		assets.push(asset.id);
		expect(asset.verificationEngine).toBe("legacy");
		await expect(
			db.mediaAsset.update({
				where: { id: asset.id },
				data: { verificationEngine: "video-workflow-v1" },
			}),
		).rejects.toThrow();
		const unchanged = await db.generationJob.findUniqueOrThrow({ where: { id: job.id } });
		expect(unchanged).toMatchObject({
			executionEngine: "legacy",
			status: "RESERVED",
			creditsReserved: 10n,
			version: 0,
		});
	});
	it("enforces one execution, stable instance and video-owned parent", async () => {
		const legacy = await fixture();
		await expect(
			db.videoExecution.create({
				data: {
					jobId: legacy.id,
					workflowInstanceId: `video-v1-${legacy.id}`,
					modelContractVersion: "test",
				},
			}),
		).rejects.toThrow();
		const video = await fixture("video-workflow-v1");
		await expect(
			db.videoExecution.create({
				data: { jobId: video.id, workflowInstanceId: "random", modelContractVersion: "test" },
			}),
		).rejects.toThrow();
		const execution = await db.videoExecution.create({
			data: {
				jobId: video.id,
				workflowInstanceId: `video-v1-${video.id}`,
				modelContractVersion: "test",
			},
		});
		expect(execution).toMatchObject({
			startState: "PENDING",
			stage: "QUEUED",
			workflowSchemaVersion: 1,
			stateVersion: 0,
		});
		await expect(
			db.videoExecution.create({
				data: {
					jobId: video.id,
					workflowInstanceId: execution.workflowInstanceId,
					modelContractVersion: "test",
				},
			}),
		).rejects.toThrow();
		await expect(
			db.videoExecution.update({
				where: { jobId: video.id },
				data: { workflowInstanceId: "replacement" },
			}),
		).rejects.toThrow();
		expect(
			await db.videoExecution.findFirst({
				where: { jobId: video.id, job: { ownerId: "another-owner", ownerType: "USER" } },
			}),
		).toBeNull();
	});
	it("legacy direct attempts, callbacks, transitions and admin retries cannot mutate video", async () => {
		const video = await fixture("video-workflow-v1");
		await expect(
			createGenerationAttempt(
				{
					jobId: video.id,
					attemptNumber: 1,
					provider: "kie",
					providerModelId: "test",
					requestSnapshot: {},
				},
				db,
			),
		).rejects.toThrow("EXECUTION_ENGINE_NOT_OWNED");
		const taskId = randomUUID();
		const attempt = await db.generationAttempt.create({
			data: {
				jobId: video.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: "test",
				providerTaskId: taskId,
				requestSnapshot: {},
			},
		});
		await expect(bindProviderTask(attempt.id, "other", db)).rejects.toThrow();
		expect(
			await wakeKieGenerationAttempt({ attemptId: attempt.id, providerTaskId: taskId }, db),
		).toBe("invalid");
		expect(
			(
				await transitionGenerationJob(
					{
						jobId: video.id,
						expectedStatuses: ["RESERVED"],
						expectedVersion: 0,
						nextStatus: "DISPATCH_QUEUED",
					},
					db,
				)
			).applied,
		).toBe(false);
		await expect(
			ingestProviderEvent(
				{
					provider: "kie",
					providerEventId: randomUUID(),
					providerTaskId: taskId,
					verifiedAt: new Date(),
					envelope: {},
				},
				db,
			),
		).rejects.toThrow("EXECUTION_ENGINE_NOT_OWNED");
		await expect(
			retryAdminMediaJobStage(
				{
					jobId: video.id,
					stage: "DISPATCH",
					actorUserId: prefix,
					idempotencyKey: randomUUID(),
					reason: "test",
				},
				db,
			),
		).rejects.toThrow("EXECUTION_ENGINE_NOT_OWNED");
		await expect(
			resolveAdminUncertainSubmission(
				{
					attemptId: attempt.id,
					resolution: "REJECTED",
					providerEvidenceReference: "test-only-no-provider-call",
					actorUserId: prefix,
					idempotencyKey: randomUUID(),
					reason: "test",
				},
				db,
			),
		).rejects.toThrow("EXECUTION_ENGINE_NOT_OWNED");
		const after = await db.generationJob.findUniqueOrThrow({
			where: { id: video.id },
			include: { attempts: true },
		});
		expect(after).toMatchObject({ status: "RESERVED", version: 0 });
		expect(after.attempts).toHaveLength(1);
		expect(after.attempts[0]).toMatchObject({
			providerTaskId: taskId,
			status: "CREATED",
			nextReconcileAt: null,
		});
		expect(await db.outboxEvent.count({ where: { aggregateId: video.id } })).toBe(0);
	});
	it("legacy moderation requeue cannot acquire video assets", async () => {
		const asset = await db.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: prefix,
				kind: "INPUT",
				objectKey: randomUUID(),
				mimeType: "image/png",
				byteSize: 1n,
				verificationEngine: "video-workflow-v1",
			},
		});
		assets.push(asset.id);
		await expect(
			requeueAdminMediaVerification(
				{
					assetId: asset.id,
					actorUserId: prefix,
					idempotencyKey: randomUUID(),
					reason: "test",
					currentVerification: { provider: "test", ruleVersion: "test", policyVersion: "test" },
				},
				db,
			),
		).rejects.toThrow("EXECUTION_ENGINE_NOT_OWNED");
		expect(
			(await db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).verificationGeneration,
		).toBe(0);
	});
	it("keeps execution metadata private through RLS and privilege revocation", async () => {
		const [table] = await db.$queryRaw<
			Array<{ enabled: boolean }>
		>`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='video_execution'::regclass`;
		expect(table?.enabled).toBe(true);
		const grants = await db.$queryRaw<
			Array<{ grantee: string }>
		>`SELECT grantee FROM information_schema.role_table_grants WHERE table_name='video_execution' AND grantee IN ('PUBLIC','anon','authenticated')`;
		expect(grants).toEqual([]);
	});
});
