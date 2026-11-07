import { z } from "zod";

import type { SourceTemplateChoices } from "./video-template-library";

/** Public option identity shared with authoritative pricing; no prompts or supplier costs. */
export function sourceTemplatePriceKey(options: SourceTemplateChoices): string {
	return JSON.stringify([
		options.tier ?? null,
		options.preset ?? null,
		options.durationSeconds ?? null,
		options.resolution ?? null,
		options.aspectRatio ?? null,
	]);
}

export const sourceTemplateDisplayPricingSchema = z
	.object({
		version: z.number().int().positive(),
		creditsByOptions: z.record(z.string().max(200), z.string().regex(/^[1-9]\d{0,17}$/)),
	})
	.strict();
export type SourceTemplateDisplayPricing = z.infer<typeof sourceTemplateDisplayPricingSchema>;

/** Display only. A cached amount never authorizes a job or a credit reservation. */
export function sourceTemplateDisplayCredits(
	pricing: SourceTemplateDisplayPricing | null | undefined,
	options: SourceTemplateChoices,
) {
	return pricing?.creditsByOptions[sourceTemplatePriceKey(options)] ?? null;
}
