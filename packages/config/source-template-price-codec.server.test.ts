import { describe, expect, it } from "vitest";

import {
	decodeSourceTemplatePrice,
	encodeSourceTemplatePrices,
	type SourceTemplateFullPrice,
} from "./source-template-price-codec.server";
import { sourceTemplateProvisionSchema } from "./video-template-execution.server";

const basis = (count: number) =>
	JSON.stringify({
		version: "fixture",
		description: "Shared evidence only; no price arithmetic. ".repeat(30),
		moderation: { userImages: count, cost: String(count), audio: "not_requested" },
		retail: { policy: { markup: "20000", cost: String(count) }, paidRevenueQualified: false },
		text: 'Unicode 字符, quote " slash \\ and newline\n stay identical.',
	});
const price = (count: number, pricingBasis = basis(count)): SourceTemplateFullPrice => ({
	options: { durationSeconds: count + 5 },
	credits: String(count + 1),
	providerCostMicros: "123456",
	moderationCostMicros: String(count),
	pricingVersion: "existing-version",
	pricingBasis,
});
const provision = (pricing: ReturnType<typeof encodeSourceTemplatePrices>) => ({
	version: "unchanged-contract",
	enabled: false,
	access: "internal",
	sourceConfig: {},
	references: [],
	...pricing,
});
const reorderObjects = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(reorderObjects);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => b.localeCompare(a))
				.map(([key, item]) => [key, reorderObjects(item)]),
		);
	return value;
};

describe("source-template lossless provision price evidence codec", () => {
	it("deduplicates shared leaves and duplicate variants without changing any expanded price", () => {
		const prices = [price(0), price(1), price(2), price(0), price(1)];
		const original = structuredClone(prices);
		const encoded = encodeSourceTemplatePrices(prices);
		expect(encoded.pricingSchemaVersion).toBe(2);
		expect(encoded.pricingBasisDictionary?.overrides).toHaveLength(3);
		expect(encoded.pricingBasisDictionary?.overrides[1]).toEqual({
			moderation: { userImages: 1, cost: "1" },
			retail: { policy: { cost: "1" } },
		});
		expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify({ prices }).length / 2);
		expect(encoded.prices.map((item) => decodeSourceTemplatePrice(encoded, item))).toEqual(prices);
		expect(prices).toEqual(original);
	});
	it("preserves exact evidence key order after database JSONB-style object reordering", () => {
		const prices = [price(0), price(1), price(2)];
		const stored = sourceTemplateProvisionSchema.parse(
			reorderObjects(provision(encodeSourceTemplatePrices(prices))),
		);
		expect(typeof stored.pricingBasisDictionary?.base).toBe("string");
		expect(stored.prices.map((item) => decodeSourceTemplatePrice(stored, item))).toEqual(prices);
	});
	it("schema loading retains compact rows and never expands the dictionary into each price", () => {
		const stored = sourceTemplateProvisionSchema.parse(
			provision(encodeSourceTemplatePrices([price(0), price(1)])),
		);
		expect(
			stored.prices.every((item) => "pricingBasisRef" in item && !("pricingBasis" in item)),
		).toBe(true);
		expect(stored.pricingBasisDictionary?.overrides).toHaveLength(2);
	});
	it("decodes only the selected variant without reading unrelated evidence", () => {
		const encoded = encodeSourceTemplatePrices([price(0), price(1)]);
		Object.defineProperty(encoded.pricingBasisDictionary!.overrides, 0, {
			get: () => {
				throw new Error("UNSELECTED_PRICE_EXPANDED");
			},
		});
		expect(decodeSourceTemplatePrice(encoded, encoded.prices[1]!)).toEqual(price(1));
	});
	it("keeps legacy text, formatting, key order, and unsupported arrays byte-for-byte", () => {
		const legacy = [
			price(0, "legacy operator evidence"),
			price(1, '{ "a" : 1 }'),
			price(2, '{"list":[{"b":1,"a":2}]}'),
		];
		expect(encodeSourceTemplatePrices(legacy)).toEqual({ prices: legacy });
		const mixed = encodeSourceTemplatePrices([
			price(0),
			price(1),
			...legacy,
			price(3, JSON.stringify({ ...JSON.parse(basis(3)), newlyAddedField: "preserve" })),
		]);
		expect(mixed.pricingSchemaVersion).toBe(2);
		expect(mixed.prices.map((item) => decodeSourceTemplatePrice(mixed, item))).toEqual([
			price(0),
			price(1),
			...legacy,
			price(3, JSON.stringify({ ...JSON.parse(basis(3)), newlyAddedField: "preserve" })),
		]);
		const parsed = sourceTemplateProvisionSchema.parse(provision({ prices: legacy }));
		expect(parsed).not.toHaveProperty("pricingSchemaVersion");
		expect(decodeSourceTemplatePrice(parsed, parsed.prices[0]!)).toBe(parsed.prices[0]);
	});
	it("keeps a single-row table in legacy form when the dictionary would add bytes", () => {
		expect(encodeSourceTemplatePrices([price(0)])).toEqual({ prices: [price(0)] });
		expect(encodeSourceTemplatePrices([])).toEqual({ prices: [] });
	});
	it("rejects invalid references, mixed full/reference rows, missing dictionaries and future formats", () => {
		const encoded = encodeSourceTemplatePrices([price(0), price(1)]);
		for (const changed of [
			{ ...encoded, pricingSchemaVersion: undefined },
			{ ...encoded, pricingSchemaVersion: 3 },
			{ ...encoded, pricingBasisDictionary: undefined },
			{ ...encoded, prices: [{ ...encoded.prices[0], pricingBasisRef: 2 }] },
			{ ...encoded, prices: [{ ...encoded.prices[0], pricingBasisRef: -1 }] },
			{ ...encoded, prices: [{ ...encoded.prices[0], pricingBasisRef: 0.5 }] },
			{ ...encoded, prices: [{ ...encoded.prices[0], pricingBasis: "ambiguous" }] },
		])
			expect(
				sourceTemplateProvisionSchema.safeParse(provision(changed as typeof encoded)).success,
			).toBe(false);
	});
	it("rejects overrides that add keys or change node types, and prototype-bearing evidence", () => {
		const encoded = encodeSourceTemplatePrices([price(0), price(1)]);
		for (const patch of [
			{ invented: 1 },
			{ moderation: "replace-object" },
			{ moderation: { userImages: "wrong-type" } },
			JSON.parse('{"__proto__":{"polluted":true}}'),
		]) {
			const changed = {
				...encoded,
				pricingBasisDictionary: { ...encoded.pricingBasisDictionary!, overrides: [patch] },
			};
			expect(sourceTemplateProvisionSchema.safeParse(provision(changed)).success).toBe(false);
		}
		expect(() => decodeSourceTemplatePrice({}, encoded.prices[0]!)).toThrow(
			"VIDEO_TEMPLATE_PRICE_DICTIONARY_INVALID",
		);
	});
});
