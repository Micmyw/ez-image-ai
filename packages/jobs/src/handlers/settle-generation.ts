import type { JobPayload, SettlementDependencies } from "../contracts";

export async function settleGeneration(
	payload: JobPayload,
	dependencies: SettlementDependencies,
): Promise<{ outcome: "SKIPPED" | "SETTLED" }> {
	const committed = await dependencies.store.settleForJob?.(payload);
	if (committed) return committed;
	const claim = await dependencies.store.claimSettlement(payload);
	if (!claim) return { outcome: "SKIPPED" };
	await dependencies.store.settle({
		...claim,
		chargeCredits: claim.readyOutputCount > 0 ? claim.chargeCredits : 0n,
	});
	return { outcome: "SETTLED" };
}
