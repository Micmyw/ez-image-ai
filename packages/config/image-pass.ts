import { IMAGE_PASS_LEGACY_OFFER_VERSION, IMAGE_PASS_OFFER_SUMMARY } from "./image-pass-summary";
import type { ImageSkuKey } from "./product";

/**
 * Sizes a $1 Image Pass purchased from offer 2026-11-04.1 onward can pay for:
 * standard 1K/2K outputs only. Every 4K/3K tier, every Pro model and the
 * high-quality GPT Image 1.5 tier stay on credits.
 */
export const IMAGE_PASS_ALLOWED_SKU_KEYS = /* @__PURE__ */ Object.freeze([
	"nano-banana-2-lite-1k",
	"nano-banana-default",
	"nano-banana-2-1k",
	"nano-banana-2-2k",
	"gpt-image-1-5-medium",
	"gpt-image-2-1k",
	"gpt-image-2-2k",
	"gpt-image-2-5-flare-1k",
	"gpt-image-2-5-flare-2k",
	"gpt-image-2-5-sunburst-1k",
	"gpt-image-2-5-sunburst-2k",
	"seedream-4-1k",
	"seedream-4-2k",
	"seedream-4-5-basic-2k",
	"seedream-5-lite-basic-2k",
] as const satisfies readonly ImageSkuKey[]);

/** This purchase grants successful images, never general-purpose credits. */
export const IMAGE_PASS_PUBLIC_OFFER = /* @__PURE__ */ Object.freeze({
	...IMAGE_PASS_OFFER_SUMMARY,
	allowedSkuKeys: IMAGE_PASS_ALLOWED_SKU_KEYS as readonly ImageSkuKey[],
} as const);

/**
 * Frozen terms of passes sold before the size restriction. Grants keep the
 * snapshot they were paid under (image_pass_grant.offerSnapshot), so these
 * buyers keep every size; checkout intents opened under it can still settle.
 */
export const IMAGE_PASS_LEGACY_OFFER = /* @__PURE__ */ Object.freeze({
	offerKey: "image-pass-3",
	offerVersion: IMAGE_PASS_LEGACY_OFFER_VERSION,
	provider: "paypal",
	amount: "1.00",
	currency: "USD",
	units: 3,
	allowedSkuKeys: /* @__PURE__ */ Object.freeze([
		"nano-banana-2-lite-1k",
		"nano-banana-default",
		"nano-banana-2-1k",
		"nano-banana-2-2k",
		"nano-banana-2-4k",
		"nano-banana-pro-1k",
		"nano-banana-pro-2k",
		"nano-banana-pro-4k",
		"gpt-image-1-5-medium",
		"gpt-image-1-5-high",
		"gpt-image-2-1k",
		"gpt-image-2-2k",
		"gpt-image-2-4k",
		"gpt-image-2-5-flare-1k",
		"gpt-image-2-5-flare-2k",
		"gpt-image-2-5-flare-4k",
		"gpt-image-2-5-sunburst-1k",
		"gpt-image-2-5-sunburst-2k",
		"gpt-image-2-5-sunburst-4k",
		"seedream-4-1k",
		"seedream-4-2k",
		"seedream-4-4k",
		"seedream-4-5-basic-2k",
		"seedream-4-5-high-4k",
		"seedream-5-lite-basic-2k",
		"seedream-5-lite-high-3k",
		"seedream-5-lite-ultra-4k",
		"seedream-5-pro-basic-1k",
		"seedream-5-pro-high-2k",
	] as const),
} as const);

const KNOWN_IMAGE_PASS_OFFERS = [IMAGE_PASS_PUBLIC_OFFER, IMAGE_PASS_LEGACY_OFFER] as const;

export function isImagePassSkuAllowed(skuKey: unknown): boolean {
	return (
		typeof skuKey === "string" &&
		(IMAGE_PASS_ALLOWED_SKU_KEYS as readonly string[]).includes(skuKey)
	);
}

export type ImagePassOfferSnapshot = Omit<
	(typeof KNOWN_IMAGE_PASS_OFFERS)[number],
	"allowedSkuKeys"
> & { allowedSkuKeys: readonly string[] };

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
	if (!Array.isArray(allowedSkuKeys)) return false;
	return KNOWN_IMAGE_PASS_OFFERS.some(
		(offer) =>
			snapshot.offerKey === offer.offerKey &&
			snapshot.offerVersion === offer.offerVersion &&
			snapshot.provider === "paypal" &&
			snapshot.amount === "1.00" &&
			snapshot.currency === "USD" &&
			snapshot.units === 3 &&
			allowedSkuKeys.length === offer.allowedSkuKeys.length &&
			offer.allowedSkuKeys.every((key, index) => allowedSkuKeys[index] === key),
	);
}
