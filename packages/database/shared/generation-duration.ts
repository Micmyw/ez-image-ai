import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_SKU_KEYS_BY_PRODUCT,
	imageSkuKeySchema,
} from "@repo/config/client";
import { z } from "zod";

export const GENERATION_DURATION_MINIMUM_SAMPLES = 5;
export const GENERATION_DURATION_MAXIMUM_SAMPLES = 200;
export const GENERATION_DURATION_FRESHNESS_MS = 24 * 60 * 60_000;

export const generationDurationInputSchema = z
	.object({
		productKey: z.enum(EZPIC_PRODUCT_KEYS),
		skuKey: imageSkuKeySchema,
		serviceClass: z.enum(["STANDARD", "GUEST_SLOW"]).default("STANDARD"),
	})
	.strict()
	.refine(
		(value) =>
			(IMAGE_SKU_KEYS_BY_PRODUCT[value.productKey] as readonly string[]).includes(value.skuKey),
		{
			message: "SKU does not belong to the selected product",
			path: ["skuKey"],
		},
	);

export const generationDurationOutputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("processing") }).strict(),
	z
		.object({
			kind: z.literal("range"),
			minimumSeconds: z.number().int().positive(),
			maximumSeconds: z.number().int().positive(),
			sampleSize: z
				.number()
				.int()
				.min(GENERATION_DURATION_MINIMUM_SAMPLES)
				.max(GENERATION_DURATION_MAXIMUM_SAMPLES),
			asOf: z.iso.datetime(),
			latestSampleAt: z.iso.datetime(),
			percentiles: z.literal("p50-p90"),
			windowHours: z.literal(168),
			cohort: z.literal("completed-tasks-excluding-marked-internal"),
		})
		.strict()
		.refine((value) => value.maximumSeconds >= value.minimumSeconds),
]);

export type GenerationDurationInput = z.infer<typeof generationDurationInputSchema>;
export type GenerationDurationEstimate = z.infer<typeof generationDurationOutputSchema>;

/** Values describe whole completed tasks, never the remaining duration of an active task. */
export function isFreshGenerationDurationEstimate(
	value: GenerationDurationEstimate,
	now = Date.now(),
): value is Extract<GenerationDurationEstimate, { kind: "range" }> {
	if (value.kind !== "range") return false;
	const asOf = Date.parse(value.asOf);
	const latest = Date.parse(value.latestSampleAt);
	return (
		Number.isFinite(asOf) &&
		Number.isFinite(latest) &&
		asOf <= now + 60_000 &&
		latest <= asOf &&
		now - asOf <= GENERATION_DURATION_FRESHNESS_MS &&
		now - latest <= GENERATION_DURATION_FRESHNESS_MS
	);
}
