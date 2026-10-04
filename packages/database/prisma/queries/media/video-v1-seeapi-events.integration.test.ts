import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient } from "../../generated/client";
import type { Prisma } from "../../generated/client";
import { recordVideoReviewTask } from "./video-v1-fulfillment";
import {
	claimSeeapiVideoConfirmation,
	listPendingSeeapiVideoModerationEvents,
	markSeeapiVideoModerationWebhookNotified,
	persistSeeapiVideoModerationWebhook,
	recordSeeapiVideoConfirmation,
} from "./video-v1-seeapi-events";

describe("SeeAPI callback-only confirmation isolated PostgreSQL", () => {
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
	async function fixture(
		options: {
			provider?: "sightengine" | "seeapi";
			submitted?: boolean;
			taskId?: string | null;
		} = {},
	) {
		const ownerId = `seeapi-callback-test-${randomUUID()}`;
		const profile = createVideoVisualSafetyProfile(options.provider ?? "seeapi", 5);
		const inputSnapshot = { duration: 5, visualSafetyProfile: profile };
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
				status: "FINALIZING",
			},
		});
		jobs.push(job.id);
		const token = randomUUID();
		const asset = await db.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "OUTPUT",
				status: "VERIFYING",
				verificationEngine: "video-workflow-v1",
				verificationProvider: profile.provider,
				verificationRuleVersion: profile.ruleVersion,
				verificationPolicyVersion: profile.policyVersion,
				verificationProviderTaskId:
					options.taskId === undefined ? `task_${randomUUID()}` : options.taskId,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationLeaseToken: token,
				...(options.submitted === false
					? {}
					: {
							verificationSubmittedAt: new Date(),
							verificationSubmissionToken: randomUUID(),
							verificationSubmissionUncertain: options.taskId === null,
						}),
				objectKey: `test/${ownerId}/sealed.mp4`,
				mimeType: "video/mp4",
				byteSize: 1000n,
				durationMillis: 5000n,
				checksum: "b".repeat(64),
				storageEtag: "sealed-etag",
				finalizedAt: new Date(),
			},
		});
		await db.generationJobAsset.create({
			data: {
				jobId: job.id,
				assetId: asset.id,
				role: "OUTPUT",
				position: 0,
				assetChecksum: asset.checksum!,
			},
		});
		await db.videoExecution.create({
			data: {
				jobId: job.id,
				workflowInstanceId: `video-v1-${job.id}`,
				modelContractVersion: "TEST",
				stage: "OUTPUT_REVIEW",
				stageData: {
					outputSpec: {
						assetId: asset.id,
						checksum: asset.checksum,
						etag: asset.storageEtag,
						audioTracks: 0,
					},
				},
			},
		});
		return { job, asset, profile, token };
	}
	function callback(assetId: string, body = '{"unknown":"raw-body-not-task-authority"}') {
		return {
			assetId,
			generation: 1,
			attemptNumber: 1,
			rawBody: body,
			eventHash: createHash("sha256").update(body).digest("hex"),
			receivedAt: new Date(),
			deliveryMetadata: { deliveryId: randomUUID() },
		};
	}
	async function expireReadWait(jobId: string) {
		const row = await db.videoExecution.findUniqueOrThrow({ where: { jobId } });
		const stageData = row.stageData as Prisma.InputJsonObject;
		await db.videoExecution.update({
			where: { jobId },
			data: {
				stageData: {
					...stageData,
					seeapiVisualReview: {
						...(stageData.seeapiVisualReview as Prisma.InputJsonObject),
						nextRetryAt: new Date(Date.now() - 1000).toISOString(),
					},
				},
			},
		});
	}
	it("stores concurrent early callback exactly once, preserves original raw bytes, and wakes only after task persistence", async () => {
		const f = await fixture({ taskId: null });
		const input = callback(f.asset.id);
		const events = await Promise.all(
			Array.from({ length: 12 }, () => scoped(() => persistSeeapiVideoModerationWebhook(input))),
		);
		expect(new Set(events.map((event) => event.eventId)).size).toBe(1);
		expect(events.filter((event) => !event.replayed)).toHaveLength(1);
		expect(events.every((event) => !event.jobId)).toBe(true);
		expect((await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).status).toBe("WAITING");
		expect(await scoped(() => listPendingSeeapiVideoModerationEvents(20, f.job.id))).toEqual([]);
		await scoped(() => recordVideoReviewTask(f.asset.id, f.token, "task_authoritative"));
		const pending = await scoped(() => listPendingSeeapiVideoModerationEvents(20, f.job.id));
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			jobId: f.job.id,
			workflowInstanceId: `video-v1-${f.job.id}`,
		});
		await scoped(() => markSeeapiVideoModerationWebhookNotified(pending[0]!.eventId));
		const replay = await scoped(() =>
			persistSeeapiVideoModerationWebhook(
				callback(f.asset.id, '{"different":"duplicate-delivery"}'),
			),
		);
		expect(replay).toMatchObject({ replayed: true, notified: true });
		const row = await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: replay.eventId } });
		expect(row.envelope).toMatchObject({
			rawBody: input.rawBody,
			eventHash: input.eventHash,
			deliveryMetadata: input.deliveryMetadata,
		});
		expect(await db.outboxEvent.count({ where: { aggregateId: f.job.id } })).toBe(0);
	});
	it("claims one confirmation across concurrent consumers and reuses the persisted visual decision", async () => {
		const f = await fixture();
		await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		const claims = await Promise.all(
			Array.from({ length: 12 }, () => scoped(() => claimSeeapiVideoConfirmation(f.job.id))),
		);
		expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(1);
		const claim = claims.find((value) => value.status === "CLAIMED")!;
		if (claim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		const decision = {
			decision: "ALLOW",
			reasonCode: "NO_POLICY_MATCH",
			ruleVersion: f.profile.ruleVersion,
			evidence: { requestId: f.asset.verificationProviderTaskId },
		};
		await scoped(() =>
			recordSeeapiVideoConfirmation({
				jobId: f.job.id,
				eventId: claim.eventId,
				token: claim.token,
				decision,
			}),
		);
		expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
			status: "CONSUMED",
			decision,
		});
		expect(
			(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: claim.eventId } })).status,
		).toBe("PROCESSED");
	});
	it("crashes consume the durable read budget and duplicate callbacks cannot create a fourth GET", async () => {
		const f = await fixture();
		const event = await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		for (let readAttemptCount = 1; readAttemptCount <= 3; readAttemptCount++) {
			expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
				status: "CLAIMED",
				readAttemptCount,
			});
			await scoped(() =>
				persistSeeapiVideoModerationWebhook(callback(f.asset.id, '{"late":"retry"}')),
			);
			expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
				status: "RETRY",
				readAttemptCount,
			});
			await expireReadWait(f.job.id);
		}
		expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
			status: "CONSUMED",
			eventId: event.eventId,
			decision: { decision: "ERROR", reasonCode: "VIDEO_SEEAPI_CONFIRMATION_UNCERTAIN" },
		});
	});
	it("persists 1s then 3s transient backoff and caches the third failure forever", async () => {
		const f = await fixture();
		await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		const decision = {
			decision: "ERROR",
			reasonCode: "MODERATION_SERVICE_ERROR",
			ruleVersion: f.profile.ruleVersion,
		};
		for (let readAttemptCount = 1; readAttemptCount <= 3; readAttemptCount++) {
			const claim = await scoped(() => claimSeeapiVideoConfirmation(f.job.id));
			if (claim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
			expect(claim.readAttemptCount).toBe(readAttemptCount);
			const before = Date.now();
			const recorded = await scoped(() =>
				recordSeeapiVideoConfirmation({
					jobId: f.job.id,
					eventId: claim.eventId,
					token: claim.token,
					decision,
				}),
			);
			if (readAttemptCount < 3) {
				if (recorded.status !== "RETRY") throw new Error("RETRY_REQUIRED");
				expect(new Date(recorded.nextRetryAt).getTime() - before).toBeGreaterThanOrEqual(
					readAttemptCount === 1 ? 1000 : 3000,
				);
				await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
				expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
					status: "RETRY",
					readAttemptCount,
				});
				await expireReadWait(f.job.id);
			} else expect(recorded).toEqual({ status: "COMPLETE" });
		}
		expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
			status: "CONSUMED",
			decision,
		});
	});
	it("a stale read token cannot overwrite a later claim or its completed result", async () => {
		const f = await fixture();
		await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		const first = await scoped(() => claimSeeapiVideoConfirmation(f.job.id));
		if (first.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		await expireReadWait(f.job.id);
		const second = await scoped(() => claimSeeapiVideoConfirmation(f.job.id));
		if (second.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		const decision = {
			decision: "REJECT",
			reasonCode: "SEEAPI_CONTENT_NOT_ALLOWED",
			ruleVersion: f.profile.ruleVersion,
		};
		await expect(
			scoped(() =>
				recordSeeapiVideoConfirmation({
					jobId: f.job.id,
					eventId: first.eventId,
					token: first.token,
					decision,
				}),
			),
		).rejects.toThrow("VIDEO_SEEAPI_CONFIRMATION_IDENTITY_CHANGED");
		await scoped(() =>
			recordSeeapiVideoConfirmation({
				jobId: f.job.id,
				eventId: second.eventId,
				token: second.token,
				decision,
			}),
		);
		expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
			status: "CONSUMED",
			decision,
		});
	});
	it("retires a callback whose immutable asset was deleted without poisoning subsequent inbox reads", async () => {
		const f = await fixture();
		const event = await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		await db.mediaAsset.update({ where: { id: f.asset.id }, data: { deletedAt: new Date() } });
		expect(await scoped(() => listPendingSeeapiVideoModerationEvents(10, f.job.id))).toEqual([]);
		expect(
			(await db.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } })).status,
		).toBe("IGNORED");
		const live = await fixture();
		await scoped(() => persistSeeapiVideoModerationWebhook(callback(live.asset.id)));
		expect(
			await scoped(() => listPendingSeeapiVideoModerationEvents(10, live.job.id)),
		).toHaveLength(1);
	});
	it.each([
		"VIDEO_PROCESSING",
		"MODERATION_INVALID_RESPONSE",
		"MODERATION_UNAVAILABLE",
		"MODERATION_CONFIGURATION_ERROR",
	])("never retries a real report or permanent error: %s", async (reasonCode) => {
		const f = await fixture();
		await scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id)));
		const claim = await scoped(() => claimSeeapiVideoConfirmation(f.job.id));
		if (claim.status !== "CLAIMED") throw new Error("CLAIM_REQUIRED");
		const decision = {
			decision: reasonCode === "VIDEO_PROCESSING" ? "REVIEW" : "ERROR",
			reasonCode,
			ruleVersion: f.profile.ruleVersion,
		};
		expect(
			await scoped(() =>
				recordSeeapiVideoConfirmation({
					jobId: f.job.id,
					eventId: claim.eventId,
					token: claim.token,
					decision,
				}),
			),
		).toEqual({ status: "COMPLETE" });
		expect(await scoped(() => claimSeeapiVideoConfirmation(f.job.id))).toMatchObject({
			status: "CONSUMED",
			decision,
		});
	});
	it("rejects mismatched profile, missing send fence, invalid generation and changed immutable content", async () => {
		const legacy = await fixture({ provider: "sightengine" });
		await expect(
			scoped(() => persistSeeapiVideoModerationWebhook(callback(legacy.asset.id))),
		).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		const unsent = await fixture({ submitted: false });
		await expect(
			scoped(() => persistSeeapiVideoModerationWebhook(callback(unsent.asset.id))),
		).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		const f = await fixture();
		await expect(
			scoped(() => persistSeeapiVideoModerationWebhook({ ...callback(f.asset.id), generation: 2 })),
		).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
		await db.mediaAsset.update({ where: { id: f.asset.id }, data: { checksum: "c".repeat(64) } });
		await expect(
			scoped(() => persistSeeapiVideoModerationWebhook(callback(f.asset.id))),
		).rejects.toThrow("VIDEO_SEEAPI_CALLBACK_IDENTITY_INVALID");
	});
});
