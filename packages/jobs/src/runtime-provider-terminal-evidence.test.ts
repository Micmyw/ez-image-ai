import type { NormalizedResult, ProviderTaskSnapshot } from "@repo/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getGenerationFundingReservation: async (
		jobId: string,
		tx: {
			creditReservation: {
				findUnique(input: unknown): Promise<{ id: string; status: string; amount: bigint } | null>;
			};
		},
	) => {
		const reservation = await tx.creditReservation.findUnique({ where: { jobId } });
		return reservation ? { ...reservation, fundingSource: "CREDITS" } : null;
	},
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import type { ReconciliationLease } from "./contracts";
import {
	createDatabaseDispatchStore,
	createDatabaseFinalizationStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
} from "./runtime";

const now = new Date("2026-10-19T12:00:01.000Z");
const lease: ReconciliationLease = {
	jobId: "job",
	attemptId: "attempt",
	provider: "kie",
	providerTaskId: "task",
	version: 1,
	leaseToken: "lease",
	staleAgeMinutes: 1,
	repairCount: 1,
};
const snapshot: ProviderTaskSnapshot = {
	providerTaskId: "task",
	status: "FAILED",
	raw: {},
	retrieval: { source: "kie-record-info", observedAt: "2026-10-19T12:00:00.000Z" },
};
const result: NormalizedResult = {
	outputs: [],
	progress: 100,
	providerCostMicros: 20_000,
	providerCharged: true,
	failure: { code: "CONTENT_REJECTED", message: "Content rejected", retryable: false },
	retryable: false,
};
const evidence = {
	version: 1,
	provider: "kie",
	source: "kie-record-info",
	attemptId: "attempt",
	providerTaskId: "task",
	status: "FAILED",
	verifiedAt: "2026-10-19T12:00:00.000Z",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

function fixture() {
	const attempt = {
		id: "attempt",
		jobId: "job",
		provider: "kie",
		providerTaskId: "task",
		status: "RUNNING",
		uncertainSubmission: false,
		providerCostMicros: 20_000n,
		responseSnapshot: { providerCharged: true } as Record<string, unknown>,
		errorSnapshot: {},
		job: { productKey: "image-nano-banana-2-lite", status: "PROVIDER_RUNNING" },
	};
	const tx = {
		$queryRaw: vi.fn(
			async (_query: unknown, ..._values: unknown[]) => [{ id: "attempt" }] as unknown[],
		),
		generationAttempt: {
			findFirst: vi.fn(async () => attempt),
			findUniqueOrThrow: vi.fn(async () => attempt),
			update: vi.fn(async (_input: unknown) => ({})),
			updateMany: vi.fn(async (_input: unknown) => ({ count: 1 })),
		},
		generationJob: {
			updateMany: vi.fn(async (_input: unknown) => ({ count: 1 })),
			findFirst: vi.fn(),
			findUniqueOrThrow: vi.fn(),
		},
		creditReservation: {
			findUnique: vi.fn(async () => ({ id: "reservation", status: "ACTIVE", amount: 10n })),
		},
		auditLog: { create: vi.fn() },
		generationAttemptTransferEnvelope: { upsert: vi.fn() },
		outboxEvent: { upsert: vi.fn() },
		providerWebhookEvent: { updateMany: vi.fn(async () => ({ count: 1 })) },
	};
	const database = {
		$transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
	};
	return { attempt, tx, database, store: createDatabaseReconciliationStore(database as never) };
}

describe("authenticated terminal observations release only supplier occupancy", () => {
	it("does not let late submission acknowledgement erase a verified terminal observation", async () => {
		const f = fixture();
		f.attempt.responseSnapshot = { providerTerminalEvidence: evidence };
		await createDatabaseDispatchStore(f.database as never).recordSubmission("attempt", {
			outcome: "accepted",
			providerTaskId: "task",
			status: "RUNNING",
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: { submissionToken: "attempt" },
			snapshot: { providerTaskId: "task", status: "RUNNING", raw: {} },
		});
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
		expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			f.tx.generationAttempt.findUniqueOrThrow.mock.invocationCallOrder[0]!,
		);
	});

	it("preserves verified capacity evidence when a late usable callback recovers manual output", async () => {
		const f = fixture();
		Object.assign(f.attempt, {
			status: "NEEDS_RECONCILIATION",
			responseSnapshot: {
				providerCharged: true,
				providerTerminalEvidence: { ...evidence, status: "SUCCEEDED" },
			},
		});
		f.tx.$queryRaw.mockResolvedValue([f.attempt]);
		f.tx.generationJob.findUniqueOrThrow.mockResolvedValue({
			productKey: "image-nano-banana-2-lite",
			status: "NEEDS_RECONCILIATION",
		});
		await createDatabaseProviderEventStore(f.database as never).recordProviderProgress(
			{
				eventId: "event",
				attemptId: "attempt",
				processingToken: "token",
				provider: "kie",
				receivedAt: now,
				snapshot: { providerTaskId: "task", status: "SUCCEEDED", raw: {} },
			},
			{
				...result,
				outputs: [
					{
						kind: "remote-url",
						url: "https://cdn.example.test/output.png",
						trust: "untrusted-transfer-candidate",
					},
				],
			},
		);
		expect(String(f.tx.$queryRaw.mock.calls[0]?.[0])).toContain('"providerTaskId"');
		expect(f.tx.generationAttempt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					responseSnapshot: expect.objectContaining({
						providerTerminalEvidence: { ...evidence, status: "SUCCEEDED" },
					}),
				}),
			}),
		);
	});

	it("persists a bound terminal marker before a charged content failure enters manual billing review", async () => {
		const f = fixture();
		await f.store.recordReconciled(lease, snapshot, result);
		expect(f.tx.generationAttempt.update).toHaveBeenCalledWith({
			where: { id: "attempt" },
			data: { responseSnapshot: { providerCharged: true, providerTerminalEvidence: evidence } },
		});
		expect(f.tx.generationAttempt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "NEEDS_RECONCILIATION",
					uncertainSubmission: true,
					responseSnapshot: expect.objectContaining({
						providerCharged: true,
						providerTerminalEvidence: evidence,
					}),
				}),
			}),
		);
		expect(f.tx.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "NEEDS_RECONCILIATION" }),
			}),
		);
	});

	it("keeps the marker when authenticated success has no usable transfer envelope", async () => {
		const f = fixture();
		await f.store.recordReconciled(lease, { ...snapshot, status: "SUCCEEDED" }, result);
		expect(f.tx.generationAttempt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "NEEDS_RECONCILIATION",
					uncertainSubmission: true,
					responseSnapshot: expect.objectContaining({
						providerTerminalEvidence: { ...evidence, status: "SUCCEEDED" },
					}),
				}),
			}),
		);
	});

	it("keeps a verified marker when finalization sanitizes an invalid transfer envelope", async () => {
		const f = fixture();
		Object.assign(f.attempt, {
			status: "SUCCEEDED",
			transferEnvelope: { payload: { version: 1, outputs: [] } },
			responseSnapshot: {
				providerCharged: true,
				providerTerminalEvidence: { ...evidence, status: "SUCCEEDED" },
			},
		});
		f.tx.generationJob.findFirst.mockResolvedValue({
			id: "job",
			version: 1,
			productKey: "image-nano-banana-2-lite",
			serviceClass: "STANDARD",
			guestTrial: null,
			attempts: [f.attempt],
		});
		await createDatabaseFinalizationStore(f.database as never).claimFinalization({
			jobId: "job",
			version: 1,
		});
		expect(f.tx.generationAttempt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "NEEDS_RECONCILIATION",
					responseSnapshot: {
						providerCharged: true,
						outputCount: 0,
						providerTerminalEvidence: { ...evidence, status: "SUCCEEDED" },
					},
				}),
			}),
		);
	});

	it("does not infer authenticated retrieval authority from raw callback JSON", async () => {
		const f = fixture();
		await f.store.recordReconciled(
			lease,
			{ ...snapshot, retrieval: undefined, raw: { providerTerminalEvidence: evidence } },
			result,
		);
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		const written = f.tx.generationAttempt.updateMany.mock.calls[0]?.[0];
		expect(written).not.toHaveProperty("data.responseSnapshot.providerTerminalEvidence");
	});

	it.each([{ provider: "fal" as const }, { providerTaskId: "another-task" }])(
		"does not write evidence for a mismatched lease: %j",
		async (patch) => {
			const f = fixture();
			await expect(
				f.store.recordReconciled(
					{ ...lease, ...patch },
					{ ...snapshot, providerTaskId: patch.providerTaskId ?? snapshot.providerTaskId },
					result,
				),
			).rejects.toThrow("RECONCILIATION_TASK_MISMATCH");
			expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		},
	);

	it("does not record a terminal observation after losing its row lease", async () => {
		const f = fixture();
		f.tx.$queryRaw.mockResolvedValue([]);
		await f.store.recordReconciled(lease, snapshot, result);
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.generationAttempt.updateMany).not.toHaveBeenCalled();
	});
});
