import type { GuestCapabilityProduct, GuestProductKey } from "./guest-draft-client";

export type LandingGeneratorStage =
	| "checking"
	| "ready"
	| "preparing"
	| "uploading"
	| "verifying"
	| "handoff"
	| "failed";

export type LandingDisabledReason =
	| "checking"
	| "unavailable"
	| "product"
	| "source"
	| "prompt"
	| "verification"
	| "busy";

export function resolveLandingProductSelection(
	products: readonly GuestCapabilityProduct[],
	selectedProductKey: GuestProductKey | null,
): GuestProductKey | null {
	if (selectedProductKey && products.some((product) => product.key === selectedProductKey)) {
		return selectedProductKey;
	}

	return (
		products.find((product) => product.accessHint === "guest-trial")?.key ??
		products.at(0)?.key ??
		null
	);
}

export function landingDisabledReason(input: {
	stage: LandingGeneratorStage;
	capabilityEnabled: boolean;
	productSelected: boolean;
	hasSource: boolean;
	prompt: string;
	turnstileReady: boolean;
}): LandingDisabledReason | null {
	if (input.stage === "checking") return "checking";
	if (["preparing", "uploading", "verifying", "handoff"].includes(input.stage)) return "busy";
	if (!input.capabilityEnabled) return "unavailable";
	if (!input.productSelected) return "product";
	if (!input.hasSource) return "source";
	if (!input.prompt.trim()) return "prompt";
	if (!input.turnstileReady) return "verification";
	return null;
}
