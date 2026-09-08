import type { MediaProviderAdapter } from "@repo/ai/media/providers/provider-adapter";
import { describe, expect, it, vi } from "vitest";

import type { GenerationPollingStore, ReconciliationLease } from "../contracts";
import { executePollingTick } from "./polling";

function fixture() {
	const now = new Date("2026-09-08T14:00:00.000Z");
	const lease: ReconciliationLease = {
		jobId: "job-1",
		version: 1,
		attemptId: "attempt-1",
		provider: "kie",
		providerTaskId: "remote-1",
		leaseToken: "lease-1",
		staleAgeMinutes: 1,
		repairCount: 0,
	};
	const adapter = {
		provider: "kie",
		submit: vi.fn(async () => {
			throw new Error("poll must never submit");
		}),
		retrieve: vi.fn(async () => ({
			providerTaskId: "remote-1",
			status: "RUNNING" as const,
			raw: {},
		})),
		normalizeResult: vi.fn(async () => ({
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		})),
	} satisfies MediaProviderAdapter;
	const store = {
		getPollingState: vi
			.fn<GenerationPollingStore["getPollingState"]>()
			.mockResolvedValue({ pollAt: now }),
		claimStale: vi.fn<GenerationPollingStore["claimStale"]>().mockResolvedValue([lease]),
		recordReconciled: vi
			.fn<GenerationPollingStore["recordReconciled"]>()
			.mockResolvedValue(undefined),
		releaseReconciliationLease: vi
			.fn<GenerationPollingStore["releaseReconciliationLease"]>()
			.mockResolvedValue(undefined),
		markUncertainForManualReconciliation: vi
			.fn<GenerationPollingStore["markUncertainForManualReconciliation"]>()
			.mockResolvedValue(undefined),
	};
	return {
		now,
		adapter,
		store,
		dependencies: { store, getProvider: () => adapter, now: () => now },
	};
}

describe("one durable polling tick", () => {
	it("returns a bounded sleep without querying a Provider before the DB due time", async () => {
		const f = fixture();
		f.store.getPollingState.mockResolvedValue({ pollAt: new Date(f.now.getTime() + 75_000) });
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: false,
			waitSeconds: 60,
		});
		expect(f.store.claimStale).not.toHaveBeenCalled();
		expect(f.adapter.retrieve).not.toHaveBeenCalled();
	});

	it("runs exactly one DB-scoped reconciliation and returns the persisted next due time", async () => {
		const f = fixture();
		f.store.getPollingState
			.mockResolvedValueOnce({ pollAt: f.now })
			.mockResolvedValueOnce({ pollAt: new Date(f.now.getTime() + 12_100) });
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: false,
			waitSeconds: 13,
		});
		expect(f.store.claimStale).toHaveBeenCalledExactlyOnceWith({
			attemptId: "attempt-1",
			limit: 1,
			leaseSeconds: 300,
			now: f.now,
		});
		expect(f.adapter.retrieve).toHaveBeenCalledTimes(1);
		expect(f.store.recordReconciled).toHaveBeenCalledTimes(1);
		expect(f.adapter.submit).not.toHaveBeenCalled();
	});

	it("stops when DB evidence disappears after a webhook or terminal observation", async () => {
		const f = fixture();
		f.store.getPollingState.mockResolvedValue(null);
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: true,
			waitSeconds: 0,
		});
		expect(f.store.getPollingState).toHaveBeenCalledWith("attempt-1");
		expect(f.store.claimStale).not.toHaveBeenCalled();
		f.store.getPollingState.mockResolvedValueOnce({ pollAt: f.now }).mockResolvedValueOnce(null);
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: true,
			waitSeconds: 0,
		});
		expect(f.store.claimStale).toHaveBeenCalledTimes(1);
	});

	it("waits after lost lease and uses canonical reconciliation backoff after Provider failure", async () => {
		const f = fixture();
		f.store.claimStale.mockResolvedValueOnce([]);
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: false,
			waitSeconds: 5,
		});
		vi.mocked(f.adapter.retrieve).mockRejectedValueOnce(new Error("transport"));
		expect(await executePollingTick({ attemptId: "attempt-1" }, f.dependencies)).toEqual({
			done: false,
			waitSeconds: 5,
		});
		expect(f.store.releaseReconciliationLease).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: "attempt-1" }),
			"RECONCILIATION_RETRY",
			new Date(f.now.getTime() + 120_000),
		);
		expect(f.adapter.submit).not.toHaveBeenCalled();
	});

	it("rejects empty or malformed scope before any database access", async () => {
		const f = fixture();
		await expect(executePollingTick({ attemptId: " " }, f.dependencies)).rejects.toThrow();
		expect(f.store.getPollingState).not.toHaveBeenCalled();
	});
});
