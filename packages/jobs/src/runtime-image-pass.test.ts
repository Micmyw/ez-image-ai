import { beforeEach, describe, expect, it, vi } from "vitest";

import { createOutputTransferEnvelope } from "./output-transfer-envelope";

const funding = vi.hoisted(() => ({
	lookup: vi.fn(),
	finalize: vi.fn(),
	creditSettle: vi.fn(),
	grace: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getGenerationFundingReservation: funding.lookup,
	finalizeImagePassReservationInTransaction: funding.finalize,
	settleCreditsInTransaction: funding.creditSettle,
	claimOutputModerationGraceInTransaction: funding.grace,
	runSerializable: async (
		database: { $transaction: (operation: unknown) => unknown },
		operation: unknown,
	) => database.$transaction(operation),
	hasCurrentApprovedMediaAssetEvidence: (asset: { approved?: boolean }) => asset.approved === true,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { createDatabaseFinalizingGenerationRecoveryStore } from "./handlers/finalization-recovery-store";
import {
	createDatabaseFinalizationStore,
	createDatabaseProviderCancellationStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
	createDatabaseSettlementStore,
} from "./runtime";

const reservation = {
	id: "pass-reservation",
	amount: 1n,
	status: "ACTIVE",
	fundingSource: "IMAGE_PASS",
};
const payload = { jobId: "job", version: 1 };

beforeEach(() => {
	vi.clearAllMocks();
	funding.lookup.mockResolvedValue(reservation);
	funding.finalize.mockResolvedValue({ status: "SETTLED", replayed: false });
});

function fixture(output: "ready" | "blocked" | "pending" | "none" = "ready") {
	const asset = {
		id: "output",
		kind: "OUTPUT",
		mimeType: "image/png",
		status: output === "ready" ? "READY" : output === "pending" ? "VERIFYING" : "QUARANTINED",
		checksum: "checksum",
		deletedAt: null,
		approved: output === "ready",
		moderationResults: [],
	};
	const job = {
		id: "job",
		ownerId: "owner",
		status: "FINALIZING",
		fundingSource: "IMAGE_PASS",
		creditsReserved: 0n,
		failureCode: null,
		serviceClass: "STANDARD",
		reservation: null,
		pricingSnapshot: {},
		assets: output === "none" ? [] : [{ assetId: "output", assetChecksum: "checksum", asset }],
		attempts: [{ providerCostMicros: 20_000n }],
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		generationJob: {
			findFirst: vi.fn(async () => job),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
	};
	const database = {
		...tx,
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	return { job, tx, database, store: createDatabaseSettlementStore(database as never) };
}

function passClaim() {
	return {
		jobId: "job",
		reservationId: reservation.id,
		fundingSource: "IMAGE_PASS" as const,
		reservedCredits: 0n,
		chargeCredits: 0n,
		readyOutputCount: 1,
		providerCostMicros: 20_000n,
	};
}

describe("image pass job consumers", () => {
	it("claims an independent pass reservation with zero ordinary credits", async () => {
		const f = fixture();
		await expect(f.store.claimSettlement(payload)).resolves.toMatchObject(passClaim());
		expect(funding.lookup).toHaveBeenCalledWith("job", f.database, null);
	});

	it("consumes one usable approved output using the pass finalizer without a credit charge or grace claim", async () => {
		const f = fixture();
		await f.store.settle(passClaim());
		expect(funding.finalize).toHaveBeenCalledWith(
			{ jobId: "job", ownerId: "owner", hasUsableOutput: true },
			f.tx,
		);
		expect(funding.creditSettle).not.toHaveBeenCalled();
		expect(funding.grace).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "SUCCEEDED" }) }),
		);
	});

	it.each(["blocked", "none"] as const)(
		"releases a confirmed %s outcome without ordinary moderation billing",
		async (output) => {
			const f = fixture(output);
			await f.store.settle(passClaim());
			expect(funding.finalize).toHaveBeenCalledWith(
				{ jobId: "job", ownerId: "owner", hasUsableOutput: false },
				f.tx,
			);
			expect(funding.creditSettle).not.toHaveBeenCalled();
		},
	);

	it("retains the held unit until output moderation finishes", async () => {
		const f = fixture("pending");
		await expect(f.store.claimSettlement(payload)).resolves.toBeNull();
		await f.store.settle(passClaim());
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it("rechecks moderation after the settlement claim and retains the unit if approval changed", async () => {
		const f = fixture();
		const claim = await f.store.claimSettlement(payload);
		expect(claim).not.toBeNull();
		f.job.assets[0]!.asset.status = "VERIFYING";
		await f.store.settle(claim!);
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it("releases confirmed cancellation but does not swallow an uncertain outcome refusal", async () => {
		const f = fixture("none");
		f.job.status = "CANCELED";
		await f.store.settle(passClaim());
		expect(funding.finalize).toHaveBeenCalledWith(
			expect.objectContaining({ hasUsableOutput: false }),
			f.tx,
		);
		funding.finalize.mockRejectedValueOnce(new Error("IMAGE_PASS_OUTCOME_UNCERTAIN"));
		await expect(f.store.settle(passClaim())).rejects.toThrow("IMAGE_PASS_OUTCOME_UNCERTAIN");
		expect(funding.creditSettle).not.toHaveBeenCalled();
	});

	it("holds unexpected multiple persisted usable outputs for reconciliation", async () => {
		const f = fixture();
		f.job.assets.push({ ...f.job.assets[0]!, assetId: "extra" });
		await expect(f.store.claimSettlement(payload)).rejects.toThrow(
			"IMAGE_PASS_OUTPUT_CARDINALITY_INVALID",
		);
		await expect(f.store.settle(passClaim())).rejects.toThrow(
			"IMAGE_PASS_OUTPUT_CARDINALITY_INVALID",
		);
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it("replays a settled pass without touching either ledger", async () => {
		const f = fixture();
		funding.lookup.mockResolvedValue({ ...reservation, status: "SETTLED" });
		await expect(f.store.claimSettlement(payload)).resolves.toBeNull();
		await f.store.settle(passClaim());
		expect(funding.finalize).not.toHaveBeenCalled();
		expect(funding.creditSettle).not.toHaveBeenCalled();
	});

	it("rejects a reservation from the other funding source without falling back", async () => {
		const f = fixture();
		funding.lookup.mockResolvedValue({
			id: "credit",
			amount: 5n,
			status: "ACTIVE",
			fundingSource: "CREDITS",
		});
		await expect(f.store.claimSettlement(payload)).rejects.toThrow("GENERATION_FUNDING_CONFLICT");
		await expect(f.store.settle(passClaim())).rejects.toThrow("GENERATION_FUNDING_CONFLICT");
		expect(funding.creditSettle).not.toHaveBeenCalled();
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it("keeps existing ordinary credit settlement behavior", async () => {
		const f = fixture();
		const credit = { id: "credit", amount: 5n, status: "ACTIVE", accountId: "account" };
		Object.assign(f.job, { fundingSource: "CREDITS", creditsReserved: 5n, reservation: credit });
		funding.lookup.mockResolvedValue({ ...credit, fundingSource: "CREDITS" });
		await f.store.settle({
			...passClaim(),
			fundingSource: "CREDITS",
			reservedCredits: 5n,
			chargeCredits: 5n,
		});
		expect(funding.creditSettle).toHaveBeenCalledWith(
			{ reservationId: "credit", amount: 5n, referenceKey: "settle:job" },
			f.tx,
		);
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it("retains an independent pass hold during unknown/manual reconciliation and audits units as units", async () => {
		const tx = {
			generationAttempt: {
				findFirst: vi.fn(async () => ({ errorSnapshot: {} })),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			generationJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
			creditReservation: { findUnique: vi.fn(async () => null) },
			auditLog: { create: vi.fn(async (_input: unknown) => undefined) },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		await createDatabaseReconciliationStore(database as never).markUncertainForManualReconciliation(
			{
				jobId: "job",
				attemptId: "attempt",
				provider: "kie",
				providerTaskId: "task",
				version: 1,
				leaseToken: "lease",
				staleAgeMinutes: 1,
				repairCount: 1,
			},
		);
		expect(funding.finalize).not.toHaveBeenCalled();
		const data = tx.auditLog.create.mock.calls[0]?.[0] as {
			data: { metadata: Record<string, unknown> };
		};
		expect(data.data.metadata).toMatchObject({
			fundingSource: "IMAGE_PASS",
			imagePassUnitsReserved: "1",
		});
		expect(data.data.metadata).not.toHaveProperty("reservedCredits");
	});

	it("keeps a pass held when provider cancellation is ambiguous", async () => {
		const tx = {
			generationAttempt: {
				findUnique: vi.fn(async () => ({
					id: "attempt",
					jobId: "job",
					status: "RUNNING",
					errorSnapshot: {},
					job: { status: "PROVIDER_RUNNING" },
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			generationJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
			auditLog: { create: vi.fn() },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		await expect(
			createDatabaseProviderCancellationStore(
				database as never,
			).markProviderCancellationManualRecovery(
				{
					jobId: "job",
					attemptId: "attempt",
					provider: "kie",
					providerTaskId: "task",
					leaseToken: "lease",
					idempotencyKey: "cancel",
				},
				"PROVIDER_CANCELLATION_UNCONFIRMED",
			),
		).resolves.toBe(true);
		expect(funding.finalize).not.toHaveBeenCalled();
		expect(funding.creditSettle).not.toHaveBeenCalled();
	});

	it("recovers a late provider success using the same held pass reservation before output approval", async () => {
		const attempt = {
			id: "attempt",
			jobId: "job",
			provider: "kie",
			status: "NEEDS_RECONCILIATION",
			progress: null,
			providerCostMicros: 20_000n,
			errorSnapshot: {},
			responseSnapshot: {},
		};
		const tx = {
			$queryRaw: vi.fn(async () => [attempt]),
			generationJob: {
				findUniqueOrThrow: vi.fn(async () => ({
					productKey: "image-nano-banana-2-lite",
					status: "NEEDS_RECONCILIATION",
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			generationAttempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
			generationAttemptTransferEnvelope: { upsert: vi.fn() },
			providerWebhookEvent: { updateMany: vi.fn() },
			outboxEvent: { upsert: vi.fn() },
			auditLog: { create: vi.fn() },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		await createDatabaseProviderEventStore(database as never).recordProviderProgress(
			{
				eventId: "event",
				attemptId: "attempt",
				provider: "kie",
				snapshot: { providerTaskId: "task", status: "SUCCEEDED", raw: {} },
				receivedAt: new Date(),
				processingToken: "token",
			},
			{
				outputs: [
					{
						kind: "remote-url",
						trust: "untrusted-transfer-candidate",
						url: "https://provider.example/output.png",
					},
				],
				progress: 100,
				providerCostMicros: 20_000,
				providerCharged: true,
				failure: null,
				retryable: false,
			},
		);
		expect(funding.lookup).toHaveBeenCalledWith("job", tx);
		expect(tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "FINALIZING" }) }),
		);
		expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ eventType: "GENERATION_FINALIZE" }),
			}),
		);
		expect(funding.finalize).not.toHaveBeenCalled();
		expect(funding.creditSettle).not.toHaveBeenCalled();
	});

	it.each(["FAILED", "CANCELED"] as const)(
		"queues pass release for a charged but authenticated terminal %s retrieval",
		async (status) => {
			const f = reconciliationFixture();
			await expect(
				f.store.recordReconciled(
					f.lease,
					{
						providerTaskId: "task",
						status,
						raw: {},
						retrieval: { source: "kie-record-info", observedAt: new Date().toISOString() },
					},
					f.result,
				),
			).resolves.toEqual({ outboxCommitted: true });
			expect(f.tx.generationAttempt.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "FAILED", uncertainSubmission: false }),
				}),
			);
			expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: "FINALIZING",
						failureCode: "IMAGE_PASS_PROVIDER_FAILED_CONFIRMED",
					}),
				}),
			);
			expect(funding.finalize).not.toHaveBeenCalled();
			expect(funding.creditSettle).not.toHaveBeenCalled();
		},
	);

	it("retains a pass when a terminal result has no authenticated retrieval evidence", async () => {
		const f = reconciliationFixture();
		await f.store.recordReconciled(
			f.lease,
			{ providerTaskId: "task", status: "FAILED", raw: {} },
			f.result,
		);
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "NEEDS_RECONCILIATION" }),
			}),
		);
		expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it.each(["invalid", new Date(Date.now() + 3_600_000).toISOString()])(
		"retains a pass for invalid/future retrieval timestamps: %s",
		async (observedAt) => {
			const f = reconciliationFixture();
			await f.store.recordReconciled(
				f.lease,
				{
					providerTaskId: "task",
					status: "FAILED",
					raw: {},
					retrieval: { source: "kie-record-info", observedAt },
				},
				f.result,
			);
			expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "NEEDS_RECONCILIATION" }),
				}),
			);
			expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
		},
	);

	it("keeps a successful but empty provider result held for manual output recovery", async () => {
		const f = reconciliationFixture();
		await f.store.recordReconciled(
			f.lease,
			{
				providerTaskId: "task",
				status: "SUCCEEDED",
				raw: {},
				retrieval: { source: "kie-record-info", observedAt: new Date().toISOString() },
			},
			{ ...f.result, failure: null },
		);
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "NEEDS_RECONCILIATION" }),
			}),
		);
		expect(funding.finalize).not.toHaveBeenCalled();
		expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
	});

	it("retains the existing ordinary-credit manual hold for a charged terminal failure", async () => {
		const f = reconciliationFixture();
		funding.lookup.mockResolvedValue({
			id: "credit",
			amount: 5n,
			status: "ACTIVE",
			fundingSource: "CREDITS",
		});
		await f.store.recordReconciled(
			f.lease,
			{
				providerTaskId: "task",
				status: "FAILED",
				raw: {},
				retrieval: { source: "kie-record-info", observedAt: new Date().toISOString() },
			},
			f.result,
		);
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "NEEDS_RECONCILIATION" }),
			}),
		);
		expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
	});

	it("does not authorize release from a mismatched provider task", async () => {
		const f = reconciliationFixture();
		await expect(
			f.store.recordReconciled(
				f.lease,
				{
					providerTaskId: "foreign-task",
					status: "FAILED",
					raw: {},
					retrieval: { source: "kie-record-info", observedAt: new Date().toISOString() },
				},
				f.result,
			),
		).rejects.toThrow("RECONCILIATION_TASK_MISMATCH");
		expect(f.tx.outboxEvent.createMany).not.toHaveBeenCalled();
		expect(funding.finalize).not.toHaveBeenCalled();
	});

	it.each([0, 2])("rejects %s provider outputs before storing any pass output", async (count) => {
		const outputs = Array.from({ length: count }, (_, i) => ({
			kind: "remote-url" as const,
			trust: "untrusted-transfer-candidate" as const,
			url: `https://provider.example/${i}.png`,
			mimeType: "image/png",
		}));
		const tx = {
			generationJob: {
				findFirst: vi.fn(async () => ({
					id: "job",
					ownerId: "owner",
					fundingSource: "IMAGE_PASS",
					serviceClass: "STANDARD",
					productKey: "image-nano-banana-2-lite",
					version: 1,
					failureCode: null,
					attempts: [
						{
							id: "attempt",
							transferEnvelope: { payload: createOutputTransferEnvelope("image", outputs) ?? {} },
						},
					],
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			generationAttempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
			outboxEvent: { upsert: vi.fn() },
			auditLog: { create: vi.fn(async (_input: unknown) => undefined) },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		await expect(
			createDatabaseFinalizationStore(database as never).claimFinalization(payload),
		).resolves.toBeNull();
		expect(tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ failureCode: "IMAGE_PASS_OUTPUT_CARDINALITY_INVALID" }),
			}),
		);
		expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ eventType: "GENERATION_SETTLE" }),
			}),
		);
	});

	it("recovers settlement for a canceled job with only an active pass reservation", async () => {
		const now = new Date();
		const tx = {
			$queryRaw: vi.fn(async () => [{ id: "job" }]),
			generationJob: {
				findUnique: vi.fn(async () => ({
					id: "job",
					status: "CANCELED",
					reservation: null,
					attempts: [],
					finalizationRetryCount: 0,
					finalizationErrorCode: null,
					nextFinalizeAt: null,
					updatedAt: new Date(0),
					version: 1,
				})),
				update: vi.fn(),
			},
			outboxEvent: { findMany: vi.fn(async () => []), create: vi.fn() },
		};
		const database = {
			$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
		};
		await expect(
			createDatabaseFinalizingGenerationRecoveryStore(database as never).recoverCandidate(
				{ jobId: "job" },
				{ now, staleBefore: now },
			),
		).resolves.toBe("RECOVERED");
		expect(tx.outboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ eventType: "GENERATION_SETTLE" }),
			}),
		);
	});
});

function reconciliationFixture() {
	const attempt = {
		id: "attempt",
		jobId: "job",
		provider: "kie",
		providerTaskId: "task",
		status: "RUNNING",
		providerCostMicros: 20_000n,
		responseSnapshot: {},
		errorSnapshot: {},
		job: {
			productKey: "image-nano-banana-2-lite",
			status: "PROVIDER_RUNNING",
			fundingSource: "IMAGE_PASS",
		},
	};
	const tx = {
		$queryRaw: vi.fn(async () => [{ id: "attempt" }]),
		generationAttempt: {
			findFirst: vi.fn(async () => attempt),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJob: { updateMany: vi.fn(async () => ({ count: 1 })) },
		outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
		auditLog: { create: vi.fn() },
	};
	const database = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	const lease = {
		jobId: "job",
		attemptId: "attempt",
		provider: "kie" as const,
		providerTaskId: "task",
		version: 1,
		leaseToken: "lease",
		staleAgeMinutes: 1,
		repairCount: 1,
	};
	const result = {
		outputs: [],
		progress: 100,
		providerCostMicros: 20_000,
		providerCharged: true,
		failure: { code: "CONTENT_REJECTED", message: "Rejected", retryable: false },
		retryable: false,
	};
	return { tx, store: createDatabaseReconciliationStore(database as never), lease, result };
}
