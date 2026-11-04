import { describe, it, expect } from "vitest";

import {
	getImagePassOfferSnapshot,
	isImagePassOfferSnapshot,
	isImagePassSkuAllowed,
	IMAGE_PASS_ALLOWED_SKU_KEYS,
	IMAGE_PASS_LEGACY_OFFER,
} from "./image-pass";
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
		expect(allowedSkuKeys).toEqual(IMAGE_PASS_ALLOWED_SKU_KEYS);
	});
	it("freezes the 1K/2K image SKUs as three successful images, using JSON-safe public data", () => {
		const offer = getImagePassOfferSnapshot();
		expect(offer).toMatchObject({
			provider: "paypal",
			amount: "1.00",
			currency: "USD",
			units: 3,
			offerVersion: "2026-11-04.1",
		});
		expect(offer.allowedSkuKeys).toEqual(IMAGE_PASS_ALLOWED_SKU_KEYS);
		expect(offer.allowedSkuKeys).toHaveLength(15);
		expect(isImagePassOfferSnapshot(JSON.parse(JSON.stringify(offer)))).toBe(true);
		offer.allowedSkuKeys.pop();
		expect(getImagePassOfferSnapshot().allowedSkuKeys).toHaveLength(15);
	});
	it("excludes every 4K/3K size, every Pro model and GPT Image 1.5 high", () => {
		const excluded = IMAGE_SKU_KEYS.filter((key) => !isImagePassSkuAllowed(key));
		for (const key of IMAGE_SKU_KEYS) {
			const highCost = /-(4k|3k)$/.test(key) || /pro/.test(key) || key === "gpt-image-1-5-high";
			expect(isImagePassSkuAllowed(key), key).toBe(!highCost);
		}
		expect(excluded).toEqual(
			expect.arrayContaining([
				"nano-banana-2-4k",
				"nano-banana-pro-1k",
				"nano-banana-pro-2k",
				"nano-banana-pro-4k",
				"gpt-image-2-4k",
				"seedream-5-lite-high-3k",
				"seedream-5-pro-basic-1k",
				"gpt-image-1-5-high",
			]),
		);
		for (const key of IMAGE_PASS_ALLOWED_SKU_KEYS) expect(key).not.toMatch(/4k|3k|pro/);
		expect(isImagePassSkuAllowed("nano-banana-2-2k")).toBe(true);
		expect(isImagePassSkuAllowed(undefined)).toBe(false);
	});
	it("still accepts the pre-restriction snapshot so earlier buyers keep every size", () => {
		const legacy = JSON.parse(JSON.stringify(IMAGE_PASS_LEGACY_OFFER));
		expect(legacy.offerVersion).toBe("2026-10-19.1");
		expect(legacy.allowedSkuKeys).toEqual(IMAGE_SKU_KEYS);
		expect(isImagePassOfferSnapshot(legacy)).toBe(true);
		// A legacy version cannot be combined with the new list or vice versa.
		expect(
			isImagePassOfferSnapshot({ ...legacy, allowedSkuKeys: [...IMAGE_PASS_ALLOWED_SKU_KEYS] }),
		).toBe(false);
		expect(
			isImagePassOfferSnapshot({
				...getImagePassOfferSnapshot(),
				allowedSkuKeys: [...IMAGE_SKU_KEYS],
			}),
		).toBe(false);
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
	it("keeps the provisioned billing plan valid while its metadata holds the legacy snapshot", () =>
		expect(
			isImagePassBillingPlan({
				...plan,
				metadata: { imagePassOfferSnapshot: JSON.parse(JSON.stringify(IMAGE_PASS_LEGACY_OFFER)) },
			}),
		).toBe(true));
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
