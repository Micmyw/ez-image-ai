import type { ImageAspectRatio, ImageSkuKey } from "@repo/config/client";

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

export function localizeLandingProducts(
	products: readonly GuestCapabilityProduct[],
	labels: {
		productLabel: (productKey: GuestProductKey) => string;
		productDescription: (productKey: GuestProductKey) => string;
		skuLabel: (skuKey: ImageSkuKey) => string;
	},
): GuestCapabilityProduct[] {
	return products.map((product) => ({
		...product,
		label: labels.productLabel(product.key),
		description: labels.productDescription(product.key),
		skuMatrix: {
			...product.skuMatrix,
			cells: product.skuMatrix.cells.map((cell) => ({
				...cell,
				label: labels.skuLabel(cell.skuKey),
			})),
		},
	}));
}

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

export function resolveLandingAspectRatioSelection(
	product: GuestCapabilityProduct | null,
	selectedAspectRatio: ImageAspectRatio,
): ImageAspectRatio | null {
	if (!product) return null;
	if (product.aspectRatios.includes(selectedAspectRatio)) return selectedAspectRatio;
	return product.aspectRatios.includes("auto") ? "auto" : (product.aspectRatios[0] ?? null);
}

export function resolveLandingSkuSelection(
	product: GuestCapabilityProduct | null,
	selectedSkuKey: ImageSkuKey | null,
): ImageSkuKey | null {
	if (!product) return null;
	if (selectedSkuKey && product.skuMatrix.cells.some((cell) => cell.skuKey === selectedSkuKey)) {
		return selectedSkuKey;
	}
	return (
		product.skuMatrix.cells.find((cell) => cell.skuKey === product.skuMatrix.defaultSkuKey)
			?.skuKey ??
		product.skuMatrix.cells[0]?.skuKey ??
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
