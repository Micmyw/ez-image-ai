import { describe, expect, it, vi } from "vitest";

import type { ReconciliationLease, ReconciliationStore } from "../contracts";
import {
	reconcileGenerations,
	UNCONFIRMED_SUBMISSION_MAX_REPAIRS,
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
	function store(lease: ReconciliationLease, withDeadline = true) {
		const mocks = {
			releaseReconciliationLease: vi.fn(),
			markUncertainForManualReconciliation: vi.fn(),
			failUnconfirmedSubmission: vi.fn(),
		};
		const value: ReconciliationStore = {
			claimStale: vi.fn().mockResolvedValue([lease]),
			recordReconciled: vi.fn(),
			releaseReconciliationLease: mocks.releaseReconciliationLease,
			markUncertainForManualReconciliation: mocks.markUncertainForManualReconciliation,
			...(withDeadline ? { failUnconfirmedSubmission: mocks.failUnconfirmedSubmission } : {}),
		};
		return { store: value, ...mocks };
	}

	it("retries every 10 minutes while inside the bounded window", async () => {
		const now = new Date("2026-11-04T08:00:00.000Z");
		const s = store({ ...base, repairCount: UNCONFIRMED_SUBMISSION_MAX_REPAIRS - 1 });
		await reconcileGenerations({}, { store: s.store, getProvider: vi.fn(), now: () => now });
		expect(s.releaseReconciliationLease).toHaveBeenCalledWith(
			expect.objectContaining({ attemptId: "attempt-2" }),
			"SUBMISSION_UNCERTAIN_MANUAL_REPAIR",
			new Date(now.getTime() + UNCONFIRMED_SUBMISSION_RETRY_MS),
		);
		expect(UNCONFIRMED_SUBMISSION_RETRY_MS).toBe(600_000);
		expect(UNCONFIRMED_SUBMISSION_MAX_REPAIRS * UNCONFIRMED_SUBMISSION_RETRY_MS).toBe(30 * 60_000);
		expect(s.failUnconfirmedSubmission).not.toHaveBeenCalled();
	});

	it("fails and releases instead of holding credits for manual repair after the window", async () => {
		const s = store({ ...base, repairCount: UNCONFIRMED_SUBMISSION_MAX_REPAIRS });
		await reconcileGenerations({}, { store: s.store, getProvider: vi.fn() });
		expect(s.failUnconfirmedSubmission).toHaveBeenCalledOnce();
		expect(s.markUncertainForManualReconciliation).not.toHaveBeenCalled();
		expect(s.releaseReconciliationLease).not.toHaveBeenCalled();
	});

	it("keeps manual reconciliation for stores without the deadline", async () => {
		const s = store({ ...base, repairCount: 9 }, false);
		await reconcileGenerations({}, { store: s.store, getProvider: vi.fn() });
		expect(s.markUncertainForManualReconciliation).toHaveBeenCalledOnce();
	});
});
