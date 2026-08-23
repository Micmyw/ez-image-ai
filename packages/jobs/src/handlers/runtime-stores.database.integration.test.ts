import { PrismaPg } from "@prisma/adapter-pg";
import { FalProviderAdapter, GeminiProviderAdapter, ReplicateProviderAdapter } from "@repo/ai";
import {
	createCreditGrant,
	createGenerationJobTransaction,
	resolveAdminUncertainSubmission,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
	createDatabaseSettlementStore,
} from "../runtime";
import { dispatchGeneration } from "./dispatch-generation";
import { finalizeMedia } from "./finalize-media";
import { reconcileGenerations } from "./reconcile-generations";
import { settleGeneration } from "./settle-generation";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let client: PrismaClient;

describe("production media runtime stores", () => {
	beforeAll(() => {
		assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL! }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("queues a catalog-approved route after a retryable rejected submission", async () => {
		const seeded = await seedReservedJob("image-fast");
		const store = createDatabaseDispatchStore(client);
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		expect(claim).not.toBeNull();

		await store.recordRejectedSubmission(claim!.attemptId, {
			code: "PROVIDER_TEMPORARY",
			message: "temporary rejection",
			retryable: true,
		});

		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: { orderBy: { attemptNumber: "asc" } }, reservation: true },
		});
		expect(job.status).toBe("DISPATCH_QUEUED");
		expect(job.reservation?.status).toBe("ACTIVE");
		expect(job.attempts[0]).toMatchObject({
			status: "FAILED",
			provider: claim!.provider,
			attemptNumber: 1,
		});
		expect(job.attempts[1]).toMatchObject({ status: "CREATED", attemptNumber: 2 });
		expect(job.attempts[1]?.provider).not.toBe(claim!.provider);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_DISPATCH" },
			}),
		).toBe(1);
	});

	it("routes a real HTTP 429 adapter rejection through the handler and production store", async () => {
		const seeded = await seedReservedJobWithRoute("replicate");
		const outcome = await dispatchGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{
				store: createDatabaseDispatchStore(client),
				getProvider: () =>
					new ReplicateProviderAdapter({
						apiToken: "test",
						fetch: responseFetch(429, { detail: "rate limited" }),
					}),
			},
		);
		expect(outcome.outcome).toBe("REJECTED");
		const job = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: { orderBy: { attemptNumber: "asc" } } },
		});
		expect(job.status).toBe("DISPATCH_QUEUED");
		expect(job.attempts).toMatchObject([
			{ provider: "replicate", status: "FAILED" },
			{ provider: "fal", status: "CREATED" },
		]);
	});

	it("finalizes a non-retryable rejection and releases the entire reservation", async () => {
		const seeded = await seedReservedJob("image-fast");
		const dispatchStore = createDatabaseDispatchStore(client);
		const claim = await dispatchStore.claimDispatch({ jobId: seeded.jobId, version: 0 });

		await dispatchStore.recordRejectedSubmission(claim!.attemptId, {
			code: "PROVIDER_REJECTED",
			message: "terminal rejection",
			retryable: false,
		});

		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { reservation: true },
		});
		expect(finalizing.status).toBe("FINALIZING");
		expect(finalizing.reservation?.status).toBe("ACTIVE");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);

		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);

		const [job, reservation, account] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			client.creditAccount.findUniqueOrThrow({ where: { id: seeded.accountId } }),
		]);
		expect(job).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		expect(reservation.releasedAmount).toBe(reservation.amount);
		expect(account.reservedCredits).toBe(0n);
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: `settle:${seeded.jobId}`, type: "SETTLE", amount: 0n },
			}),
		).toBe(1);
	});

	it("routes a real HTTP 400 adapter rejection through zero-charge settlement", async () => {
		const seeded = await seedReservedJobWithRoute("fal");
		const outcome = await dispatchGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{
				store: createDatabaseDispatchStore(client),
				getProvider: () =>
					new FalProviderAdapter({
						apiKey: "test",
						fetch: responseFetch(400, { detail: "invalid request" }),
					}),
			},
		);
		expect(outcome.outcome).toBe("REJECTED");
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		expect(finalizing.status).toBe("FINALIZING");
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		const [job, reservation] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		]);
		expect(job).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
		expect(reservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: reservation.amount,
		});
	});

	it("freezes Gemini transport uncertainty for manual reconciliation without settling credits", async () => {
		const seeded = await seedReservedJob("image-quality");
		const outcome = await dispatchGeneration(
			{ jobId: seeded.jobId, version: 0 },
			{
				store: createDatabaseDispatchStore(client),
				getProvider: () =>
					new GeminiProviderAdapter({
						apiKey: "test",
						fetch: async () => {
							throw new DOMException("timed out", "AbortError");
						},
					}),
			},
		);
		expect(outcome.outcome).toBe("RECONCILE");
		const uncertain = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: true },
		});
		expect(uncertain.status).toBe("PROVIDER_PENDING");
		expect(uncertain.attempts).toMatchObject([
			{
				provider: "gemini",
				providerTaskId: null,
				status: "SUBMISSION_UNCERTAIN",
				uncertainSubmission: true,
			},
		]);
		expect(uncertain.attempts).toHaveLength(1);

		await client.generationAttempt.update({
			where: { id: uncertain.attempts[0]!.id },
			data: { reconciliationCount: 4, nextReconcileAt: new Date(0) },
		});
		await reconcileGenerations(
			{ limit: 100 },
			{
				store: createDatabaseReconciliationStore(client),
				getProvider: () =>
					new GeminiProviderAdapter({ apiKey: "unused", fetch: responseFetch(200, {}) }),
				now: () => new Date(),
			},
		);
		const needsReconciliation = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
			include: { attempts: true },
		});
		expect(needsReconciliation).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
		});
		expect(needsReconciliation.attempts[0]).toMatchObject({
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			nextReconcileAt: null,
		});
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
		).toMatchObject({
			status: "ACTIVE",
			settledAmount: 0n,
			releasedAmount: 0n,
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);
		expect(
			await client.auditLog.count({
				where: {
					targetId: needsReconciliation.attempts[0]!.id,
					action: "MEDIA_SUBMISSION_NEEDS_RECONCILIATION",
				},
			}),
		).toBe(1);
	});

	it("settles a provider-confirmed rejection at zero credits and preserves the decision", async () => {
		const seeded = await seedReservedJob("image-fast");
		const attempt = await client.generationAttempt.create({
			data: {
				jobId: seeded.jobId,
				attemptNumber: 1,
				provider: "replicate",
				providerModelId: "test-model",
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: true,
				requestSnapshot: {},
			},
		});
		await client.generationJob.update({
			where: { id: seeded.jobId },
			data: {
				status: "NEEDS_RECONCILIATION",
				failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
			},
		});
		await resolveAdminUncertainSubmission(
			{
				attemptId: attempt.id,
				resolution: "REJECTED",
				providerEvidenceReference: "provider-dashboard-rejection-123",
				actorUserId: "admin-reconciliation",
				idempotencyKey: `reject-${crypto.randomUUID()}`,
				reason: "Provider confirmed that no task was created",
			},
			client,
		);
		const finalizing = await client.generationJob.findUniqueOrThrow({
			where: { id: seeded.jobId },
		});
		await settleGeneration(
			{ jobId: seeded.jobId, version: finalizing.version },
			{ store: createDatabaseSettlementStore(client) },
		);

		const [job, reservation, account, ledgerCount] = await Promise.all([
			client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
			client.creditReservation.findUniqueOrThrow({ where: { id: seeded.reservationId } }),
			client.creditAccount.findUniqueOrThrow({ where: { id: seeded.accountId } }),
			client.creditLedgerEntry.count({
				where: { referenceKey: `settle:${seeded.jobId}`, type: "SETTLE", amount: 0n },
			}),
		]);
		expect(job).toMatchObject({
			status: "FAILED",
			failureCode: "SUBMISSION_REJECTED_CONFIRMED",
		});
		expect(reservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: seeded.credits,
		});
		expect(account.reservedCredits).toBe(0n);
		expect(ledgerCount).toBe(1);
	});

	it("persists typed Fal reconciliation endpoints without inventing provider task IDs", async () => {
		const seeded = await seedReservedJob("video-fast");
		const providerTaskId = `fal-real-task-${crypto.randomUUID()}`;
		const store = createDatabaseDispatchStore(client);
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });

		await store.recordSubmission(claim!.attemptId, {
			providerTaskId,
			status: "QUEUED",
			acceptance: "CERTAIN",
			idempotency: { key: claim!.attemptId, replayed: false },
			reconciliation: {
				statusUrl: `https://queue.test/${providerTaskId}/status`,
				resultUrl: `https://queue.test/${providerTaskId}/result`,
				submissionToken: claim!.attemptId,
			},
		});

		const attempt = await client.generationAttempt.findUniqueOrThrow({
			where: { id: claim!.attemptId },
		});
		expect(attempt).toMatchObject({
			providerTaskId,
			providerStatusUrl: `https://queue.test/${providerTaskId}/status`,
			providerResultUrl: `https://queue.test/${providerTaskId}/result`,
			submissionToken: claim!.attemptId,
		});
	});

	it("does not expose the Gemini finalization outbox before normalized outputs commit", async () => {
		const seeded = await seedReservedJob("image-quality");
		let releaseCommit!: () => void;
		let reachedBarrier!: () => void;
		const barrierReached = new Promise<void>((resolve) => {
			reachedBarrier = resolve;
		});
		const commitReleased = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const store = createDatabaseDispatchStore(client, {
			beforeSynchronousCommit: async () => {
				reachedBarrier();
				await commitReleased;
			},
		});
		const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
		const submission = {
			providerTaskId: claim!.attemptId,
			status: "SUCCEEDED" as const,
			acceptance: "CERTAIN" as const,
			idempotency: { key: claim!.attemptId, replayed: false },
			reconciliation: { submissionToken: claim!.attemptId },
		};
		const result = {
			outputs: [
				{
					kind: "inline-base64" as const,
					mimeType: "image/png",
					data: "aGVsbG8=",
					trust: "untrusted-transfer-candidate" as const,
				},
			],
			progress: 100,
			providerCostMicros: 8_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		};
		const completing = store.recordSynchronousCompletion(claim!.attemptId, submission, result);
		await barrierReached;
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		).toBe(0);
		releaseCommit();
		await completing;
		const [attempt, outboxCount] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: claim!.attemptId } }),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		]);
		expect(attempt.responseSnapshot).toMatchObject({ outputs: result.outputs });
		expect(outboxCount).toBe(1);
	});

	it("keeps finalization pending and queues retry when transfer fails transiently", async () => {
		const seeded = await seedFinalizingJob();
		const outcome = await finalizeMedia(
			{ jobId: seeded.jobId, version: seeded.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => {
					throw Object.assign(new Error("temporary storage timeout"), {
						code: "STORAGE_TRANSFER_RETRYABLE",
						stage: "TRANSFER",
						retryable: true,
					});
				},
			},
		);
		expect(outcome).toMatchObject({ outcome: "RETRY_SCHEDULED", readyOutputs: 0 });
		const [job] = await client.$queryRaw<
			Array<{
				status: string;
				finalizationStage: string | null;
				finalizationRetryCount: number;
				finalizationErrorCode: string | null;
				nextFinalizeAt: Date | null;
			}>
		>`SELECT "status", "finalizationStage", "finalizationRetryCount",
		          "finalizationErrorCode", "nextFinalizeAt"
		   FROM "generation_job" WHERE "id" = ${seeded.jobId}`;
		expect(job).toMatchObject({
			status: "FINALIZING",
			finalizationStage: "TRANSFER",
			finalizationRetryCount: 1,
			finalizationErrorCode: "STORAGE_TRANSFER_RETRYABLE",
		});
		expect(job?.nextFinalizeAt).toBeInstanceOf(Date);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE_RETRY" },
			}),
		).toBe(1);
	});

	it("does not settle a moderation ERROR and keeps REVIEW assets non-ready", async () => {
		const errorSeed = await seedFinalizingJob();
		const errorOutcome = await finalizeMedia(
			{ jobId: errorSeed.jobId, version: errorSeed.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => {
					throw {
						code: "MODERATION_RETRYABLE",
						stage: "MODERATION",
						retryable: true,
					};
				},
			},
		);
		expect(errorOutcome.outcome).toBe("RETRY_SCHEDULED");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: errorSeed.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(0);

		const reviewSeed = await seedFinalizingJob();
		const reviewAsset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `review-${crypto.randomUUID()}`,
				kind: "OUTPUT",
				status: "QUARANTINED",
				objectKey: `review/${crypto.randomUUID()}.png`,
				mimeType: "image/png",
				byteSize: 1n,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: reviewAsset.id,
				provider: "test",
				status: "REVIEW",
				categories: { reason: "manual" },
				rawEnvelope: { decision: "REVIEW" },
			},
		});
		const reviewOutcome = await finalizeMedia(
			{ jobId: reviewSeed.jobId, version: reviewSeed.version },
			{
				store: createDatabaseFinalizationStore(client),
				persistCandidate: async () => ({ assetId: reviewAsset.id, approved: false }),
			},
		);
		expect(reviewOutcome).toMatchObject({ outcome: "FINALIZED", readyOutputs: 0 });
		expect(
			await client.mediaAsset.findUniqueOrThrow({ where: { id: reviewAsset.id } }),
		).toMatchObject({ status: "QUARANTINED" });
	});

	it("claims one webhook worker and keeps the first terminal response canonical", async () => {
		const seeded = await seedPendingProviderJob();
		const store = createDatabaseProviderEventStore(client);
		const occurredAt = new Date("2026-08-13T12:00:00.000Z");
		const success = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			occurredAt,
			20n,
		);
		const [firstClaim, concurrentClaim] = await Promise.all([
			store.claimProviderEvent(success.id),
			store.claimProviderEvent(success.id),
		]);
		expect([firstClaim, concurrentClaim].filter(Boolean)).toHaveLength(1);
		const claimed = firstClaim ?? concurrentClaim!;
		await store.recordProviderProgress(claimed!, normalizedResult("canonical-output"));

		const laterFailure = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"failed",
			new Date("2026-08-13T12:05:00.000Z"),
			21n,
		);
		expect(await store.claimProviderEvent(laterFailure.id)).toBeNull();
		const staleSuccess = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			new Date("2026-08-13T11:00:00.000Z"),
			19n,
		);
		expect(await store.claimProviderEvent(staleSuccess.id)).toBeNull();

		const attempt = await client.generationAttempt.findUniqueOrThrow({
			where: { id: seeded.attemptId },
		});
		expect(attempt.status).toBe("SUCCEEDED");
		expect(attempt.responseSnapshot).toMatchObject({
			outputs: [
				expect.objectContaining({ url: "https://replicate.delivery/canonical-output.png" }),
			],
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
		).toBe(1);
	});

	it("persists provider cancellation as terminal and prevents later progress from reviving it", async () => {
		const seeded = await seedPendingProviderJob();
		const store = createDatabaseProviderEventStore(client);
		const canceled = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"cancelled",
			new Date("2026-08-13T12:00:00.000Z"),
			20n,
		);
		const canceledClaim = await store.claimProviderEvent(canceled.id);
		expect(canceledClaim).not.toBeNull();
		await store.recordProviderProgress(canceledClaim!, {
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		});

		const laterRunning = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"processing",
			new Date("2026-08-13T12:05:00.000Z"),
			21n,
		);
		expect(await store.claimProviderEvent(laterRunning.id)).toBeNull();

		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
		).toMatchObject({ status: "CANCELED" });
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).toMatchObject({ status: "FINALIZING" });
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);
	});

	it("serializes different provider events and ignores an older event after newer success", async () => {
		const seeded = await seedPendingProviderJob();
		let releaseNewer!: () => void;
		let newerLocked!: () => void;
		const newerHasLock = new Promise<void>((resolve) => {
			newerLocked = resolve;
		});
		const allowNewerCommit = new Promise<void>((resolve) => {
			releaseNewer = resolve;
		});
		const newer = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"succeeded",
			new Date("2026-08-13T13:00:00.000Z"),
			30n,
		);
		const older = await createProviderEvent(
			seeded.provider,
			seeded.providerTaskId,
			"failed",
			new Date("2026-08-13T12:00:00.000Z"),
			29n,
		);
		const store = createDatabaseProviderEventStore(client, {
			afterAttemptLock: async (claim) => {
				if (claim.eventId === newer.id) {
					newerLocked();
					await allowNewerCommit;
				}
			},
		});
		const [newerClaim, olderClaim] = await Promise.all([
			store.claimProviderEvent(newer.id),
			store.claimProviderEvent(older.id),
		]);
		expect(newerClaim).not.toBeNull();
		expect(olderClaim).not.toBeNull();

		const newerWrite = store.recordProviderProgress(newerClaim!, normalizedResult("newer-success"));
		await newerHasLock;
		const olderWrite = store.recordProviderProgress(olderClaim!, {
			outputs: [],
			progress: 100,
			providerCostMicros: null,
			failure: { code: "OLDER_FAILURE", message: "older", retryable: false },
			retryable: false,
			providerCharged: false,
		});
		releaseNewer();
		await Promise.all([newerWrite, olderWrite]);

		const [attempt, olderEvent, finalizeCount, settleCount] = await Promise.all([
			client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
			client.providerWebhookEvent.findUniqueOrThrow({ where: { id: older.id } }),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_FINALIZE" },
			}),
			client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		]);
		expect(attempt).toMatchObject({
			status: "SUCCEEDED",
			lastProviderSequence: 30n,
			responseSnapshot: {
				outputs: [expect.objectContaining({ url: "https://replicate.delivery/newer-success.png" })],
			},
		});
		expect(olderEvent).toMatchObject({
			status: "PROCESSED",
			failureReason: "STALE_EVENT_IGNORED",
		});
		expect(finalizeCount).toBe(1);
		expect(settleCount).toBe(0);
	});

	it("applies a terminal event when local arrival order is inverted and provider ordering is absent", async () => {
		const seeded = await seedPendingProviderJob();
		const completion = await client.providerWebhookEvent.create({
			data: {
				provider: seeded.provider,
				providerEventId: `completion-${crypto.randomUUID()}`,
				providerTaskId: seeded.providerTaskId,
				verifiedAt: new Date("2026-08-14T10:00:00.000Z"),
				receivedAt: new Date("2026-08-14T10:00:00.000Z"),
				envelope: { id: seeded.providerTaskId, status: "succeeded" },
			},
		});
		const running = await client.providerWebhookEvent.create({
			data: {
				provider: seeded.provider,
				providerEventId: `running-${crypto.randomUUID()}`,
				providerTaskId: seeded.providerTaskId,
				verifiedAt: new Date("2026-08-14T10:00:05.000Z"),
				receivedAt: new Date("2026-08-14T10:00:05.000Z"),
				envelope: { id: seeded.providerTaskId, status: "processing" },
			},
		});
		const store = createDatabaseProviderEventStore(client);
		const completionClaim = await store.claimProviderEvent(completion.id);
		const runningClaim = await store.claimProviderEvent(running.id);
		expect(completionClaim).not.toBeNull();
		expect(runningClaim).not.toBeNull();

		await store.recordProviderProgress(runningClaim!, {
			...normalizedResult("running"),
			outputs: [],
			progress: 40,
		});
		await store.recordProviderProgress(completionClaim!, normalizedResult("terminal-wins"));

		expect(
			await client.generationAttempt.findUniqueOrThrow({ where: { id: seeded.attemptId } }),
		).toMatchObject({
			status: "SUCCEEDED",
			responseSnapshot: {
				outputs: [expect.objectContaining({ url: expect.stringContaining("terminal-wins") })],
			},
		});
		expect(
			await client.providerWebhookEvent.findUniqueOrThrow({ where: { id: completion.id } }),
		).toMatchObject({ status: "PROCESSED", failureReason: null });
	});

	it("routes failed reconciliation through zero-charge settlement", async () => {
		const seeded = await seedPendingProviderJob();
		await client.generationAttempt.update({
			where: { id: seeded.attemptId },
			data: { nextReconcileAt: new Date(0) },
		});
		const store = createDatabaseReconciliationStore(client);
		const leases = await store.claimStale({ limit: 100, leaseSeconds: 60, now: new Date() });
		const lease = leases.find((candidate) => candidate.attemptId === seeded.attemptId);
		expect(lease).toBeDefined();
		await store.recordReconciled(
			lease!,
			{ providerTaskId: seeded.providerTaskId, status: "FAILED", raw: { error: "terminal" } },
			{
				outputs: [],
				progress: null,
				providerCostMicros: null,
				failure: { code: "PROVIDER_REJECTED", message: "terminal", retryable: false },
				retryable: false,
				providerCharged: false,
			},
		);
		const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
		expect(job.status).toBe("FINALIZING");
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: seeded.jobId, eventType: "GENERATION_SETTLE" },
			}),
		).toBe(1);
		await settleGeneration(
			{ jobId: seeded.jobId, version: job.version },
			{ store: createDatabaseSettlementStore(client) },
		);
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } }),
		).toMatchObject({ status: "FAILED", failureCode: "NO_USABLE_OUTPUT" });
	});
});

async function seedReservedJob(productKey: "image-fast" | "image-quality" | "video-fast") {
	const suffix = crypto.randomUUID();
	const ownerId = `task4-runtime-${suffix}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `task4-runtime-grant:${suffix}` },
		client,
	);
	const inputSnapshot = productKey.startsWith("video")
		? { kind: "text-to-video", prompt: "test" }
		: { kind: "text-to-image", prompt: "test" };
	const credits = productKey.startsWith("video") ? 25n : productKey === "image-quality" ? 10n : 4n;
	const quoteInput = {
		ownerType: "USER",
		ownerId,
		submittedByUserId: ownerId,
		productKey,
		catalogVersion: "2026-08-13.1",
		pricingVersion: "2026-08-13.1",
		credits,
		costMicros: 3_000n,
		inputSnapshot,
		pricingSnapshot: { credits: credits.toString() },
		expiresAt: new Date(Date.now() + 60_000),
	} as const;
	const { createModeratedGenerationQuoteTransaction, fingerprintGenerationQuoteSecurityPayload } =
		await import("@repo/database");
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
				reasonCode: "TEST_ALLOW_RUNTIME_STORES",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `task4-runtime:${suffix}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: "TEST_ALLOW_RUNTIME_STORES_V1",
		},
		client,
	);
	return {
		jobId: created.job.id,
		reservationId: created.reservation.id,
		accountId: account.id,
		credits,
	};
}

async function seedReservedJobWithRoute(provider: "replicate" | "fal") {
	const seeded = await seedReservedJob("image-fast");
	await client.generationAttempt.create({
		data: {
			jobId: seeded.jobId,
			attemptNumber: 1,
			provider,
			providerModelId:
				provider === "replicate" ? "black-forest-labs/flux-schnell" : "fal-ai/flux/schnell",
			requestSnapshot: { catalogRoute: provider },
		},
	});
	return seeded;
}

function responseFetch(status: number, body: unknown): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

async function seedFinalizingJob() {
	const seeded = await seedReservedJob("image-quality");
	const store = createDatabaseDispatchStore(client);
	const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
	await store.recordSynchronousCompletion(
		claim!.attemptId,
		{
			providerTaskId: claim!.attemptId,
			status: "SUCCEEDED",
			acceptance: "CERTAIN",
			idempotency: { key: claim!.attemptId, replayed: false },
			reconciliation: { submissionToken: claim!.attemptId },
		},
		{
			outputs: [
				{
					kind: "remote-url",
					url: "https://replicate.delivery/transient.png",
					trust: "untrusted-transfer-candidate",
				},
			],
			progress: 100,
			providerCostMicros: 8_000,
			failure: null,
			retryable: false,
			providerCharged: true,
		},
	);
	const job = await client.generationJob.findUniqueOrThrow({ where: { id: seeded.jobId } });
	return { jobId: job.id, version: job.version };
}

async function seedPendingProviderJob() {
	const seeded = await seedReservedJob("image-fast");
	const store = createDatabaseDispatchStore(client);
	const claim = await store.claimDispatch({ jobId: seeded.jobId, version: 0 });
	const providerTaskId = `provider-${crypto.randomUUID()}`;
	await store.recordSubmission(claim!.attemptId, {
		providerTaskId,
		status: "QUEUED",
		acceptance: "CERTAIN",
		idempotency: { key: claim!.attemptId, replayed: false },
		reconciliation: { submissionToken: claim!.attemptId },
	});
	return {
		jobId: seeded.jobId,
		attemptId: claim!.attemptId,
		provider: claim!.provider,
		providerTaskId,
	};
}

async function createProviderEvent(
	provider: "replicate" | "fal" | "kie" | "gemini",
	providerTaskId: string,
	status: "succeeded" | "failed" | "cancelled" | "processing",
	providerOccurredAt: Date,
	providerSequence: bigint,
) {
	return client.providerWebhookEvent.create({
		data: {
			provider,
			providerEventId: `provider-event-${crypto.randomUUID()}`,
			providerTaskId,
			verifiedAt: new Date(),
			providerOccurredAt,
			providerSequence,
			envelope: { id: providerTaskId, status },
		},
	});
}

function normalizedResult(outputKey: string) {
	return {
		outputs: [
			{
				kind: "remote-url" as const,
				url: `https://replicate.delivery/${outputKey}.png`,
				trust: "untrusted-transfer-candidate" as const,
			},
		],
		progress: 100,
		providerCostMicros: 3_000,
		failure: null,
		retryable: false,
		providerCharged: true,
	};
}

function assertSafeTestDatabaseUrl(value: string | undefined): void {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		parsed.pathname !== "/ai_media_foundation_test"
	) {
		throw new Error("TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test");
	}
}
