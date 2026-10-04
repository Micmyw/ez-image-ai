import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { PrismaClient } from "../../generated/client";
import { createCreditGrant, releaseCredits, reserveCredits } from "./credits";
import {
	claimVideoProviderSubmission,
	consumeVideoProviderEvents,
	failVideoExecution,
	getVideoExecutionContext,
	listPendingVideoWebhookEvents,
	markVideoWebhookNotified,
	persistVideoProviderWebhook,
	postponeVideoWebhookNotification,
	recordVideoInputReview,
	recordVideoProviderSuccess,
	recordVideoSubmissionAccepted,
} from "./video-v1-execution";

let client: PrismaClient;
const fixtureOwners: string[] = [];
const ruleVersion = "video-test-rule";
beforeAll(() => {
	const raw = process.env.TEST_DATABASE_URL;
	if (!raw) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const url = new URL(raw);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.includes("test"))
		throw new Error("ISOLATED_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: raw, max: 8 }) });
});
afterAll(async () => {
	if (!client) return;
	try {
		// These owners were created in this process in the explicitly isolated test DB.
		// Preserve their immutable ledger while releasing mock-only reservations so
		// subsequent suites do not inherit provider/global capacity from our fixtures.
		const jobs = await client.generationJob.findMany({
			where: {
				ownerType: "USER",
				ownerId: { in: fixtureOwners },
				executionEngine: "video-workflow-v1",
			},
			include: { reservation: true },
		});
		for (const job of jobs) {
			if (job.reservation?.status === "ACTIVE")
				await releaseCredits(
					{
						reservationId: job.reservation.id,
						referenceKey: `test-video-execution-cleanup:${job.id}`,
					},
					client,
				);
			await client.$transaction([
				client.generationJob.update({
					where: { id: job.id },
					data: { status: "FAILED", terminalAt: new Date(), failureCode: "TEST_FIXTURE_CLEANUP" },
				}),
				client.videoExecution.update({
					where: { jobId: job.id },
					data: { stage: "FAILED", needsReviewReason: null },
				}),
				client.generationAttempt.updateMany({
					where: { jobId: job.id, status: { notIn: ["SUCCEEDED", "FAILED", "CANCELED"] } },
					data: { status: "FAILED", uncertainSubmission: false, completedAt: new Date() },
				}),
				client.providerWebhookEvent.updateMany({
					where: { provider: "kie-video-v1", envelope: { path: ["jobId"], equals: job.id } },
					data: { status: "PROCESSED", processedAt: new Date() },
				}),
			]);
		}
		expect(
			await client.creditReservation.count({
				where: { status: "ACTIVE", job: { ownerType: "USER", ownerId: { in: fixtureOwners } } },
			}),
		).toBe(0);
		expect(
			await client.videoExecution.count({
				where: {
					stage: { notIn: ["READY", "FAILED", "REJECTED"] },
					job: { ownerType: "USER", ownerId: { in: fixtureOwners } },
				},
			}),
		).toBe(0);
	} finally {
		await client.$disconnect();
	}
});
const run = <T>(callback: () => T) => runWithDatabaseClient(client, callback);

it("retires a full page of late terminal callbacks so a live notification is not starved", async () => {
	const ended = await fixture();
	const live = await fixture();
	await client.videoExecution.update({ where: { jobId: ended.job.id }, data: { stage: "FAILED" } });
	const now = Date.now();
	const prefix = crypto.randomUUID();
	await client.providerWebhookEvent.createMany({
		data: Array.from({ length: 26 }, (_, index) => ({
			provider: "kie-video-v1",
			providerEventId: `video-v1:starvation:${prefix}:${index}`,
			providerTaskId: `task-${prefix}`,
			verifiedAt: new Date(now - 10_000),
			receivedAt: new Date(now - 10_000 + index),
			envelope: { jobId: index < 25 ? ended.job.id : live.job.id, notifiedAt: null },
		})),
	});
	expect(await run(() => listPendingVideoWebhookEvents(25))).toEqual([]);
	expect(await run(() => listPendingVideoWebhookEvents(25))).toEqual([
		expect.objectContaining({ jobId: live.job.id }),
	]);
});

it("yields failed notifications to later events until their retry cooldown expires", async () => {
	const live = await fixture();
	const prefix = crypto.randomUUID();
	const now = new Date();
	const events = await Promise.all(
		[0, 1].map((index) =>
			client.providerWebhookEvent.create({
				data: {
					provider: "kie-video-v1",
					providerEventId: `video-v1:cooldown:${prefix}:${index}`,
					verifiedAt: now,
					receivedAt: new Date(now.getTime() + index),
					envelope: { jobId: live.job.id, notifiedAt: null },
				},
			}),
		),
	);
	await run(() => postponeVideoWebhookNotification(events[0]!.id, now));
	const pending = await run(() => listPendingVideoWebhookEvents(100, now));
	expect(pending.map((event) => event.eventId)).not.toContain(events[0]!.id);
	expect(pending.map((event) => event.eventId)).toContain(events[1]!.id);
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 120_001)))).map(
			(event) => event.eventId,
		),
	).toContain(events[0]!.id);
});

async function fixture(options: { missingTextProfile?: boolean } = {}) {
	const suffix = crypto.randomUUID();
	const ownerId = `video-submission-test-${suffix}`;
	fixtureOwners.push(ownerId);
	const inputSnapshot = {
		...(options.missingTextProfile ? {} : { textSafetyProfile: createVideoTextSafetyProfile() }),
		schemaVersion: 1,
		mode: "text-to-video",
		prompt: "Test balloon",
		duration: 5,
		sound: false,
		aspectRatio: "16:9",
		requestFingerprint: suffix,
		inputIdentity: null,
		modelContractVersion: "test-contract",
	};
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "video-kling-2-6-v1",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 5n,
			costMicros: 0n,
			inputSnapshot,
			pricingSnapshot: {},
			moderationDecision: "PENDING_VIDEO_WORKFLOW",
			moderationProvider: "video-workflow-v1",
			moderationReasonCode: "PENDING_VIDEO_WORKFLOW",
			inputFingerprint: "a".repeat(64),
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	const job = await client.generationJob.create({
		data: {
			id: `vexec-${suffix}`,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: suffix,
			productKey: "video-kling-2-6-v1",
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 5n,
			inputSnapshot,
			pricingSnapshot: {},
			executionEngine: "video-workflow-v1",
			videoExecution: {
				create: {
					workflowInstanceId: `video-v1-vexec-${suffix}`,
					modelContractVersion: "test-contract",
				},
			},
		},
	});
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await client.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId,
			referenceKey: `video-output:${job.id}`,
			bytes: 104857600n,
			expiresAt: new Date(0),
		},
	});
	await createCreditGrant(
		{ accountId: account.id, amount: 10n, referenceKey: `grant:${suffix}` },
		client,
	);
	const reservation = await reserveCredits(
		{ accountId: account.id, jobId: job.id, amount: 5n, referenceKey: `reserve:${suffix}` },
		client,
	);
	await run(() =>
		recordVideoInputReview(job.id, {
			status: "ALLOW",
			ruleVersion,
			textSafetyProfile: createVideoTextSafetyProfile(),
			textDecision: {
				decision: "ALLOW",
				reasonCode: "WAFFO_PROMPT_ALLOWED",
				ruleVersion: createVideoTextSafetyProfile().ruleVersion,
				evidence: {
					requestId: `waffo-${suffix}`,
					models: ["waffo-prompt-sift"],
					operations: 1,
					scores: {},
					waffo: {
						requestId: `waffo-${suffix}`,
						action: "allow",
						semanticStatus: "scored",
						matchedCategories: [],
					},
				},
			},
			requestFingerprint: suffix,
			validUntil: new Date(Date.now() + 60_000).toISOString(),
		}),
	);
	return {
		job,
		reservation,
		tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
		claim: {
			jobId: job.id,
			callbackTokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
			providerModelId: "kling-2.6/text-to-video",
			ruleVersion,
		},
	};
}

describe("video submission database correctness", () => {
	it.each(["missing", "insufficient", "released", "foreign-owner"])(
		"refuses a new paid submission with %s output capacity",
		async (mode) => {
			const f = await fixture();
			const where = { referenceKey: `video-output:${f.job.id}` };
			if (mode === "missing") await client.storageUsageReservation.delete({ where });
			else
				await client.storageUsageReservation.update({
					where,
					data:
						mode === "insufficient"
							? { bytes: 104857599n }
							: mode === "released"
								? { status: "RELEASED" }
								: { ownerId: "wrong-owner" },
				});
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_STORAGE_RESERVATION_REQUIRED",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
		},
	);
	it("retains output capacity and credits when provider acceptance is uncertain", async () => {
		const f = await fixture();
		await run(() => claimVideoProviderSubmission(f.claim));
		expect(await run(() => failVideoExecution(f.job.id, "TIMEOUT"))).toBe(false);
		expect(
			await client.storageUsageReservation.findUnique({
				where: { referenceKey: `video-output:${f.job.id}` },
			}),
		).toMatchObject({ status: "ACTIVE", bytes: 104857600n });
		expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
			"ACTIVE",
		);
	});
	it("releases output capacity for a definite pre-provider moderation rejection", async () => {
		const f = await fixture();
		expect(await run(() => failVideoExecution(f.job.id, "MODERATION_REJECTED", true))).toBe(true);
		expect(
			await client.storageUsageReservation.findUnique({
				where: { referenceKey: `video-output:${f.job.id}` },
			}),
		).toMatchObject({ status: "RELEASED" });
	});
	it("refuses new paid claims for historical inputs missing a frozen text profile", async () => {
		const f = await fixture({ missingTextProfile: true });
		await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
			"VIDEO_TEXT_SAFETY_PROFILE_INVALID",
		);
		expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
	});
	it.each([
		{ textSafetyProfile: null },
		{ textSafetyProfile: { ...createVideoTextSafetyProfile(), provider: "sightengine" } },
		{
			textDecision: { decision: "ALLOW", ruleVersion: createVideoTextSafetyProfile().ruleVersion },
		},
		{
			textDecision: { decision: "BYPASS", ruleVersion: createVideoTextSafetyProfile().ruleVersion },
		},
		{ validUntil: "invalid-date" },
	])(
		"independently rejects incomplete or mismatched prompt approval at the paid fence",
		async (patch) => {
			const f = await fixture();
			await run(() => recordVideoInputReview(f.job.id, patch));
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_INPUT_REVIEW_REQUIRED",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
		},
	);
	it("20 racing submit claimants obtain one immutable may-have-sent attempt", async () => {
		const f = await fixture();
		const claims = await Promise.all(
			Array.from({ length: 20 }, () => run(() => claimVideoProviderSubmission(f.claim))),
		);
		expect(claims.filter((result) => result.claimed)).toHaveLength(1);
		expect(new Set(claims.map((result) => result.attempt.id)).size).toBe(1);
		const job = await run(() => getVideoExecutionContext(f.job.id));
		expect(job?.attempts[0]).toMatchObject({
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
			providerTaskId: null,
		});
		expect(job?.reservation?.status).toBe("ACTIVE");
		expect(await client.outboxEvent.count({ where: { aggregateId: f.job.id } })).toBe(0);
	});
	it("early, repeat and late callbacks preserve one original task and never create an outbox", async () => {
		const f = await fixture();
		const claimed = await run(() => claimVideoProviderSubmission(f.claim));
		const input = {
			callbackTokenHash: f.claim.callbackTokenHash,
			taskId: `task-${crypto.randomUUID()}`,
			timestamp: "1791072000",
			receivedAt: new Date(),
		};
		const event = await run(() => persistVideoProviderWebhook(input));
		expect(event.replayed).toBe(false);
		const callbackReturnedAt = Date.now();
		const firstExecution = await client.videoExecution.findUniqueOrThrow({
			where: { jobId: f.job.id },
		});
		const firstTimings = (firstExecution.stageData as { timings: Record<string, string> }).timings;
		const persistedAt = firstTimings.providerCallbackPersistedAt!;
		expect(Date.parse(persistedAt)).toBeGreaterThanOrEqual(input.receivedAt.getTime());
		expect(Date.parse(persistedAt)).toBeLessThanOrEqual(callbackReturnedAt);
		expect((await run(() => getVideoExecutionContext(f.job.id)))?.attempts[0]?.providerTaskId).toBe(
			input.taskId,
		);
		await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, input.taskId));
		expect(await run(() => persistVideoProviderWebhook(input))).toMatchObject({
			eventId: event.eventId,
			replayed: true,
			notified: false,
		});
		const replayExecution = await client.videoExecution.findUniqueOrThrow({
			where: { jobId: f.job.id },
		});
		expect(
			(replayExecution.stageData as { timings: Record<string, string> }).timings
				.providerCallbackPersistedAt,
		).toBe(persistedAt);
		expect(
			(await run(() => listPendingVideoWebhookEvents(100))).some(
				(row) => row.eventId === event.eventId,
			),
		).toBe(true);
		await run(() => markVideoWebhookNotified(event.eventId));
		expect(await run(() => persistVideoProviderWebhook(input))).toMatchObject({ notified: true });
		await run(() => consumeVideoProviderEvents(f.job.id, claimed.attempt.id, new Date()));
		expect(
			(await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }))
				.status,
		).toBe("PROCESSED");
		expect(await client.outboxEvent.count({ where: { aggregateId: event.eventId } })).toBe(0);
	});
	it("signed callback correlation cannot bind another provider task to an existing attempt", async () => {
		const f = await fixture();
		const claimed = await run(() => claimVideoProviderSubmission(f.claim));
		await run(() =>
			recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, `first-${f.job.id}`),
		);
		await expect(
			run(() =>
				persistVideoProviderWebhook({
					callbackTokenHash: f.claim.callbackTokenHash,
					taskId: "wrong-task",
					timestamp: "1791072000",
					receivedAt: new Date(),
				}),
			),
		).rejects.toThrow("VIDEO_CALLBACK_TASK_INVALID");
	});
	it("definite failure releases one reservation once under racing terminalization", async () => {
		const f = await fixture();
		await run(() => claimVideoProviderSubmission(f.claim));
		await Promise.all(
			Array.from({ length: 5 }, () =>
				run(() => failVideoExecution(f.job.id, "PROVIDER_REJECTED", false, true)),
			),
		);
		const job = await run(() => getVideoExecutionContext(f.job.id));
		expect(
			await client.storageUsageReservation.findUnique({
				where: { referenceKey: `video-output:${f.job.id}` },
			}),
		).toMatchObject({ status: "RELEASED" });
		expect(job?.reservation?.status).toBe("RELEASED");
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: f.reservation.id, type: "RELEASE" },
			}),
		).toBe(1);
	});
	it("early accepted callback prevents the submit response failure path from refunding", async () => {
		const f = await fixture();
		await run(() => claimVideoProviderSubmission(f.claim));
		await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId: `early-${f.job.id}`,
				timestamp: "1791072000",
				receivedAt: new Date(),
			}),
		);
		expect(await run(() => failVideoExecution(f.job.id, "REJECTED_RESPONSE", false, true))).toBe(
			false,
		);
		expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
			"ACTIVE",
		);
	});
	it("authenticated success resists a late failure and preserves private transfer authority", async () => {
		const f = await fixture();
		const claimed = await run(() => claimVideoProviderSubmission(f.claim));
		const taskId = `success-${f.job.id}`;
		await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
		await run(() =>
			recordVideoProviderSuccess({
				jobId: f.job.id,
				attemptId: claimed.attempt.id,
				providerTaskId: taskId,
				outputUrl: "https://provider.example/authoritative.mp4",
				providerCostMicros: null,
				providerCreditsConsumed: 55,
				providerCompletedAt: null,
			}),
		);
		expect(await run(() => failVideoExecution(f.job.id, "LATE_FAILURE"))).toBe(false);
		const transfer = await client.generationAttemptTransferEnvelope.findUniqueOrThrow({
			where: { attemptId: claimed.attempt.id },
		});
		expect(transfer.payload).toMatchObject({
			schemaVersion: 1,
			authority: "authenticated-query",
			outputUrl: "https://provider.example/authoritative.mp4",
		});
		const job = await run(() => getVideoExecutionContext(f.job.id));
		expect(job?.videoExecution?.stage).toBe("STORING");
		expect(job?.reservation?.status).toBe("ACTIVE");
		expect(job?.attempts[0]?.responseSnapshot).toMatchObject({ providerCreditsConsumed: 55 });
		expect(job?.videoExecution?.providerCompletedAt).toBeNull();
	});
	it("a late first callback records the task but preserves an operator-review hold", async () => {
		const f = await fixture();
		const claimed = await run(() => claimVideoProviderSubmission(f.claim));
		await client.$transaction([
			client.videoExecution.update({
				where: { jobId: f.job.id },
				data: { stage: "NEEDS_REVIEW", needsReviewReason: "PROVIDER_DEADLINE_EXCEEDED" },
			}),
			client.generationJob.update({
				where: { id: f.job.id },
				data: { status: "NEEDS_RECONCILIATION" },
			}),
		]);
		const taskId = `late-${f.job.id}`;
		await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId,
				timestamp: "1791072000",
				receivedAt: new Date(),
			}),
		);
		await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
		expect(await run(() => failVideoExecution(f.job.id, "LATE_FAILURE"))).toBe(false);
		const job = await run(() => getVideoExecutionContext(f.job.id));
		expect(job?.videoExecution).toMatchObject({
			stage: "NEEDS_REVIEW",
			needsReviewReason: "PROVIDER_DEADLINE_EXCEEDED",
		});
		expect(job?.status).toBe("NEEDS_RECONCILIATION");
		expect(job?.reservation?.status).toBe("ACTIVE");
		expect(job?.attempts[0]?.providerTaskId).toBe(taskId);
		expect(job?.attempts).toHaveLength(1);
	});
});
