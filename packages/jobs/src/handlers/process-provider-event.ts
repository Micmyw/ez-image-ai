import type { ProviderEventDependencies, ProviderWebhookPayload } from "../contracts";

export async function processProviderEvent(
	payload: ProviderWebhookPayload,
	dependencies: ProviderEventDependencies,
): Promise<{ outcome: "SKIPPED" | "PROCESSED" | "FAILED" }> {
	const claim = await dependencies.store.claimProviderEvent(payload.providerWebhookEventId);
	if (!claim) return { outcome: "SKIPPED" };
	let adapter;
	try {
		adapter = dependencies.getProvider(claim.provider);
	} catch {
		await dependencies.store.markProviderRecoveryUnavailable(claim);
		return { outcome: "PROCESSED" };
	}
	try {
		const result = await adapter.normalizeResult(claim.snapshot);
		await dependencies.store.recordProviderProgress(claim, result);
		return { outcome: "PROCESSED" };
	} catch {
		await dependencies.store.recordProviderEventFailure(claim, "PROVIDER_RESPONSE_INVALID");
		return { outcome: "FAILED" };
	}
}
