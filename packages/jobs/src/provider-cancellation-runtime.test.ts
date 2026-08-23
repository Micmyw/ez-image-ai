import { describe, expect, it, vi } from "vitest";

import { createDatabaseProviderCancellationStore } from "./runtime";

describe("database provider cancellation store", () => {
	it("settles only a cancellation confirmation that still owns the accepted attempt lease", async () => {
		const transaction = {
			generationAttempt: {
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			generationJob: {
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			outboxEvent: {
				upsert: vi.fn(async () => ({})),
			},
		};
		const store = createDatabaseProviderCancellationStore({
			$transaction: async (callback: (value: typeof transaction) => unknown) =>
				callback(transaction),
		} as never);
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};

		await expect(store.confirmProviderCancellation(claim)).resolves.toBe(true);
		expect(transaction.generationAttempt.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "attempt_1",
					reconcileLeaseToken: "cancel-lease_1",
					providerTaskId: "provider-task_1",
				}),
				data: expect.objectContaining({ status: "CANCELED" }),
			}),
		);
		expect(transaction.generationJob.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "job_1" }),
				data: expect.objectContaining({
					status: "CANCELED",
					failureCode: "PROVIDER_CANCELED_CONFIRMED_NO_CHARGE",
				}),
			}),
		);
		expect(transaction.outboxEvent.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { dedupeKey: "generation-settle:job_1" },
				create: expect.objectContaining({ eventType: "GENERATION_SETTLE" }),
			}),
		);
	});

	it("does not enqueue settlement when a terminal webhook has already consumed the cancellation lease", async () => {
		const transaction = {
			generationAttempt: {
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			generationJob: {
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			outboxEvent: {
				upsert: vi.fn(async () => ({})),
			},
		};
		const store = createDatabaseProviderCancellationStore({
			$transaction: async (callback: (value: typeof transaction) => unknown) =>
				callback(transaction),
		} as never);
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};

		await expect(store.confirmProviderCancellation(claim)).resolves.toBe(false);

		expect(transaction.generationJob.updateMany).not.toHaveBeenCalled();
		expect(transaction.outboxEvent.upsert).not.toHaveBeenCalled();
	});

	it.each([
		["an active reconciliation lease", new Date(Date.now() + 60_000), 1],
		["a conditional lease race", null, 0],
	] as const)(
		"returns BLOCKED for %s instead of silently skipping",
		async (_reason, leasedUntil, count) => {
			const transaction = {
				outboxEvent: { findUnique: vi.fn(async () => ({ id: "cancel-intent_1" })) },
				generationAttempt: {
					findFirst: vi.fn(async () => ({
						id: "attempt_1",
						provider: "replicate",
						providerTaskId: "provider-task_1",
						reconcileLeasedUntil: leasedUntil,
					})),
					updateMany: vi.fn(async () => ({ count })),
				},
			};
			const store = createDatabaseProviderCancellationStore({
				$transaction: async (callback: (value: typeof transaction) => unknown) =>
					callback(transaction),
			} as never);

			await expect(
				store.claimProviderCancellation({ jobId: "job_1", version: 5 }),
			).resolves.toEqual({
				kind: "BLOCKED",
				reason: "ATTEMPT_LEASED",
				retryable: true,
			});
			if (leasedUntil) expect(transaction.generationAttempt.updateMany).not.toHaveBeenCalled();
		},
	);
});
