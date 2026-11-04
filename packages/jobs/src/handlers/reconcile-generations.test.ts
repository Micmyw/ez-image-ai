import { describe, expect, it, vi } from "vitest";

import type { ReconciliationLease, ReconciliationStore } from "../contracts";
import {
	reconcileGenerations,
	UNCONFIRMED_SUBMISSION_RECOVERY_MS,
	UNCONFIRMED_SUBMISSION_RETRY_MS,
} from "./reconcile-generations";

describe("reconcileGenerations", () => {
	it("escalates to manual recovery when the provider adapter is unavailable", async () => {
		const lease: ReconciliationLease = {
			jobId: "job-1",
			version: 1,
			attemptId: "attempt-1",
			provider: "replicate",
			providerTaskId: "provider-task-1",
			leaseToken: "lease-token-1",
			staleAgeMinutes: 30,
			repairCount: 1,
		};
		const recordReconciled = vi.fn();
		const releaseReconciliationLease = vi.fn();
		const markUncertainForManualReconciliation = vi.fn();
		const store: ReconciliationStore = {
			claimStale: vi.fn().mockResolvedValue([lease]),
			recordReconciled,
			releaseReconciliationLease,
			markUncertainForManualReconciliation,
		};

		const result = await reconcileGenerations(
			{},
			{
				store,
				getProvider: vi.fn(() => {
					throw new Error("Provider replicate not registered");
				}),
			},
		);

		expect(result).toEqual({ claimed: 1, reconciled: 0, outboxCommitted: false });
		expect(markUncertainForManualReconciliation).toHaveBeenCalledOnce();
		expect(markUncertainForManualReconciliation).toHaveBeenCalledWith(
			lease,
			"PROVIDER_RECOVERY_UNAVAILABLE",
		);
		expect(releaseReconciliationLease).not.toHaveBeenCalled();
		expect(recordReconciled).not.toHaveBeenCalled();
	});
});

describe("unconfirmed submissions without a provider task id", () => {
	const base: ReconciliationLease = {
		jobId: "job-2",
		version: 3,
		attemptId: "attempt-2",
		provider: "kie",
		leaseToken: "lease-token-2",
		staleAgeMinutes: 12,
		repairCount: 0,
	};
	function store(lease: ReconciliationLease) {
		return {
			claimStale: vi.fn().mockResolvedValue([lease]),
			recordReconciled: vi.fn().mockResolvedValue({ outboxCommitted: false }),
			releaseReconciliationLease: vi.fn(),
			markUncertainForManualReconciliation: vi.fn(),
		} satisfies ReconciliationStore;
	}
	it.each([0, 1, 29 * 60_000, UNCONFIRMED_SUBMISSION_RECOVERY_MS - 1, null, undefined])(
		"keeps unknown acceptance reserved at database age %s despite many retries",
		async (submissionAgeMs) => {
			const now = new Date("2026-11-04T08:00:00.000Z");
			const s = store({ ...base, repairCount: 100, submissionAgeMs });
			await reconcileGenerations({}, { store: s, getProvider: vi.fn(), now: () => now });
			expect(s.releaseReconciliationLease).toHaveBeenCalledWith(
				expect.objectContaining({ attemptId: "attempt-2" }),
				"SUBMISSION_UNCERTAIN_MANUAL_REPAIR",
				new Date(now.getTime() + UNCONFIRMED_SUBMISSION_RETRY_MS),
			);
			expect(s.markUncertainForManualReconciliation).not.toHaveBeenCalled();
		},
	);
	it("escalates at the database deadline without failing or settling the attempt", async () => {
		const lease = { ...base, submissionAgeMs: UNCONFIRMED_SUBMISSION_RECOVERY_MS, repairCount: 0 };
		const s = store(lease);
		await expect(reconcileGenerations({}, { store: s, getProvider: vi.fn() })).resolves.toEqual({
			claimed: 1,
			reconciled: 0,
			outboxCommitted: false,
		});
		expect(s.markUncertainForManualReconciliation).toHaveBeenCalledWith(lease);
		expect(s.releaseReconciliationLease).not.toHaveBeenCalled();
		expect(s.recordReconciled).not.toHaveBeenCalled();
	});
	it("continues retrieving an accepted task after the deadline", async () => {
		const lease = {
			...base,
			providerTaskId: "task-2",
			submissionAgeMs: 2 * 60 * 60_000,
			repairCount: 100,
		};
		const s = store(lease);
		const snapshot = { providerTaskId: "task-2", status: "RUNNING" as const, raw: {} };
		const result = {
			outputs: [],
			progress: 42,
			providerCostMicros: null,
			providerCharged: false,
			failure: null,
			retryable: false,
		};
		const retrieve = vi.fn().mockResolvedValue(snapshot);
		await reconcileGenerations(
			{},
			{
				store: s,
				getProvider: () => ({
					provider: "kie",
					retrieve,
					normalizeResult: vi.fn().mockResolvedValue(result),
				}),
			},
		);
		expect(retrieve).toHaveBeenCalledWith({
			providerTaskId: "task-2",
			statusUrl: undefined,
			resultUrl: undefined,
		});
		expect(s.recordReconciled).toHaveBeenCalledWith(lease, snapshot, result);
		expect(s.markUncertainForManualReconciliation).not.toHaveBeenCalled();
	});
});
