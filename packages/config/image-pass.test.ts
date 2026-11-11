import { describe, it, expect, vi } from "vitest";

import {
	getImagePassOfferSnapshot,
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
	imagePassEffectiveSkuKeys,
	imagePassCoversSelection,
	isImagePassBenefitPolicy,
	isImagePassOfferSnapshot,
	isImagePassSkuAllowed,
	imagePassIncludesModelAccess,
	IMAGE_PASS_ALLOWED_SKU_KEYS,
	IMAGE_PASS_LEGACY_OFFER,
	IMAGE_PASS_STANDARD_OFFER,
} from "./image-pass";
import { IMAGE_PASS_OFFER_SUMMARY } from "./image-pass-summary";
import {
	isImagePassBillingPlan,
	imagePassBillingPlanMatchesOffer,
	imagePassOfferAmountMicros,
	IMAGE_PASS_AMOUNT_MICROS,
	IMAGE_PASS_PAYPAL_SKU,
	LEGACY_IMAGE_PASS_AMOUNT_MICROS,
	LEGACY_IMAGE_PASS_PAYPAL_SKU,
} from "./image-pass.server";
import { IMAGE_SKU_KEYS } from "./product";

const oldOffers = [IMAGE_PASS_LEGACY_OFFER, IMAGE_PASS_STANDARD_OFFER];
const currentPlan = {
	provider: "paypal",
	providerPriceId: IMAGE_PASS_PAYPAL_SKU,
	productKind: "IMAGE_PASS",
	name: "image-pass-3",
	priceMicros: IMAGE_PASS_AMOUNT_MICROS,
	currency: "USD",
	creditsPerPeriod: 0n,
	metadata: { imagePassOfferSnapshot: getImagePassOfferSnapshot() },
};
const oldPlan = {
	...currentPlan,
	providerPriceId: LEGACY_IMAGE_PASS_PAYPAL_SKU,
	priceMicros: LEGACY_IMAGE_PASS_AMOUNT_MICROS,
	metadata: { imagePassOfferSnapshot: IMAGE_PASS_LEGACY_OFFER },
};

describe("USD 2.99 three-image offer and immutable historical purchases", () => {
	it("separates public display metadata from the model-access authorization snapshot", () => {
		const { allowedSkuKeys, subscriptionPolicy, ...summary } = getImagePassOfferSnapshot();
		expect(summary).toEqual(IMAGE_PASS_OFFER_SUMMARY);
		expect(allowedSkuKeys).toEqual(IMAGE_PASS_ALLOWED_SKU_KEYS);
		expect(subscriptionPolicy).toBe("not-required");
	});
	it("retains its frozen 29 SKUs for USD 2.99 and excludes newer models", () => {
		const offer = getImagePassOfferSnapshot();
		expect(offer).toMatchObject({
			provider: "paypal",
			amount: "2.99",
			currency: "USD",
			units: 3,
			offerVersion: "2026-11-04.2",
		});
		expect(offer.allowedSkuKeys).toEqual(IMAGE_PASS_LEGACY_OFFER.allowedSkuKeys);
		expect(imagePassIncludesModelAccess(JSON.parse(JSON.stringify(offer)))).toBe(true);
		for (const key of offer.allowedSkuKeys) expect(isImagePassSkuAllowed(key), key).toBe(true);
		const newSkus = IMAGE_SKU_KEYS.filter((key) => key.startsWith("gpt-image-2-6-"));
		expect(newSkus).toHaveLength(6);
		for (const key of newSkus) {
			expect(isImagePassSkuAllowed(key), key).toBe(false);
			for (const historical of oldOffers) expect(historical.allowedSkuKeys).not.toContain(key);
		}
		expect(isImagePassSkuAllowed("future-model-8k")).toBe(false);
		expect(isImagePassSkuAllowed(undefined)).toBe(false);
		offer.allowedSkuKeys.pop();
		expect(getImagePassOfferSnapshot().allowedSkuKeys).toHaveLength(29);
	});
	it.each(oldOffers)("retains old $offerVersion price and access requirements", (offer) => {
		const snapshot = JSON.parse(JSON.stringify(offer));
		expect(isImagePassOfferSnapshot(snapshot)).toBe(true);
		expect(imagePassIncludesModelAccess(snapshot)).toBe(false);
		expect(imagePassOfferAmountMicros(snapshot)).toBe(1_000_000n);
		expect(isImagePassOfferSnapshot({ ...snapshot, subscriptionPolicy: "not-required" })).toBe(
			false,
		);
		expect(isImagePassOfferSnapshot({ ...snapshot, amount: "2.99" })).toBe(false);
	});
	it("freezes each historical list independently", () => {
		expect(IMAGE_PASS_LEGACY_OFFER.allowedSkuKeys).toHaveLength(29);
		expect(IMAGE_PASS_STANDARD_OFFER.allowedSkuKeys).toHaveLength(15);
		expect(IMAGE_PASS_STANDARD_OFFER.allowedSkuKeys).not.toContain("nano-banana-pro-4k");
		expect(
			isImagePassOfferSnapshot({
				...IMAGE_PASS_STANDARD_OFFER,
				allowedSkuKeys: [...IMAGE_SKU_KEYS],
			}),
		).toBe(false);
		expect(
			isImagePassOfferSnapshot({
				...getImagePassOfferSnapshot(),
				allowedSkuKeys: IMAGE_PASS_STANDARD_OFFER.allowedSkuKeys,
			}),
		).toBe(false);
	});
	it("keeps purchased snapshots valid without silently adding a future catalog model", async () => {
		const paid = [...oldOffers, getImagePassOfferSnapshot()].map((x) =>
			JSON.parse(JSON.stringify(x)),
		);
		vi.resetModules();
		vi.doMock("./product", async (original) => ({
			...(await original<typeof import("./product")>()),
			IMAGE_SKU_KEYS: [...IMAGE_SKU_KEYS, "future-image-8k"],
		}));
		try {
			const future = await import("./image-pass");
			for (const offer of paid) expect(future.isImagePassOfferSnapshot(offer)).toBe(true);
			expect(future.IMAGE_PASS_ALLOWED_SKU_KEYS).not.toContain("future-image-8k");
		} finally {
			vi.doUnmock("./product");
			vi.resetModules();
		}
	});
	it.each([
		{ amount: "1.00" },
		{ currency: "EUR" },
		{ units: 75 },
		{ provider: "waffo" },
		{ offerVersion: "future" },
		{ allowedSkuKeys: [] },
		{ subscriptionPolicy: undefined },
		{ subscriptionPolicy: "required" },
	])("rejects forged current offer %j", (patch) => {
		const snapshot = { ...getImagePassOfferSnapshot(), ...patch };
		expect(isImagePassOfferSnapshot(snapshot)).toBe(false);
		expect(imagePassIncludesModelAccess(snapshot)).toBe(false);
		expect(imagePassOfferAmountMicros(snapshot)).toBeNull();
	});
	it("matches new billing plan to new offer only, granting no credits", () => {
		expect(isImagePassBillingPlan(currentPlan)).toBe(true);
		expect(imagePassBillingPlanMatchesOffer(currentPlan, getImagePassOfferSnapshot())).toBe(true);
		expect(imagePassOfferAmountMicros(getImagePassOfferSnapshot())).toBe(2_990_000n);
		for (const offer of oldOffers)
			expect(imagePassBillingPlanMatchesOffer(currentPlan, offer)).toBe(false);
	});
	it("supports both historical $1 offers sharing the original provisioned plan", () => {
		expect(isImagePassBillingPlan(oldPlan)).toBe(true);
		for (const offer of oldOffers)
			expect(imagePassBillingPlanMatchesOffer(oldPlan, offer)).toBe(true);
		expect(imagePassBillingPlanMatchesOffer(oldPlan, getImagePassOfferSnapshot())).toBe(false);
	});
	it.each([
		{ provider: "waffo" },
		{ providerPriceId: LEGACY_IMAGE_PASS_PAYPAL_SKU },
		{ priceMicros: 1_000_000n },
		{ currency: "EUR" },
		{ creditsPerPeriod: 75n },
		{ productKind: "CREDIT_PACK" },
		{ metadata: {} },
		{ metadata: { imagePassOfferSnapshot: IMAGE_PASS_LEGACY_OFFER } },
	])("rejects mixed price/identity plan %s", (patch) => {
		expect(isImagePassBillingPlan({ ...currentPlan, ...patch })).toBe(false);
	});
});

describe("versioned GPT Image 2.6 image-pass benefit", () => {
	const policy = IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY;
	it("extends only valid USD 2.99 grants without changing their 29-SKU purchase", () => {
		const paidSnapshot = getImagePassOfferSnapshot();
		const before = JSON.stringify(paidSnapshot);
		expect(imagePassEffectiveSkuKeys(paidSnapshot, policy)).toHaveLength(35);
		expect(imagePassEffectiveSkuKeys(paidSnapshot)).toHaveLength(29);
		expect(JSON.stringify(paidSnapshot)).toBe(before);
		for (const old of oldOffers) {
			expect(imagePassEffectiveSkuKeys(old, policy)).toEqual(old.allowedSkuKeys);
			for (const skuKey of policy.addedSkuKeys)
				expect(
					imagePassCoversSelection({ offerSnapshot: old, skuKey, benefitPolicy: policy }),
				).toBe(false);
		}
	});
	it.each([
		{ version: "unknown" },
		{ eligibleOfferVersion: "2026-10-19.1" },
		{ addedSkuKeys: [...policy.addedSkuKeys, "future-model"] },
		{ addedSkuKeys: [...policy.addedSkuKeys].reverse() },
		{ outputFormats: ["png", "jpeg", "svg", "gif", "mp4"] },
		{ unitsPerSuccessfulOutput: 0 },
		{ unexpected: true },
	])("fails closed on forged benefit %j", (patch) => {
		const forged = { ...policy, ...patch };
		expect(isImagePassBenefitPolicy(forged)).toBe(false);
		expect(imagePassEffectiveSkuKeys(getImagePassOfferSnapshot(), forged)).toEqual([]);
	});
	it.each([
		{ amount: "1.00" },
		{ allowedSkuKeys: [...policy.addedSkuKeys] },
		{ units: 10 },
		{ subscriptionPolicy: "required" },
	])("requires the complete original offer %j", (patch) => {
		expect(imagePassEffectiveSkuKeys({ ...getImagePassOfferSnapshot(), ...patch }, policy)).toEqual(
			[],
		);
	});
	it("accepts exactly static 1K/2K/4K and supported 1K SVG/GIF results", () => {
		for (const skuKey of policy.addedSkuKeys) {
			for (const outputFormat of ["png", "jpeg", "svg", "gif", "mp4"]) {
				expect(
					imagePassCoversSelection({
						offerSnapshot: getImagePassOfferSnapshot(),
						skuKey,
						benefitPolicy: policy,
						outputFormat,
					}),
				).toBe(
					["png", "jpeg"].includes(outputFormat) ||
						(skuKey.endsWith("-1k") && ["svg", "gif"].includes(outputFormat)),
				);
			}
			expect(imagePassCoversSelection({ offerSnapshot: getImagePassOfferSnapshot(), skuKey })).toBe(
				false,
			);
		}
		expect(isImagePassBenefitPolicy(JSON.parse(JSON.stringify(policy)))).toBe(true);
	});
});
