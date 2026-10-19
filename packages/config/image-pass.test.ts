import { describe, it, expect } from "vitest";

import { getImagePassOfferSnapshot, isImagePassOfferSnapshot } from "./image-pass";
import { IMAGE_PASS_OFFER_SUMMARY } from "./image-pass-summary";
import {
	isImagePassBillingPlan,
	IMAGE_PASS_AMOUNT_MICROS,
	IMAGE_PASS_PAYPAL_SKU,
} from "./image-pass.server";
import { IMAGE_SKU_KEYS } from "./product";

describe("one-dollar three-image offer", () => {
	it("keeps display metadata separate from the unchanged authorization snapshot", () => {
		const { allowedSkuKeys, ...summary } = getImagePassOfferSnapshot();
		expect(IMAGE_PASS_OFFER_SUMMARY).toEqual(summary);
		expect(IMAGE_PASS_OFFER_SUMMARY).not.toHaveProperty("allowedSkuKeys");
		expect(allowedSkuKeys).toEqual(IMAGE_SKU_KEYS);
	});
	it("freezes all current image SKUs as three successful images, using JSON-safe public data", () => {
		const offer = getImagePassOfferSnapshot();
		expect(offer).toMatchObject({ provider: "paypal", amount: "1.00", currency: "USD", units: 3 });
		expect(offer.allowedSkuKeys).toEqual(IMAGE_SKU_KEYS);
		expect(offer.allowedSkuKeys).toHaveLength(29);
		expect(isImagePassOfferSnapshot(JSON.parse(JSON.stringify(offer)))).toBe(true);
		offer.allowedSkuKeys.pop();
		expect(getImagePassOfferSnapshot().allowedSkuKeys).toHaveLength(29);
	});
	it.each([
		{ amount: "0.01" },
		{ currency: "EUR" },
		{ units: 75 },
		{ provider: "waffo" },
		{ offerVersion: "future" },
		{ allowedSkuKeys: [] },
	])("rejects a mutated snapshot %j", (patch) => {
		expect(isImagePassOfferSnapshot({ ...getImagePassOfferSnapshot(), ...patch })).toBe(false);
	});
	const plan = {
		provider: "paypal",
		providerPriceId: IMAGE_PASS_PAYPAL_SKU,
		productKind: "IMAGE_PASS",
		name: "image-pass-3",
		priceMicros: IMAGE_PASS_AMOUNT_MICROS,
		currency: "USD",
		creditsPerPeriod: 0n,
		metadata: { imagePassOfferSnapshot: getImagePassOfferSnapshot() },
	};
	it("uses a dedicated merchant SKU and grants zero ordinary credits", () =>
		expect(isImagePassBillingPlan(plan)).toBe(true));
	it.each([
		{ provider: "waffo" },
		{ providerPriceId: "other" },
		{ priceMicros: 100n },
		{ currency: "EUR" },
		{ creditsPerPeriod: 75n },
		{ productKind: "CREDIT_PACK" },
		{ metadata: {} },
	])("rejects a mismatched billing plan %s", (patch) => {
		expect(isImagePassBillingPlan({ ...plan, ...patch })).toBe(false);
	});
});
