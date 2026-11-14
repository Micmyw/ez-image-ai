/** Public stable keys only. Costs and provider routes remain in their existing catalogs. */
export const GUEST_TRIAL_MODELS = [
	{ productKey: "image-minimax-h3", skuKey: "minimax-h3-1k" },
	{ productKey: "image-nano-banana-2-lite", skuKey: "nano-banana-2-lite-1k" },
] as const;

export type GuestTrialProductKey = (typeof GUEST_TRIAL_MODELS)[number]["productKey"];
export type GuestTrialSkuKey = (typeof GUEST_TRIAL_MODELS)[number]["skuKey"];

export function isGuestTrialModel(productKey: unknown, skuKey: unknown): boolean {
	return GUEST_TRIAL_MODELS.some(
		(model) => model.productKey === productKey && model.skuKey === skuKey,
	);
}
