import type {
	JobPayload,
	ProviderCancellationClaim,
	ProviderCancellationDependencies,
} from "../contracts";

export async function cancelProviderGeneration(
	payload: JobPayload,
	dependencies: ProviderCancellationDependencies,
): Promise<{ outcome: "SKIPPED" | "MANUAL_RECOVERY" | "CONFIRMED" }> {
	const claimResult = await dependencies.store.claimProviderCancellation(payload);
	if (!claimResult) return { outcome: "SKIPPED" };
	if ("kind" in claimResult) {
		throw new Error("PROVIDER_CANCELLATION_LEASE_CONTENDED");
	}
	const claim = claimResult;

	let adapter;
	try {
		adapter = dependencies.getProvider(claim.provider);
	} catch {
		return releaseAndRetry(dependencies, claim, "PROVIDER_CANCELLATION_ADAPTER_UNAVAILABLE");
	}
	if (!adapter.cancel) {
		const handedOff = await dependencies.store.markProviderCancellationManualRecovery(
			claim,
			"PROVIDER_CANCELLATION_UNSUPPORTED",
		);
		return { outcome: handedOff ? "MANUAL_RECOVERY" : "SKIPPED" };
	}

	let result;
	try {
		result = await adapter.cancel({
			providerTaskId: claim.providerTaskId,
			idempotencyKey: claim.idempotencyKey,
		});
	} catch {
		return releaseAndRetry(dependencies, claim, "PROVIDER_CANCELLATION_REQUEST_FAILED");
	}
	if (result.retryable) {
		return releaseAndRetry(dependencies, claim, "PROVIDER_CANCELLATION_REQUEST_RETRYABLE");
	}
	if (!result.canceled || result.status !== "CANCELED" || !result.noCharge) {
		const handedOff = await dependencies.store.markProviderCancellationManualRecovery(
			claim,
			"PROVIDER_CANCELLATION_UNCONFIRMED",
		);
		return { outcome: handedOff ? "MANUAL_RECOVERY" : "SKIPPED" };
	}

	let confirmed: boolean;
	try {
		confirmed = await dependencies.store.confirmProviderCancellation(claim);
	} catch {
		return releaseAndRetry(dependencies, claim, "PROVIDER_CANCELLATION_CONFIRMATION_FAILED");
	}
	if (!confirmed) {
		await dependencies.store.releaseProviderCancellation(claim);
		return { outcome: "SKIPPED" };
	}
	return { outcome: "CONFIRMED" };
}

async function releaseAndRetry(
	dependencies: ProviderCancellationDependencies,
	claim: ProviderCancellationClaim,
	code: string,
): Promise<never> {
	try {
		await dependencies.store.releaseProviderCancellation(claim);
	} catch {
		// A lost lease naturally expires; keep the cancellation intent retryable either way.
	}
	throw new Error(code);
}
