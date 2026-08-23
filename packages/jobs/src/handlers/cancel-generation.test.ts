import { describe, expect, it, vi } from "vitest";

import { cancelProviderGeneration } from "./cancel-generation";

describe("cancelProviderGeneration", () => {
	it("confirms one no-charge provider cancellation for a durable accepted-job intent", async () => {
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};
		const store = {
			claimProviderCancellation: vi.fn().mockResolvedValueOnce(claim).mockResolvedValueOnce(null),
			confirmProviderCancellation: vi.fn(async () => true),
			markProviderCancellationManualRecovery: vi.fn(async () => true),
			releaseProviderCancellation: vi.fn(async () => undefined),
		};
		const cancel = vi.fn(async () => ({
			status: "CANCELED" as const,
			canceled: true,
			noCharge: true,
			retryable: false,
		}));

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () => ({ cancel }) as never,
				},
			),
		).resolves.toEqual({ outcome: "CONFIRMED" });
		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () => ({ cancel }) as never,
				},
			),
		).resolves.toEqual({ outcome: "SKIPPED" });

		expect(cancel).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledWith({
			providerTaskId: "provider-task_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		});
		expect(store.confirmProviderCancellation).toHaveBeenCalledWith(claim);
		expect(store.releaseProviderCancellation).not.toHaveBeenCalled();
	});

	it("retains the reservation when a cancellation acknowledgement lacks no-charge proof", async () => {
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};
		const store = {
			claimProviderCancellation: vi.fn(async () => claim),
			confirmProviderCancellation: vi.fn(async () => true),
			markProviderCancellationManualRecovery: vi.fn(async () => true),
			releaseProviderCancellation: vi.fn(async () => undefined),
		};

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () =>
						({
							cancel: async () => ({
								status: "CANCELED" as const,
								canceled: true,
								noCharge: false,
								retryable: false,
							}),
						}) as never,
				},
			),
		).resolves.toEqual({ outcome: "MANUAL_RECOVERY" });

		expect(store.confirmProviderCancellation).not.toHaveBeenCalled();
		expect(store.markProviderCancellationManualRecovery).toHaveBeenCalledWith(
			claim,
			"PROVIDER_CANCELLATION_UNCONFIRMED",
		);
		expect(store.releaseProviderCancellation).not.toHaveBeenCalled();
	});

	it("does not settle when a terminal provider event wins the confirmation race", async () => {
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};
		const store = {
			claimProviderCancellation: vi.fn(async () => claim),
			confirmProviderCancellation: vi.fn(async () => false),
			markProviderCancellationManualRecovery: vi.fn(async () => true),
			releaseProviderCancellation: vi.fn(async () => undefined),
		};

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () =>
						({
							cancel: async () => ({
								status: "CANCELED" as const,
								canceled: true,
								noCharge: true,
								retryable: false,
							}),
						}) as never,
				},
			),
		).resolves.toEqual({ outcome: "SKIPPED" });

		expect(store.releaseProviderCancellation).toHaveBeenCalledWith(claim);
	});

	it("keeps the durable cancellation intent retryable while reconciliation owns the attempt lease", async () => {
		const getProvider = vi.fn();
		const store = {
			claimProviderCancellation: vi.fn(async () => ({
				kind: "BLOCKED" as const,
				reason: "ATTEMPT_LEASED" as const,
				retryable: true as const,
			})),
			confirmProviderCancellation: vi.fn(),
			markProviderCancellationManualRecovery: vi.fn(),
			releaseProviderCancellation: vi.fn(),
		};

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{ store, getProvider: getProvider as never },
			),
		).rejects.toThrow("PROVIDER_CANCELLATION_LEASE_CONTENDED");

		expect(getProvider).not.toHaveBeenCalled();
		expect(store.releaseProviderCancellation).not.toHaveBeenCalled();
	});

	it("releases its exact lease and retries a transient provider cancellation result", async () => {
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};
		const store = {
			claimProviderCancellation: vi.fn(async () => claim),
			confirmProviderCancellation: vi.fn(),
			markProviderCancellationManualRecovery: vi.fn(),
			releaseProviderCancellation: vi.fn(async () => undefined),
		};

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () =>
						({
							cancel: async () => ({
								status: "UNKNOWN" as const,
								canceled: false,
								noCharge: false,
								retryable: true,
							}),
						}) as never,
				},
			),
		).rejects.toThrow("PROVIDER_CANCELLATION_REQUEST_RETRYABLE");

		expect(store.releaseProviderCancellation).toHaveBeenCalledWith(claim);
		expect(store.markProviderCancellationManualRecovery).not.toHaveBeenCalled();
	});

	it("releases its lease when confirmation persistence fails so the durable intent can retry", async () => {
		const claim = {
			jobId: "job_1",
			attemptId: "attempt_1",
			provider: "replicate" as const,
			providerTaskId: "provider-task_1",
			leaseToken: "cancel-lease_1",
			idempotencyKey: "generation-cancel:job_1:attempt_1",
		};
		const store = {
			claimProviderCancellation: vi.fn(async () => claim),
			confirmProviderCancellation: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
			markProviderCancellationManualRecovery: vi.fn(),
			releaseProviderCancellation: vi.fn(async () => undefined),
		};

		await expect(
			cancelProviderGeneration(
				{ jobId: "job_1", version: 5 },
				{
					store,
					getProvider: () =>
						({
							cancel: async () => ({
								status: "CANCELED" as const,
								canceled: true,
								noCharge: true,
								retryable: false,
							}),
						}) as never,
				},
			),
		).rejects.toThrow("PROVIDER_CANCELLATION_CONFIRMATION_FAILED");

		expect(store.releaseProviderCancellation).toHaveBeenCalledWith(claim);
	});
});
