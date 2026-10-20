import { describe, expect, it } from "vitest";

import { isWaffoBillingPlanReference, resolveWaffoProductId } from "./waffo-price-reference";

const productId = "PROD_0123456789AbCdEfGhIjKl";
// Synthetic identifiers below are isolated test fixtures, never provider operation targets.
const versionId = "fixture-version-2";
const key = `waffo:${productId}:${versionId}`;
const metadata = {
	waffoProductId: productId,
	waffoProductVersionId: versionId,
	waffoProductVersionNumber: 2,
	waffoTaxCategory: "saas",
};

describe("Waffo immutable local price references", () => {
	it("resolves both historical native keys and explicit real-version bindings", () => {
		expect(resolveWaffoProductId(productId)).toBe(productId);
		expect(resolveWaffoProductId(key)).toBe(productId);
		expect(isWaffoBillingPlanReference(productId, {})).toBe(true);
		expect(isWaffoBillingPlanReference(key, metadata)).toBe(true);
	});
	it.each([
		{},
		{ ...metadata, waffoProductId: "PROD_0123456789QrStUvWxYzAb" },
		{ ...metadata, waffoProductVersionId: "another-version" },
		{ ...metadata, waffoProductVersionNumber: 0 },
		{ ...metadata, waffoProductVersionNumber: "2" },
		{ ...metadata, waffoTaxCategory: "digital_goods" },
	])("rejects a qualified key without its exact immutable provenance %#", (candidate) => {
		expect(isWaffoBillingPlanReference(key, candidate)).toBe(false);
	});
	it.each([
		`waffo:${productId}:`,
		`waffo:${productId}:latest`,
		`waffo:${productId}:v:2`,
		"PROD_invalid",
	])("rejects ambiguous or malformed reference %s", (candidate) =>
		expect(() => resolveWaffoProductId(candidate)).toThrow("WAFFO_PRICE_REFERENCE_INVALID"),
	);
});
