import { describe, expect, it, vi } from "vitest";

import type { ReconciliationLease, ReconciliationStore } from "../contracts";
import { reconcileGenerations } from "./reconcile-generations";

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

		expect(result).toEqual({ claimed: 1, reconciled: 0 });
		expect(markUncertainForManualReconciliation).toHaveBeenCalledOnce();
		expect(markUncertainForManualReconciliation).toHaveBeenCalledWith(
			lease,
			"PROVIDER_RECOVERY_UNAVAILABLE",
		);
		expect(releaseReconciliationLease).not.toHaveBeenCalled();
		expect(recordReconciled).not.toHaveBeenCalled();
	});
});
