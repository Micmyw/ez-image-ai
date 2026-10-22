import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { VIDEO_V1_RULE_VERSION } from "@repo/config/video-v1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient } from "../../generated/client";
import {
	claimVideoImageReview,
	getVideoInputReviewContext,
	recordVideoInputReview,
} from "./video-v1-execution";
import {
	listPendingSeeapiVideoInputModerationEvents,
	markSeeapiVideoInputModerationWebhookNotified,
	persistSeeapiVideoInputModerationWebhook,
} from "./video-v1-input-seeapi-events";

describe("video input callback isolated PostgreSQL", () => {
	let db: PrismaClient;
	const jobs: string[] = [];
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString) throw new Error("BLOCKED: explicit TEST_DATABASE_URL required");
		const url = new URL(connectionString);
		if (
			!["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
			!/(^|[_-])test([_-]|$)/.test(url.pathname.slice(1))
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		db = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 12 }) });
	});
	afterAll(async () => {
		if (!db) return;
		await db.videoExecution.updateMany({
			where: { jobId: { in: jobs } },
			data: { stage: "FAILED" },
		});
		await db.generationJob.updateMany({
			where: { id: { in: jobs } },
			data: { status: "FAILED", terminalAt: new Date(), failureCode: "ISOLATED_TEST_CLEANUP" },
		});
		await db.$disconnect();
	});
	const scoped = <T>(fn: () => Promise<T>) => runWithDatabaseClient(db, fn);
	async function fixture() {
		const ownerId = `video-input-callback-${randomUUID()}`;
		const asset = await db.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				finalizedAt: new Date(),
				objectKey: `test/${ownerId}/input.png`,
				mimeType: "image/png",
				byteSize: 1024n,
				checksum: "a".repeat(64),
				storageEtag: "immutable-input",
				storageVersionId: "version-1",
				verificationGeneration: 1,
			},
		});
		const identity = {
			assetId: asset.id,
			checksum: asset.checksum!,
			objectKey: asset.objectKey,
			storageEtag: asset.storageEtag!,
			storageVersionId: asset.storageVersionId,
			verificationGeneration: asset.verificationGeneration,
		};
		const textSafetyProfile = createVideoTextSafetyProfile();
		const inputSnapshot = {
			mode: "image-to-video",
			prompt: "A red balloon",
			requestFingerprint: randomUUID(),
			textSafetyProfile,
			inputIdentity: identity,
		};
		const quote = await db.generationQuote.create({
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
		const job = await db.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: randomUUID(),
				productKey: "video-kling-2-6-v1",
				catalogVersion: "TEST",
				pricingVersion: "TEST",
				creditsReserved: 1n,
				inputSnapshot,
				pricingSnapshot: {},
				executionEngine: "video-workflow-v1",
				status: "RESERVED",
			},
		});
		jobs.push(job.id);
		await db.generationJobAsset.create({
			data: {
				jobId: job.id,
				assetId: asset.id,
				role: "INPUT",
				position: 0,
				assetChecksum: asset.checksum!,
			},
		});
		await db.videoExecution.create({
			data: {
				jobId: job.id,
				workflowInstanceId: `video-v1-${job.id}`,
				modelContractVersion: "TEST",
				stage: "QUEUED",
				stageData: {},
			},
		});
		const preparation = {
			ruleVersion: VIDEO_V1_RULE_VERSION,
			requestFingerprint: inputSnapshot.requestFingerprint,
			textSafetyProfile,
			callbackToken: randomUUID(),
		};
		return { job, asset, identity, preparation };
	}
	function callback(
		f: Awaited<ReturnType<typeof fixture>>,
		body = '{"taskId":"foreign-task","status":"approved"}',
	) {
		return {
			jobId: f.job.id,
			assetId: f.asset.id,
			submissionToken: f.preparation.callbackToken,
			rawBody: body,
			eventHash: createHash("sha256").update(body).digest("hex"),
			receivedAt: new Date(),
		};
	}
	it("commits frozen callback identity and a single send fence under concurrent preparation", async () => {
		const f = await fixture();
		const claims = await Promise.all(
			Array.from({ length: 8 }, () => scoped(() => claimVideoImageReview(f.job.id, f.preparation))),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const job = await scoped(() => getVideoInputReviewContext(f.job.id));
		expect(job!.videoExecution).toMatchObject({
			stage: "INPUT_REVIEW",
			inputReviewStartedAt: expect.any(Date),
			stageData: {
				inputReview: {
					ruleVersion: VIDEO_V1_RULE_VERSION,
					requestFingerprint: f.preparation.requestFingerprint,
					textSafetyProfile: f.preparation.textSafetyProfile,
					imageSubmissionUncertain: true,
					imageCallback: {
						token: f.preparation.callbackToken,
						...f.identity,
						requestFingerprint: f.preparation.requestFingerprint,
					},
				},
			},
		});
		expect(job).not.toHaveProperty("reservation");
	});
	it("stores early signed evidence once and wakes without resolving uncertain submission from its body", async () => {
		const f = await fixture();
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		const input = callback(f);
		const events = await Promise.all(
			Array.from({ length: 8 }, () =>
				scoped(() => persistSeeapiVideoInputModerationWebhook(input)),
			),
		);
		expect(new Set(events.map((event) => event.eventId)).size).toBe(1);
		expect(events.filter((event) => !event.replayed)).toHaveLength(1);
		expect(
			events.every(
				(event) => event.jobId === f.job.id && event.workflowInstanceId === `video-v1-${f.job.id}`,
			),
		).toBe(true);
		const stored = await db.providerWebhookEvent.findUniqueOrThrow({
			where: { id: events[0]!.eventId },
		});
		expect(stored.provider).toBe("seeapi-video-input-v1");
		expect(stored.providerTaskId).toBeNull();
		expect(stored.envelope).toMatchObject({ rawBody: input.rawBody, eventHash: input.eventHash });
		expect(
			(await scoped(() => getVideoInputReviewContext(f.job.id)))!.videoExecution!.stageData,
		).toMatchObject({ inputReview: { imageSubmissionUncertain: true } });
		expect(
			(await scoped(() => getVideoInputReviewContext(f.job.id)))!.videoExecution!.stageData,
		).not.toHaveProperty("inputReview.imageTaskId");
		await scoped(() =>
			recordVideoInputReview(f.job.id, {
				imageTaskId: "authenticated-task",
				imageSubmissionUncertain: false,
			}),
		);
		expect(
			await scoped(() => listPendingSeeapiVideoInputModerationEvents(20, f.job.id)),
		).toHaveLength(1);
		await scoped(() => markSeeapiVideoInputModerationWebhookNotified(stored.id));
		expect(await scoped(() => listPendingSeeapiVideoInputModerationEvents(20, f.job.id))).toEqual(
			[],
		);
		expect(
			await scoped(() =>
				persistSeeapiVideoInputModerationWebhook(callback(f, '{"duplicate":"different-body"}')),
			),
		).toMatchObject({ replayed: true, notified: true });
		expect(
			(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: stored.id } })).envelope,
		).toMatchObject({ rawBody: input.rawBody, eventHash: input.eventHash });
		expect(await db.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
		expect(await db.outboxEvent.count({ where: { aggregateId: f.job.id } })).toBe(0);
	});
	it("rejects callbacks without a send fence, and mismatched job, asset or submission token", async () => {
		const f = await fixture();
		await expect(
			scoped(() => persistSeeapiVideoInputModerationWebhook(callback(f))),
		).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		for (const patch of [
			{ jobId: "foreign-job" },
			{ assetId: "foreign-asset" },
			{ submissionToken: "other-persisted-submission-token" },
		]) {
			await expect(
				scoped(() => persistSeeapiVideoInputModerationWebhook({ ...callback(f), ...patch })),
			).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		}
	});
	it("ignores an inbox entry after immutable input changes without waking another review", async () => {
		const f = await fixture();
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		const event = await scoped(() => persistSeeapiVideoInputModerationWebhook(callback(f)));
		await db.mediaAsset.update({
			where: { id: f.asset.id },
			data: { storageVersionId: "replacement-version" },
		});
		await expect(
			scoped(() => persistSeeapiVideoInputModerationWebhook(callback(f))),
		).rejects.toThrow("VIDEO_INPUT_IDENTITY_CHANGED");
		expect(await scoped(() => listPendingSeeapiVideoInputModerationEvents(10, f.job.id))).toEqual(
			[],
		);
		expect(
			(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } })).status,
		).toBe("IGNORED");
	});
	it("does not wake a completed input review or a foreign execution engine", async () => {
		const f = await fixture();
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		await scoped(() =>
			recordVideoInputReview(f.job.id, {
				imageTaskId: "task",
				imageSubmissionUncertain: false,
				status: "ALLOW",
			}),
		);
		const event = await scoped(() => persistSeeapiVideoInputModerationWebhook(callback(f)));
		expect(event).toMatchObject({ notified: true });
		expect(event.jobId).toBeUndefined();
		expect(await scoped(() => listPendingSeeapiVideoInputModerationEvents(10, f.job.id))).toEqual(
			[],
		);
		await expect(
			db.generationJob.update({
				where: { id: f.job.id },
				data: { executionEngine: "legacy-outbox" },
			}),
		).rejects.toThrow("Generation execution engine is immutable");
	});
	it("keeps terminal image evidence when a stale PENDING query finishes after approval", async () => {
		const f = await fixture();
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		const imageDecision = {
			decision: "ALLOW",
			reasonCode: "SAFE",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		};
		await scoped(() =>
			recordVideoInputReview(f.job.id, {
				imageTaskId: "task",
				imageSubmissionUncertain: false,
				imageDecision,
				status: "ALLOW",
				validUntil: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		await scoped(() =>
			recordVideoInputReview(f.job.id, {
				imageDecision: {
					decision: "REVIEW",
					reasonCode: "IMAGE_PROCESSING",
					ruleVersion: VIDEO_V1_RULE_VERSION,
				},
			}),
		);
		expect(
			(await scoped(() => getVideoInputReviewContext(f.job.id)))!.videoExecution!.stageData,
		).toMatchObject({ inputReview: { status: "ALLOW", imageDecision } });
		await expect(
			scoped(() => recordVideoInputReview(f.job.id, { imageTaskId: "foreign-task" })),
		).rejects.toThrow("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
		await expect(
			scoped(() => recordVideoInputReview(f.job.id, { requestFingerprint: "foreign-fingerprint" })),
		).rejects.toThrow("VIDEO_INPUT_REVIEW_IDENTITY_CHANGED");
	});
	it("never changes a terminal image rejection to approval from a competing reader", async () => {
		const f = await fixture();
		await scoped(() => claimVideoImageReview(f.job.id, f.preparation));
		const imageDecision = {
			decision: "REJECT",
			reasonCode: "UNSAFE",
			ruleVersion: VIDEO_V1_RULE_VERSION,
		};
		await scoped(() => recordVideoInputReview(f.job.id, { imageDecision }));
		await scoped(() =>
			recordVideoInputReview(f.job.id, {
				imageDecision: { ...imageDecision, decision: "ALLOW" },
				status: "ALLOW",
				validUntil: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		expect(
			(await scoped(() => getVideoInputReviewContext(f.job.id)))!.videoExecution!.stageData,
		).toMatchObject({ inputReview: { status: "ERROR", imageDecision } });
	});
});
