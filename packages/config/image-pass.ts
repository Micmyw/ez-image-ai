import { IMAGE_PASS_OFFER_SUMMARY } from "./image-pass-summary";
import { IMAGE_SKU_KEYS } from "./product";

/** This purchase grants successful images, never general-purpose credits. */
export const IMAGE_PASS_PUBLIC_OFFER = /* @__PURE__ */ Object.freeze({
	...IMAGE_PASS_OFFER_SUMMARY,
	allowedSkuKeys: /* @__PURE__ */ Object.freeze([...IMAGE_SKU_KEYS]),
} as const);

export type ImagePassOfferSnapshot = ReturnType<typeof getImagePassOfferSnapshot>;

export function getImagePassOfferSnapshot() {
	return {
		...IMAGE_PASS_PUBLIC_OFFER,
		allowedSkuKeys: [...IMAGE_PASS_PUBLIC_OFFER.allowedSkuKeys],
	};
}

export function isImagePassOfferSnapshot(value: unknown): value is ImagePassOfferSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	const allowedSkuKeys = snapshot.allowedSkuKeys;
	return (
		snapshot.offerKey === IMAGE_PASS_PUBLIC_OFFER.offerKey &&
		snapshot.offerVersion === IMAGE_PASS_PUBLIC_OFFER.offerVersion &&
		snapshot.provider === "paypal" &&
		snapshot.amount === "1.00" &&
		snapshot.currency === "USD" &&
		snapshot.units === 3 &&
		Array.isArray(allowedSkuKeys) &&
		allowedSkuKeys.length === IMAGE_SKU_KEYS.length &&
		IMAGE_SKU_KEYS.every((key, index) => allowedSkuKeys[index] === key)
	);
}
