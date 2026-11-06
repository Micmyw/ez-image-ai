import { z } from "zod";

type JsonValue = null | boolean | number | string | JsonObject;
type JsonObject = { [key: string]: JsonValue };
const object = (value: unknown): value is JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);
const json: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.record(z.string().refine(safeKey), json),
	]),
);
const jsonObject = z.record(z.string().refine(safeKey), json);

export const sourceTemplateOptionsSchema = z
	.record(
		z.string().min(1).max(80),
		z.union([z.string().max(12000), z.number().finite(), z.boolean()]),
	)
	.default({});
export const sourceTemplateFullPriceSchema = z
	.object({
		options: sourceTemplateOptionsSchema,
		credits: z.string().regex(/^[1-9]\d{0,17}$/),
		providerCostMicros: z.string().regex(/^[1-9]\d{0,17}$/),
		moderationCostMicros: z.string().regex(/^\d{1,18}$/),
		pricingVersion: z.string().min(1),
		pricingBasis: z.string().min(1),
	})
	.strict();
const referencePriceSchema = sourceTemplateFullPriceSchema
	.omit({ pricingBasis: true })
	.extend({
		pricingBasisRef: z.number().int().nonnegative(),
	})
	.strict();
export const sourceTemplateStoredPriceSchema = z.union([
	sourceTemplateFullPriceSchema,
	referencePriceSchema,
]);

/** Sparse objects replace existing leaves only. No deletion, key insertion, or key reordering. */
function validOverride(base: JsonValue, override: JsonValue): boolean {
	if (object(base))
		return (
			object(override) &&
			Object.entries(override).every(
				([key, value]) =>
					safeKey(key) && Object.hasOwn(base, key) && validOverride(base[key]!, value),
			)
		);
	return base === null ? override === null : typeof base === typeof override && !object(override);
}
export const sourceTemplatePricingDictionarySchema = z
	.object({
		schemaVersion: z.literal(1),
		// Keep original object key order across PostgreSQL JSONB reordering.
		base: z.string().min(1),
		overrides: z.array(jsonObject).min(1).max(1024),
	})
	.strict()
	.refine((value) => {
		const base = canonicalObject(value.base);
		return base !== undefined && value.overrides.every((patch) => validOverride(base, patch));
	}, "VIDEO_TEMPLATE_PRICE_DICTIONARY_INVALID");
export const sourceTemplatePricingShape = {
	prices: z.array(sourceTemplateStoredPriceSchema).max(1024),
	pricingSchemaVersion: z.literal(2).optional(),
	pricingBasisDictionary: sourceTemplatePricingDictionarySchema.optional(),
};
export type SourceTemplateFullPrice = z.infer<typeof sourceTemplateFullPriceSchema>;
type StoredPrice = z.infer<typeof sourceTemplateStoredPriceSchema>;
export type SourceTemplateStoredPricing = {
	prices: StoredPrice[];
	pricingSchemaVersion?: 2;
	pricingBasisDictionary?: z.infer<typeof sourceTemplatePricingDictionarySchema>;
};

/** Validation does not construct a single expanded pricingBasis string. */
export function sourceTemplatePricingReferencesValid(value: SourceTemplateStoredPricing) {
	if (value.pricingSchemaVersion === undefined)
		return (
			value.pricingBasisDictionary === undefined &&
			value.prices.every((price) => "pricingBasis" in price)
		);
	const dictionary = value.pricingBasisDictionary;
	return Boolean(
		dictionary &&
		value.prices.every(
			(price) => "pricingBasis" in price || price.pricingBasisRef < dictionary.overrides.length,
		),
	);
}

function applyOverride(base: JsonValue, patch: JsonValue): JsonValue {
	if (!object(base) || !object(patch)) return patch;
	return Object.fromEntries(
		Object.entries(base).map(([key, value]) => [
			key,
			Object.hasOwn(patch, key) ? applyOverride(value, patch[key]!) : value,
		]),
	);
}
/** Called only after option selection. Accepted quotes still freeze the original complete string. */
export function decodeSourceTemplatePrice(
	provision: Pick<SourceTemplateStoredPricing, "pricingSchemaVersion" | "pricingBasisDictionary">,
	price: StoredPrice,
): SourceTemplateFullPrice {
	if ("pricingBasis" in price) return price;
	const dictionary = provision.pricingBasisDictionary;
	const patch = dictionary?.overrides[price.pricingBasisRef];
	if (provision.pricingSchemaVersion !== 2 || !dictionary || !patch)
		throw new Error("VIDEO_TEMPLATE_PRICE_DICTIONARY_INVALID");
	const { pricingBasisRef: _ref, ...fields } = price;
	const base = canonicalObject(dictionary.base);
	if (!base || !validOverride(base, patch))
		throw new Error("VIDEO_TEMPLATE_PRICE_DICTIONARY_INVALID");
	return { ...fields, pricingBasis: JSON.stringify(applyOverride(base, patch)) };
}

function sparseOverride(base: JsonValue, value: JsonValue): JsonValue | undefined {
	if (JSON.stringify(base) === JSON.stringify(value)) return undefined;
	if (!object(base) || !object(value)) return value;
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			const patch = sparseOverride(base[key]!, item);
			return patch === undefined ? [] : [[key, patch]];
		}),
	);
}
function canonicalObject(text: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return object(value) && JSON.stringify(value) === text && jsonObject.safeParse(value).success
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/** Offline preparation only: no arithmetic, price changes, gzip, or replacement of legacy evidence. */
export function encodeSourceTemplatePrices(
	prices: readonly SourceTemplateFullPrice[],
): SourceTemplateStoredPricing {
	const legacy = { prices: [...prices] };
	const base = prices
		.map((price) => canonicalObject(price.pricingBasis))
		.find((value) => value !== undefined);
	if (!base) return legacy;
	const overrides: JsonObject[] = [];
	const refs = new Map<string, number>();
	const storedPrices: StoredPrice[] = prices.map((price) => {
		const value = canonicalObject(price.pricingBasis);
		if (!value) return price;
		const patch = sparseOverride(base, value) ?? {};
		// The exact-string check also preserves object insertion order, number formatting and escaping.
		if (
			!object(patch) ||
			!validOverride(base, patch) ||
			JSON.stringify(applyOverride(base, patch)) !== price.pricingBasis
		)
			return price;
		const identity = JSON.stringify(patch);
		let ref = refs.get(identity);
		if (ref === undefined) {
			ref = overrides.length;
			refs.set(identity, ref);
			overrides.push(patch);
		}
		const { pricingBasis: _basis, ...fields } = price;
		return { ...fields, pricingBasisRef: ref };
	});
	if (!overrides.length) return legacy;
	const candidate: SourceTemplateStoredPricing = {
		prices: storedPrices,
		pricingSchemaVersion: 2,
		pricingBasisDictionary: { schemaVersion: 1, base: JSON.stringify(base), overrides },
	};
	// One-row and unusual legacy tables remain in their original shape if sharing adds overhead.
	return new TextEncoder().encode(JSON.stringify(candidate)).length <
		new TextEncoder().encode(JSON.stringify(legacy)).length
		? candidate
		: legacy;
}
