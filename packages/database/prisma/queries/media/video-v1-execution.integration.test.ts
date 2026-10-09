import { PrismaPg } from "@prisma/adapter-pg";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithDatabaseClient } from "../../client";
import { type Prisma, PrismaClient } from "../../generated/client";
import { createCreditGrant, releaseCredits, reserveCredits } from "./credits";
import {
	claimVideoProviderSubmission,
	consumeVideoProviderEvents,
	failVideoExecution,
	getVideoExecutionContext,
	listPendingVideoWebhookEvents,
	markVideoSubmissionUncertain,
	markVideoWebhookNotified,
	persistVideoProviderWebhook,
	postponeVideoWebhookNotification,
	recordVideoInputReview,
	recordVideoProviderSuccess,
	recordVideoSubmissionAccepted,
} from "./video-v1-execution";

let client: PrismaClient;
const fixtureOwners: string[] = [];
const identityFixtureEvents: string[] = [];
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
		// Deliberately malformed identity fixtures cannot become valid evidence by
		// changing status. Remove only the exact rows created by this test process.
		await client.providerWebhookEvent.deleteMany({
			where: { id: { in: identityFixtureEvents } },
		});
		expect(
			await client.providerWebhookEvent.count({ where: { id: { in: identityFixtureEvents } } }),
		).toBe(0);
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

it("retires a notified callback that arrives after the final provider query without changing settlement", async () => {
	const f = await fixture();
	const claimed = await run(() => claimVideoProviderSubmission(f.claim));
	const taskId = `late-${f.job.id}`;
	await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
	const queriedAt = new Date(Date.now() - 1000);
	const event = await run(() =>
		persistVideoProviderWebhook({
			callbackTokenHash: f.claim.callbackTokenHash,
			taskId,
			timestamp: String(Date.now()),
			receivedAt: new Date(),
		}),
	);
	await run(() => markVideoWebhookNotified(event.eventId));
	await run(() =>
		recordVideoProviderSuccess({
			jobId: f.job.id,
			attemptId: claimed.attempt.id,
			providerTaskId: taskId,
			outputUrl: "https://example.com/test-video.mp4",
			providerCostMicros: null,
			providerCompletedAt: null,
		}),
	);
	await run(() => consumeVideoProviderEvents(f.job.id, claimed.attempt.id, queriedAt));
	await client.videoExecution.update({ where: { jobId: f.job.id }, data: { stage: "READY" } });
	const contextBefore = await run(() => getVideoExecutionContext(f.job.id));
	const ledgerBefore = await client.creditLedgerEntry.findMany({
		where: { accountId: f.reservation.accountId },
	});
	expect(
		await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }),
	).toMatchObject({ status: "RECEIVED", processedAt: null });
	const now = new Date();
	expect(
		(await run(() => listPendingVideoWebhookEvents(100, now))).map((row) => row.eventId),
	).not.toContain(event.eventId);
	expect(
		await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }),
	).toMatchObject({
		status: "IGNORED",
		processedAt: now,
		failureReason: "VIDEO_PROVIDER_RESULT_ALREADY_CONFIRMED",
	});
	await run(() => listPendingVideoWebhookEvents(100, new Date(now.getTime() + 1000)));
	expect(
		(await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }))
			.processedAt,
	).toEqual(now);
	expect(await run(() => getVideoExecutionContext(f.job.id))).toEqual(contextBefore);
	expect(
		await client.creditLedgerEntry.findMany({ where: { accountId: f.reservation.accountId } }),
	).toEqual(ledgerBefore);
	const afterReady = await run(() =>
		persistVideoProviderWebhook({
			callbackTokenHash: f.claim.callbackTokenHash,
			taskId,
			timestamp: "after-ready",
			receivedAt: new Date(),
		}),
	);
	await run(() => listPendingVideoWebhookEvents(100));
	expect(
		await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: afterReady.eventId } }),
	).toMatchObject({ status: "IGNORED" });
});

it("preserves notified active, uncertain and unconfirmed callbacks for reconciliation", async () => {
	for (const stage of ["GENERATING", "SUBMISSION_UNCERTAIN", "NEEDS_REVIEW", "FAILED"] as const) {
		const f = await fixture();
		const claimed = await run(() => claimVideoProviderSubmission(f.claim));
		const taskId = `unconfirmed-${f.job.id}`;
		await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
		const event = await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId,
				timestamp: stage,
				receivedAt: new Date(),
			}),
		);
		await run(() => markVideoWebhookNotified(event.eventId));
		await client.videoExecution.update({ where: { jobId: f.job.id }, data: { stage } });
		if (stage === "SUBMISSION_UNCERTAIN" || stage === "NEEDS_REVIEW")
			await client.generationAttempt.update({
				where: { id: claimed.attempt.id },
				data: { status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
			});
		const unnotified = await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId,
				timestamp: `${stage}-unnotified`,
				receivedAt: new Date(),
			}),
		);
		const pending = await run(() => listPendingVideoWebhookEvents(100));
		expect(pending.map((row) => row.eventId)).not.toContain(event.eventId);
		if (stage === "GENERATING" || stage === "SUBMISSION_UNCERTAIN")
			expect(pending.map((row) => row.eventId)).toContain(unnotified.eventId);
		else expect(pending.map((row) => row.eventId)).not.toContain(unnotified.eventId);
		for (const eventId of [event.eventId, unnotified.eventId])
			expect(
				await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: eventId } }),
			).toMatchObject({ status: "RECEIVED", processedAt: null });
		// Yield this fixture's active notification after proving it remains live.
		await run(() => markVideoWebhookNotified(unnotified.eventId));
	}
});

it("retirement and notification require the same video provider, engine, job, attempt and task", async () => {
	const f = await fixture();
	const claimed = await run(() => claimVideoProviderSubmission(f.claim));
	const taskId = `identity-${f.job.id}`;
	await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
	await run(() =>
		recordVideoProviderSuccess({
			jobId: f.job.id,
			attemptId: claimed.attempt.id,
			providerTaskId: taskId,
			outputUrl: "https://example.com/test-video.mp4",
			providerCostMicros: null,
			providerCompletedAt: null,
		}),
	);
	const variants = [
		{ provider: "video-unrelated-test", envelope: {} },
		{ provider: "kie-video-v1", envelope: { executionEngine: "legacy" } },
		{ provider: "kie-video-v1", envelope: { jobId: "another-job" } },
		{ provider: "kie-video-v1", envelope: { attemptId: "another-attempt" } },
		{ provider: "kie-video-v1", envelope: { taskId: "another-task" } },
		{ provider: "kie-video-v1", providerTaskId: "another-task", envelope: {} },
	];
	const events = [];
	for (const [index, variant] of variants.entries()) {
		const event = await client.providerWebhookEvent.create({
			data: {
				provider: variant.provider,
				providerEventId: `video-v1:identity:${f.job.id}:${index}`,
				providerTaskId: variant.providerTaskId ?? taskId,
				verifiedAt: new Date(),
				envelope: {
					executionEngine: "video-workflow-v1",
					jobId: f.job.id,
					attemptId: claimed.attempt.id,
					taskId,
					notifiedAt: null,
					...variant.envelope,
				},
			},
		});
		events.push(event);
		identityFixtureEvents.push(event.id);
	}
	for (const stage of ["STORING", "READY"] as const) {
		await client.videoExecution.update({ where: { jobId: f.job.id }, data: { stage } });
		const pending = await run(() => listPendingVideoWebhookEvents(100));
		for (const event of events) {
			expect(pending.map((row) => row.eventId)).not.toContain(event.id);
			expect(
				await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
			).toEqual(event);
		}
	}
});

it.each([
	{ status: "SUCCEEDED" as const, uncertainSubmission: false, authoritative: "true" },
	{ status: "SUCCEEDED" as const, uncertainSubmission: false, authoritative: false },
	{ status: "SUCCEEDED" as const, uncertainSubmission: true, authoritative: true },
	{ status: "SUBMITTED" as const, uncertainSubmission: false, authoritative: true },
])("does not retire a callback without confirmed attempt evidence %j", async (evidence) => {
	const f = await fixture();
	const claimed = await run(() => claimVideoProviderSubmission(f.claim));
	const taskId = `evidence-${f.job.id}`;
	await run(() => recordVideoSubmissionAccepted(f.job.id, claimed.attempt.id, taskId));
	const event = await run(() =>
		persistVideoProviderWebhook({
			callbackTokenHash: f.claim.callbackTokenHash,
			taskId,
			timestamp: "evidence",
			receivedAt: new Date(),
		}),
	);
	await run(() => markVideoWebhookNotified(event.eventId));
	await client.generationAttempt.update({
		where: { id: claimed.attempt.id },
		data: {
			status: evidence.status,
			uncertainSubmission: evidence.uncertainSubmission,
			responseSnapshot: { authoritative: evidence.authoritative },
		},
	});
	await client.videoExecution.update({ where: { jobId: f.job.id }, data: { stage: "READY" } });
	await run(() => listPendingVideoWebhookEvents(100));
	expect(
		await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }),
	).toMatchObject({ status: "RECEIVED", processedAt: null });
});

it("retires a bounded page of late terminal callbacks without starving a live notification", async () => {
	const ended = await fixture();
	const live = await fixture();
	const endedAttempt = await run(() => claimVideoProviderSubmission(ended.claim));
	const liveAttempt = await run(() => claimVideoProviderSubmission(live.claim));
	const endedTask = `ended-${ended.job.id}`;
	const liveTask = `live-${live.job.id}`;
	await run(() => recordVideoSubmissionAccepted(ended.job.id, endedAttempt.attempt.id, endedTask));
	await run(() => recordVideoSubmissionAccepted(live.job.id, liveAttempt.attempt.id, liveTask));
	await client.generationAttempt.update({
		where: { id: endedAttempt.attempt.id },
		data: {
			status: "FAILED",
			uncertainSubmission: false,
			completedAt: new Date(),
			responseSnapshot: { authoritative: true },
		},
	});
	await client.videoExecution.update({ where: { jobId: ended.job.id }, data: { stage: "FAILED" } });
	const now = Date.now();
	const prefix = crypto.randomUUID();
	await client.providerWebhookEvent.createMany({
		data: Array.from({ length: 27 }, (_, index) => ({
			provider: "kie-video-v1",
			providerEventId: `video-v1:starvation:${prefix}:${index}`,
			providerTaskId: index < 26 ? endedTask : liveTask,
			verifiedAt: new Date(now - 10_000),
			receivedAt: new Date(now - 10_000 + index),
			envelope: {
				executionEngine: "video-workflow-v1",
				jobId: index < 26 ? ended.job.id : live.job.id,
				attemptId: index < 26 ? endedAttempt.attempt.id : liveAttempt.attempt.id,
				taskId: index < 26 ? endedTask : liveTask,
				notifiedAt: index < 26 ? new Date(now).toISOString() : null,
			},
		})),
	});
	expect(await run(() => listPendingVideoWebhookEvents(25))).toEqual([
		expect.objectContaining({ jobId: live.job.id }),
	]);
	expect(
		await client.providerWebhookEvent.count({
			where: {
				provider: "kie-video-v1",
				envelope: { path: ["jobId"], equals: ended.job.id },
				status: "IGNORED",
			},
		}),
	).toBe(25);
	await run(() => listPendingVideoWebhookEvents(25));
	expect(
		await client.providerWebhookEvent.count({
			where: {
				provider: "kie-video-v1",
				envelope: { path: ["jobId"], equals: ended.job.id },
				status: "IGNORED",
			},
		}),
	).toBe(26);
});

it("yields failed notifications to later events until their retry cooldown expires", async () => {
	const live = await fixture();
	const claimed = await run(() => claimVideoProviderSubmission(live.claim));
	const prefix = crypto.randomUUID();
	await run(() => recordVideoSubmissionAccepted(live.job.id, claimed.attempt.id, `task-${prefix}`));
	const now = new Date();
	const events = await Promise.all(
		[0, 1].map((index) =>
			client.providerWebhookEvent.create({
				data: {
					provider: "kie-video-v1",
					providerEventId: `video-v1:cooldown:${prefix}:${index}`,
					providerTaskId: `task-${prefix}`,
					verifiedAt: now,
					receivedAt: new Date(now.getTime() + index),
					envelope: {
						executionEngine: "video-workflow-v1",
						jobId: live.job.id,
						attemptId: claimed.attempt.id,
						taskId: `task-${prefix}`,
						notifiedAt: null,
					},
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

async function fixture(
	options: {
		missingTextProfile?: boolean;
		pricingDetails?: (ownerId: string) => Prisma.InputJsonObject;
	} = {},
) {
	const suffix = crypto.randomUUID();
	const ownerId = `video-submission-test-${suffix}`;
	fixtureOwners.push(ownerId);
	const pricingSnapshot = {
		pricingDetails: options.pricingDetails?.(ownerId) ?? {
			validUntil: new Date(Date.now() + 3600_000).toISOString(),
		},
	};
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
			pricingSnapshot,
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
			pricingSnapshot,
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
	it("claims an explicitly non-expiring frozen price without releasing credits", async () => {
		const f = await fixture({
			pricingDetails: () => ({ priceApprovalExpiryMode: "none", validUntil: null }),
		});
		expect(await run(() => claimVideoProviderSubmission(f.claim))).toMatchObject({
			claimed: true,
			attempt: { status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
		});
		expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
			"ACTIVE",
		);
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: f.reservation.id, type: "RELEASE" },
			}),
		).toBe(0);
	});
	it.each([
		{ priceApprovalExpiryMode: "none" },
		{ priceApprovalExpiryMode: "none", validUntil: "2099-01-01T00:00:00.000Z" },
		{ priceApprovalExpiryMode: "until", validUntil: null },
		{ priceApprovalExpiryMode: "invalid", validUntil: "2099-01-01T00:00:00.000Z" },
		{ priceApprovalExpiryMode: null, validUntil: "2099-01-01T00:00:00.000Z" },
	])(
		"refuses a malformed frozen approval mode %j before creating a send fence",
		async (details) => {
			const f = await fixture({ pricingDetails: () => details });
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_PRICE_INVALID",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
			expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
				"ACTIVE",
			);
		},
	);
	it.each([undefined, null, 123, "invalid-date", "2026-02-31T00:00:00.000Z"])(
		"refuses a new paid submission with invalid frozen price deadline %s",
		async (validUntil) => {
			const f = await fixture({ pricingDetails: () => ({ validUntil }) });
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_PRICE_INVALID",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
			expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
				"ACTIVE",
			);
		},
	);
	it.each([undefined, "until"])(
		"refuses a new paid submission after its %s frozen price deadline",
		async (mode) => {
			const f = await fixture({
				pricingDetails: () => ({
					...(mode ? { priceApprovalExpiryMode: mode } : {}),
					validUntil: "2000-01-01T00:00:00.000Z",
				}),
			});
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_PRICE_EXPIRED",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
			expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
				"ACTIVE",
			);
		},
	);
	it("terminalizes an expired unsubmitted job and releases credits and capacity exactly once", async () => {
		const f = await fixture({
			pricingDetails: () => ({ validUntil: "2000-01-01T00:00:00.000Z" }),
		});
		await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
			"VIDEO_PRICE_EXPIRED",
		);
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				run(() =>
					failVideoExecution(f.job.id, "VIDEO_PRICE_EXPIRED", false, false, {
						onlyBeforeSubmission: true,
					}),
				),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		const failed = await run(() => getVideoExecutionContext(f.job.id));
		expect(failed?.status).toBe("FAILED");
		expect(failed?.failureCode).toBe("VIDEO_PRICE_EXPIRED");
		expect(failed?.videoExecution?.stage).toBe("FAILED");
		expect(failed?.attempts).toHaveLength(0);
		expect(failed?.reservation?.status).toBe("RELEASED");
		expect(
			await client.storageUsageReservation.findUnique({
				where: { referenceKey: `video-output:${f.job.id}` },
			}),
		).toMatchObject({ status: "RELEASED" });
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: f.reservation.id, type: "RELEASE" },
			}),
		).toBe(1);
	});
	it.each(["expired", "invalid", "other-owner", "unqualified-marker-missing"])(
		"refuses a new paid submission with %s frozen internal funding authorization",
		async (mode) => {
			const f = await fixture({
				pricingDetails: (ownerId) => ({
					validUntil: new Date(Date.now() + 3600_000).toISOString(),
					...(mode === "unqualified-marker-missing" ? {} : { paidRevenueQualified: false }),
					funding: {
						mode: "operator-funded-internal-v1",
						authorizedOwnerId: mode === "other-owner" ? "other-owner" : ownerId,
						validUntil:
							mode === "expired"
								? "2000-01-01T00:00:00.000Z"
								: mode === "invalid"
									? "invalid-date"
									: new Date(Date.now() + 3600_000).toISOString(),
						reason: "Isolated fixture only",
					},
				}),
			});
			await expect(run(() => claimVideoProviderSubmission(f.claim))).rejects.toThrow(
				"VIDEO_FUNDING_POLICY_CHANGED",
			);
			expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(0);
			expect((await run(() => getVideoExecutionContext(f.job.id)))?.reservation?.status).toBe(
				"ACTIVE",
			);
		},
	);
	it("allows the first paid claim with valid frozen internal funding and price deadlines", async () => {
		const f = await fixture({
			pricingDetails: (ownerId) => ({
				validUntil: new Date(Date.now() + 3600_000).toISOString(),
				paidRevenueQualified: false,
				funding: {
					mode: "operator-funded-internal-v1",
					authorizedOwnerId: ownerId,
					validUntil: new Date(Date.now() + 3600_000).toISOString(),
					reason: "Isolated fixture only",
				},
			}),
		});
		expect(await run(() => claimVideoProviderSubmission(f.claim))).toMatchObject({
			claimed: true,
			attempt: { status: "SUBMISSION_UNCERTAIN", uncertainSubmission: true },
		});
	});
	it.each(
		["expired-price", "missing-price", "expired-funding", "malformed-non-expiring-price"].flatMap(
			(deadline) => ["uncertain", "accepted"].map((state) => ({ deadline, state })),
		),
	)("preserves $state attempt recovery with $deadline", async ({ deadline, state }) => {
		const f = await fixture({
			pricingDetails: (ownerId) => ({
				...(deadline === "malformed-non-expiring-price" ? { priceApprovalExpiryMode: "none" } : {}),
				...(deadline === "missing-price"
					? {}
					: {
							validUntil:
								deadline === "expired-price"
									? "2000-01-01T00:00:00.000Z"
									: new Date(Date.now() + 3600_000).toISOString(),
						}),
				...(deadline === "expired-funding"
					? {
							paidRevenueQualified: false,
							funding: {
								mode: "operator-funded-internal-v1",
								authorizedOwnerId: ownerId,
								validUntil: "2000-01-01T00:00:00.000Z",
								reason: "Isolated fixture only",
							},
						}
					: {}),
			}),
		});
		// Model an already persisted send fence without rewriting its frozen snapshot.
		const attempt = await client.generationAttempt.create({
			data: {
				jobId: f.job.id,
				attemptNumber: 1,
				provider: "kie",
				providerModelId: f.claim.providerModelId,
				callbackTokenHash: f.claim.callbackTokenHash,
				requestSnapshot: f.job.inputSnapshot as Prisma.InputJsonValue,
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
				submittedAt: new Date("1999-12-31T23:59:00.000Z"),
			},
		});
		const taskId = `deadline-recovery-${f.job.id}`;
		if (state === "accepted")
			await run(() => recordVideoSubmissionAccepted(f.job.id, attempt.id, taskId));
		else {
			await run(() => markVideoSubmissionUncertain(f.job.id, "MOCK_SUBMISSION_UNKNOWN"));
			expect(await run(() => failVideoExecution(f.job.id, "VIDEO_PRICE_EXPIRED"))).toBe(false);
		}
		expect(await run(() => claimVideoProviderSubmission(f.claim))).toMatchObject({
			claimed: false,
			attempt: { id: attempt.id },
		});
		expect(
			await run(() =>
				failVideoExecution(f.job.id, "VIDEO_PRICE_EXPIRED", false, false, {
					onlyBeforeSubmission: true,
				}),
			),
		).toBe(false);
		await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId,
				timestamp: "1791072000",
				receivedAt: new Date(),
			}),
		);
		await run(() =>
			recordVideoProviderSuccess({
				jobId: f.job.id,
				attemptId: attempt.id,
				providerTaskId: taskId,
				outputUrl: "https://provider.example/recovered.mp4",
				providerCostMicros: null,
				providerCompletedAt: null,
			}),
		);
		const recovered = await run(() => getVideoExecutionContext(f.job.id));
		expect(recovered?.attempts).toHaveLength(1);
		expect(recovered?.attempts[0]).toMatchObject({ id: attempt.id, status: "SUCCEEDED" });
		expect(recovered?.videoExecution?.stage).toBe("STORING");
		expect(recovered?.reservation?.status).toBe("ACTIVE");
		expect(recovered?.pricingSnapshot).toEqual(f.job.pricingSnapshot);
		expect(
			await client.creditLedgerEntry.count({
				where: { reservationId: f.reservation.id, type: "RELEASE" },
			}),
		).toBe(0);
	});
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
		const persistedAt = event.callbackPersistedAt!;
		expect(Date.parse(persistedAt)).toBeGreaterThanOrEqual(input.receivedAt.getTime());
		expect(Date.parse(persistedAt)).toBeLessThanOrEqual(callbackReturnedAt);
		expect(firstTimings.providerCallbackPersistedAt).toBeUndefined();
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
		).toBeUndefined();
		expect(
			(await run(() => listPendingVideoWebhookEvents(100))).some(
				(row) => row.eventId === event.eventId,
			),
		).toBe(true);
		// A confirmation can commit between inbox persistence and notification.
		const confirmedAt = new Date().toISOString();
		await client.$executeRaw`UPDATE "video_execution"
			SET "stageData" = "stageData" || '{"concurrentBusinessField":true}'::jsonb ||
				jsonb_build_object('timings', "stageData"->'timings' ||
					jsonb_build_object('providerResultConfirmedAt', ${confirmedAt}::text))
			WHERE "jobId" = ${f.job.id}`;
		await run(() => markVideoWebhookNotified(event.eventId, persistedAt));
		await run(() => markVideoWebhookNotified(event.eventId, new Date().toISOString()));
		const notifiedExecution = await client.videoExecution.findUniqueOrThrow({
			where: { jobId: f.job.id },
		});
		expect(notifiedExecution.stageData).toMatchObject({
			concurrentBusinessField: true,
			timings: { providerCallbackPersistedAt: persistedAt, providerResultConfirmedAt: confirmedAt },
		});
		expect(await run(() => persistVideoProviderWebhook(input))).toMatchObject({ notified: true });
		await run(() => consumeVideoProviderEvents(f.job.id, claimed.attempt.id, new Date()));
		expect(
			(await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: event.eventId } }))
				.status,
		).toBe("PROCESSED");
		expect(await client.outboxEvent.count({ where: { aggregateId: event.eventId } })).toBe(0);
		expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(1);
	});
	it("does not invent a first commit observation after its original delivery was lost", async () => {
		const f = await fixture();
		await run(() => claimVideoProviderSubmission(f.claim));
		const input = {
			callbackTokenHash: f.claim.callbackTokenHash,
			taskId: `task-${f.job.id}`,
			timestamp: "1791072000",
			receivedAt: new Date(),
		};
		const original = await run(() => persistVideoProviderWebhook(input));
		expect(original.callbackPersistedAt).toBeDefined();
		const replay = await run(() => persistVideoProviderWebhook(input));
		expect(replay.callbackPersistedAt).toBeUndefined();
		await run(() => markVideoWebhookNotified(replay.eventId, replay.callbackPersistedAt));
		const later = await run(() =>
			persistVideoProviderWebhook({ ...input, timestamp: "1791072001" }),
		);
		expect(later.replayed).toBe(false);
		expect(later.callbackPersistedAt).toBeUndefined();
		await run(() => markVideoWebhookNotified(later.eventId, later.callbackPersistedAt));
		const execution = await client.videoExecution.findUniqueOrThrow({ where: { jobId: f.job.id } });
		expect(
			(execution.stageData as { timings: Record<string, string> }).timings
				.providerCallbackPersistedAt,
		).toBeUndefined();
		expect(await client.generationAttempt.count({ where: { jobId: f.job.id } })).toBe(1);
	});
	it("serializes notification timing with a business writer holding an older snapshot", async () => {
		const f = await fixture();
		await run(() => claimVideoProviderSubmission(f.claim));
		const event = await run(() =>
			persistVideoProviderWebhook({
				callbackTokenHash: f.claim.callbackTokenHash,
				taskId: `task-${f.job.id}`,
				timestamp: "1791072000",
				receivedAt: new Date(),
			}),
		);
		const applicationName = `c3-notify-${crypto.randomUUID()}`;
		const notifier = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: process.env.TEST_DATABASE_URL!,
				max: 1,
				application_name: applicationName,
			}),
		});
		let mark: Promise<void> | undefined;
		const confirmedAt = new Date().toISOString();
		try {
			await client.$transaction(
				async (tx) => {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`video-v1:${f.job.id}`}, 0))`;
					await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${f.job.id} FOR UPDATE`;
					const before = await tx.videoExecution.findUniqueOrThrow({ where: { jobId: f.job.id } });
					mark = runWithDatabaseClient(notifier, () =>
						markVideoWebhookNotified(event.eventId, event.callbackPersistedAt),
					);
					// Observe actual lock contention; no fixed sleep is used as evidence.
					let waiting = false;
					for (let tries = 0; tries < 200 && !waiting; tries++) {
						const rows = await client.$queryRaw<Array<{ waiting: boolean }>>`
						SELECT EXISTS(SELECT 1 FROM pg_stat_activity
							WHERE application_name = ${applicationName} AND wait_event = 'advisory') AS waiting`;
						waiting = rows[0]?.waiting ?? false;
					}
					expect(waiting).toBe(true);
					const data = before.stageData as Prisma.InputJsonObject;
					await tx.videoExecution.update({
						where: { jobId: f.job.id },
						data: {
							stageData: {
								...data,
								concurrentBusinessField: true,
								timings: {
									...(data.timings as Prisma.InputJsonObject),
									providerResultConfirmedAt: confirmedAt,
								},
							},
						},
					});
				},
				{ timeout: 15_000 },
			);
			await mark;
			const after = await client.videoExecution.findUniqueOrThrow({ where: { jobId: f.job.id } });
			expect(after.stageData).toMatchObject({
				concurrentBusinessField: true,
				timings: {
					providerCallbackPersistedAt: event.callbackPersistedAt,
					providerResultConfirmedAt: confirmedAt,
				},
			});
		} finally {
			await mark?.catch(() => undefined);
			await notifier.$disconnect();
		}
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
