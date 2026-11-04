import {
	IMAGE_PASS_LEGACY_OFFER_VERSION,
	IMAGE_PASS_STANDARD_OFFER_VERSION,
	IMAGE_PASS_OFFER_SUMMARY,
} from "./image-pass-summary";
import type { ImageSkuKey } from "./product";

/**
 * Frozen sizes of the $1 Image Pass offer 2026-11-04.1:
 * standard 1K/2K outputs only. Every 4K/3K tier, every Pro model and the
 * high-quality GPT Image 1.5 tier stay on credits.
 */
export const IMAGE_PASS_STANDARD_ALLOWED_SKU_KEYS = /* @__PURE__ */ Object.freeze([
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

/** Frozen prior USD 1 standard-size offer, with its original subscription policy. */
export const IMAGE_PASS_STANDARD_OFFER = /* @__PURE__ */ Object.freeze({
	offerKey: "image-pass-3",
	offerVersion: IMAGE_PASS_STANDARD_OFFER_VERSION,
	provider: "paypal",
	amount: "1.00",
	currency: "USD",
	units: 3,
	allowedSkuKeys: IMAGE_PASS_STANDARD_ALLOWED_SKU_KEYS,
} as const);

/** Explicit current catalog at purchase time; future catalog additions need a new offer. */
export const IMAGE_PASS_ALLOWED_SKU_KEYS = /* @__PURE__ */ Object.freeze([
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
] as const satisfies readonly ImageSkuKey[]);

/** Successful images only. Includes model access, not general subscription benefits. */
export const IMAGE_PASS_PUBLIC_OFFER = /* @__PURE__ */ Object.freeze({
	...IMAGE_PASS_OFFER_SUMMARY,
	subscriptionPolicy: "not-required",
	allowedSkuKeys: IMAGE_PASS_ALLOWED_SKU_KEYS,
} as const);

const KNOWN_IMAGE_PASS_OFFERS = [
	IMAGE_PASS_PUBLIC_OFFER,
	IMAGE_PASS_STANDARD_OFFER,
	IMAGE_PASS_LEGACY_OFFER,
] as const;

export function isImagePassSkuAllowed(skuKey: unknown): boolean {
	return (
		typeof skuKey === "string" &&
		(IMAGE_PASS_ALLOWED_SKU_KEYS as readonly string[]).includes(skuKey)
	);
}

type FrozenOfferSnapshot<T> = T extends { allowedSkuKeys: readonly string[] }
	? Omit<T, "allowedSkuKeys"> & { allowedSkuKeys: readonly string[] }
	: never;
export type ImagePassOfferSnapshot = FrozenOfferSnapshot<(typeof KNOWN_IMAGE_PASS_OFFERS)[number]>;

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
			snapshot.amount === offer.amount &&
			snapshot.currency === "USD" &&
			snapshot.units === 3 &&
			snapshot.subscriptionPolicy ===
				("subscriptionPolicy" in offer ? offer.subscriptionPolicy : undefined) &&
			allowedSkuKeys.length === offer.allowedSkuKeys.length &&
			offer.allowedSkuKeys.every((key, index) => allowedSkuKeys[index] === key),
	);
}

/** Only a strictly validated new-offer snapshot can waive model subscription access. */
export function imagePassIncludesModelAccess(value: unknown): boolean {
	return (
		isImagePassOfferSnapshot(value) &&
		value.offerVersion === IMAGE_PASS_PUBLIC_OFFER.offerVersion &&
		value.subscriptionPolicy === "not-required"
	);
}
