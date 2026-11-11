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

/** Frozen catalog at purchase time; later benefits must be versioned separately. */
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

/** Additive benefit for both existing unused and newly purchased USD 2.99 passes.
 * Never rewrite a purchase/grant snapshot; each new quote freezes this policy.
 */
export const IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY = /* @__PURE__ */ Object.freeze({
	version: "image-pass-gpt-image-2-6-v1",
	eligibleOfferVersion: "2026-11-04.2",
	addedSkuKeys: /* @__PURE__ */ Object.freeze([
		"gpt-image-2-6-flare-1k",
		"gpt-image-2-6-flare-2k",
		"gpt-image-2-6-flare-4k",
		"gpt-image-2-6-sunburst-1k",
		"gpt-image-2-6-sunburst-2k",
		"gpt-image-2-6-sunburst-4k",
	] as const satisfies readonly ImageSkuKey[]),
	outputFormats: /* @__PURE__ */ Object.freeze(["png", "jpeg", "svg", "gif"] as const),
	unitsPerSuccessfulOutput: 1,
} as const);

export function isImagePassBenefitPolicy(
	value: unknown,
): value is typeof IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const policy = value as Record<string, unknown>;
	const expected = IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY;
	const addedSkuKeys = policy.addedSkuKeys;
	const outputFormats = policy.outputFormats;
	return (
		Object.keys(policy).length === Object.keys(expected).length &&
		policy.version === expected.version &&
		policy.eligibleOfferVersion === expected.eligibleOfferVersion &&
		policy.unitsPerSuccessfulOutput === expected.unitsPerSuccessfulOutput &&
		Array.isArray(addedSkuKeys) &&
		addedSkuKeys.length === expected.addedSkuKeys.length &&
		expected.addedSkuKeys.every((key, index) => addedSkuKeys[index] === key) &&
		Array.isArray(outputFormats) &&
		outputFormats.length === expected.outputFormats.length &&
		expected.outputFormats.every((format, index) => outputFormats[index] === format)
	);
}

/** Absence preserves historical coverage; malformed/unknown policies fail closed. */
export function imagePassEffectiveSkuKeys(
	offerSnapshot: unknown,
	benefitPolicy?: unknown,
): readonly string[] {
	if (
		!isImagePassOfferSnapshot(offerSnapshot) ||
		(benefitPolicy !== undefined && !isImagePassBenefitPolicy(benefitPolicy))
	)
		return [];
	return benefitPolicy !== undefined && imagePassIncludesModelAccess(offerSnapshot)
		? [...offerSnapshot.allowedSkuKeys, ...IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY.addedSkuKeys]
		: [...offerSnapshot.allowedSkuKeys];
}

export function imagePassCoversSelection(input: {
	offerSnapshot: unknown;
	skuKey: unknown;
	benefitPolicy?: unknown;
	outputFormat?: unknown;
}): boolean {
	if (
		typeof input.skuKey !== "string" ||
		!imagePassEffectiveSkuKeys(input.offerSnapshot, input.benefitPolicy).includes(input.skuKey)
	)
		return false;
	if (
		!(IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY.addedSkuKeys as readonly string[]).includes(
			input.skuKey,
		)
	)
		return true;
	const format = input.outputFormat === undefined ? "png" : input.outputFormat;
	return (
		typeof format === "string" &&
		(IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY.outputFormats as readonly string[]).includes(format) &&
		(!["svg", "gif"].includes(format) || input.skuKey.endsWith("-1k"))
	);
}

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
