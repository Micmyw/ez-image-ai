import type { ReconciliationDependencies } from "../contracts";

export async function reconcileGenerations(
	input: { limit?: number; leaseSeconds?: number },
	dependencies: ReconciliationDependencies,
): Promise<{ claimed: number; reconciled: number }> {
	const now = dependencies.now?.() ?? new Date();
	const leases = await dependencies.store.claimStale({
		limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
		leaseSeconds: Math.min(Math.max(input.leaseSeconds ?? 60, 10), 300),
		now,
	});
	let reconciled = 0;
	for (const lease of leases) {
		if (!lease.providerTaskId) {
			if (lease.repairCount >= 5) {
				await dependencies.store.markUncertainForManualReconciliation(lease);
				continue;
			}
			await dependencies.store.releaseReconciliationLease(
				lease,
				"SUBMISSION_UNCERTAIN_MANUAL_REPAIR",
				new Date(now.getTime() + 60 * 60_000),
			);
			continue;
		}
		try {
			const adapter = dependencies.getProvider(lease.provider);
			const snapshot = await adapter.retrieve({
				providerTaskId: lease.providerTaskId,
				statusUrl: lease.statusUrl,
				resultUrl: lease.resultUrl,
			});
			const result = await adapter.normalizeResult(snapshot);
			await dependencies.store.recordReconciled(lease, snapshot, result);
			reconciled += 1;
		} catch {
			const ageBand = Math.max(1, Math.floor(lease.staleAgeMinutes / 15));
			const delayMinutes = Math.min(60, 2 ** Math.min(ageBand, 6));
			await dependencies.store.releaseReconciliationLease(
				lease,
				"RECONCILIATION_RETRY",
				new Date(now.getTime() + delayMinutes * 60_000),
			);
		}
	}
	return { claimed: leases.length, reconciled };
}
