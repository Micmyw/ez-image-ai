import { isImagePassOfferSnapshot, IMAGE_PASS_PUBLIC_OFFER } from "./image-pass";

export const IMAGE_PASS_AMOUNT_MICROS = 2_990_000n;
export const LEGACY_IMAGE_PASS_AMOUNT_MICROS = 1_000_000n;
/** PayPal Orders accepts merchant SKUs inline; these are not remote subscription plans. */
export const IMAGE_PASS_PAYPAL_SKU = "EZIMAGE-IMAGE-PASS-3-USD-299-20261104";
export const LEGACY_IMAGE_PASS_PAYPAL_SKU = "EZIMAGE-IMAGE-PASS-3-USD-1-20261019";

export interface ImagePassBillingPlan {
	provider: string;
	providerPriceId: string;
	productKind: string;
	name: string;
	priceMicros: bigint;
	currency: string;
	creditsPerPeriod: bigint;
	metadata: unknown;
}

export function imagePassOfferAmountMicros(snapshot: unknown): bigint | null {
	if (!isImagePassOfferSnapshot(snapshot)) return null;
	return snapshot.offerVersion === IMAGE_PASS_PUBLIC_OFFER.offerVersion
		? IMAGE_PASS_AMOUNT_MICROS
		: LEGACY_IMAGE_PASS_AMOUNT_MICROS;
}

function imagePassOfferMerchantSku(snapshot: unknown): string | null {
	if (!isImagePassOfferSnapshot(snapshot)) return null;
	return snapshot.offerVersion === IMAGE_PASS_PUBLIC_OFFER.offerVersion
		? IMAGE_PASS_PAYPAL_SKU
		: LEGACY_IMAGE_PASS_PAYPAL_SKU;
}

export function isImagePassBillingPlan(plan: ImagePassBillingPlan | null | undefined): boolean {
	if (!plan || !plan.metadata || typeof plan.metadata !== "object") return false;
	const snapshot = (plan.metadata as Record<string, unknown>).imagePassOfferSnapshot;
	return (
		plan.provider === "paypal" &&
		plan.productKind === "IMAGE_PASS" &&
		plan.name === IMAGE_PASS_PUBLIC_OFFER.offerKey &&
		plan.currency === "USD" &&
		plan.creditsPerPeriod === 0n &&
		plan.priceMicros === imagePassOfferAmountMicros(snapshot) &&
		plan.providerPriceId === imagePassOfferMerchantSku(snapshot)
	);
}

/** Historical USD 1 offers share a plan; a USD 1 intent can never use the USD 2.99 plan. */
export function imagePassBillingPlanMatchesOffer(
	plan: ImagePassBillingPlan | null | undefined,
	snapshot: unknown,
): boolean {
	return Boolean(
		plan &&
		isImagePassBillingPlan(plan) &&
		plan.priceMicros === imagePassOfferAmountMicros(snapshot) &&
		plan.providerPriceId === imagePassOfferMerchantSku(snapshot),
	);
}
