import { isImagePassOfferSnapshot, IMAGE_PASS_PUBLIC_OFFER } from "./image-pass";

export const IMAGE_PASS_AMOUNT_MICROS = 1_000_000n;
/** PayPal Orders uses a merchant SKU, not a remotely provisioned subscription price. */
export const IMAGE_PASS_PAYPAL_SKU = "EZIMAGE-IMAGE-PASS-3-USD-1-20261019";

export function isImagePassBillingPlan(
	plan:
		| {
				provider: string;
				providerPriceId: string;
				productKind: string;
				name: string;
				priceMicros: bigint;
				currency: string;
				creditsPerPeriod: bigint;
				metadata: unknown;
		  }
		| null
		| undefined,
): boolean {
	if (!plan || !plan.metadata || typeof plan.metadata !== "object") return false;
	const metadata = plan.metadata as Record<string, unknown>;
	return (
		plan.provider === "paypal" &&
		plan.providerPriceId === IMAGE_PASS_PAYPAL_SKU &&
		plan.productKind === "IMAGE_PASS" &&
		plan.name === IMAGE_PASS_PUBLIC_OFFER.offerKey &&
		plan.priceMicros === IMAGE_PASS_AMOUNT_MICROS &&
		plan.currency === "USD" &&
		plan.creditsPerPeriod === 0n &&
		isImagePassOfferSnapshot(metadata.imagePassOfferSnapshot)
	);
}
