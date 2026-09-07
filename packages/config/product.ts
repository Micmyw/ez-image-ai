import { z } from "zod";

export const PLAN_IDS = ["free", "creator", "ultimate", "studio"] as const;
export const PRODUCT_MODEL_KEYS = [
	"image-fast",
	"image-quality",
	"image-nano-banana-2-lite",
	"image-nano-banana",
	"image-nano-banana-2",
	"image-nano-banana-pro",
	"image-gpt-image-1-5",
	"image-gpt-image-2",
	"image-seedream-4-5",
	"image-seedream-5-lite",
	"image-seedream-5-pro",
	"video-fast",
	"video-quality",
] as const;
export const EZPIC_PRODUCT_KEYS = [
	"image-nano-banana-2-lite",
	"image-nano-banana",
	"image-nano-banana-2",
	"image-nano-banana-pro",
	"image-gpt-image-1-5",
	"image-gpt-image-2",
	"image-seedream-4-5",
	"image-seedream-5-lite",
	"image-seedream-5-pro",
] as const;
export const LEGACY_EZPIC_PRODUCT_KEYS = ["image-fast", "image-quality"] as const;
export const IMAGE_SKU_KEYS = [
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
	"seedream-4-5-basic-2k",
	"seedream-4-5-high-4k",
	"seedream-5-lite-basic-2k",
	"seedream-5-lite-high-3k",
	"seedream-5-lite-ultra-4k",
	"seedream-5-pro-basic-1k",
	"seedream-5-pro-high-2k",
] as const;
export const IMAGE_ASPECT_RATIOS = [
	"auto",
	"1:1",
	"1:4",
	"1:8",
	"2:1",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"4:1",
	"4:5",
	"5:4",
	"8:1",
	"16:9",
	"9:16",
	"21:9",
	"1:2",
	"3:1",
	"1:3",
	"9:21",
] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg"] as const;
export const IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
export const PRODUCT_CREDIT_COSTS = {
	"image-fast": 5,
	"image-quality": 40,
	"image-nano-banana-2-lite": 5,
	"image-nano-banana": 5,
	"image-nano-banana-2": 9,
	"image-nano-banana-pro": 19,
	"image-gpt-image-1-5": 5,
	"image-gpt-image-2": 7,
	"image-seedream-4-5": 8,
	"image-seedream-5-lite": 7,
	"image-seedream-5-pro": 8,
	"video-fast": 25,
	"video-quality": 60,
} as const satisfies Record<(typeof PRODUCT_MODEL_KEYS)[number], number>;
export const IMAGE_SKU_CREDIT_COSTS = {
	"nano-banana-2-lite-1k": 5,
	"nano-banana-default": 5,
	"nano-banana-2-1k": 9,
	"nano-banana-2-2k": 13,
	"nano-banana-2-4k": 19,
	"nano-banana-pro-1k": 19,
	"nano-banana-pro-2k": 19,
	"nano-banana-pro-4k": 25,
	"gpt-image-1-5-medium": 5,
	"gpt-image-1-5-high": 23,
	"gpt-image-2-1k": 7,
	"gpt-image-2-2k": 11,
	"gpt-image-2-4k": 17,
	"seedream-4-5-basic-2k": 8,
	"seedream-4-5-high-4k": 8,
	"seedream-5-lite-basic-2k": 7,
	"seedream-5-lite-high-3k": 7,
	"seedream-5-lite-ultra-4k": 7,
	"seedream-5-pro-basic-1k": 8,
	"seedream-5-pro-high-2k": 15,
} as const satisfies Record<(typeof IMAGE_SKU_KEYS)[number], number>;

export const IMAGE_SKU_KEYS_BY_PRODUCT = {
	"image-nano-banana-2-lite": ["nano-banana-2-lite-1k"],
	"image-nano-banana": ["nano-banana-default"],
	"image-nano-banana-2": ["nano-banana-2-1k", "nano-banana-2-2k", "nano-banana-2-4k"],
	"image-nano-banana-pro": ["nano-banana-pro-1k", "nano-banana-pro-2k", "nano-banana-pro-4k"],
	"image-gpt-image-1-5": ["gpt-image-1-5-medium", "gpt-image-1-5-high"],
	"image-gpt-image-2": ["gpt-image-2-1k", "gpt-image-2-2k", "gpt-image-2-4k"],
	"image-seedream-4-5": ["seedream-4-5-basic-2k", "seedream-4-5-high-4k"],
	"image-seedream-5-lite": [
		"seedream-5-lite-basic-2k",
		"seedream-5-lite-high-3k",
		"seedream-5-lite-ultra-4k",
	],
	"image-seedream-5-pro": ["seedream-5-pro-basic-1k", "seedream-5-pro-high-2k"],
} as const satisfies Record<
	(typeof EZPIC_PRODUCT_KEYS)[number],
	readonly (typeof IMAGE_SKU_KEYS)[number][]
>;

export const planIdSchema = z.enum(PLAN_IDS);
export const productModelKeySchema = z.enum(PRODUCT_MODEL_KEYS);
export const imageSkuKeySchema = z.enum(IMAGE_SKU_KEYS);
export const catalogVersionSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/, "Invalid catalog version");
export const pricingVersionSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/, "Invalid pricing version");

export const productConfigSchema = z.object({
	planIds: z.array(planIdSchema).min(1),
	productKeys: z.array(productModelKeySchema).min(1),
	catalogVersion: catalogVersionSchema,
	pricingVersion: pricingVersionSchema,
	brand: z.object({
		siteName: z.string().trim().min(1),
		siteDescription: z.string().trim().min(1),
		supportEmail: z.email().nullable(),
	}),
	features: z.object({
		mediaGeneration: z.boolean(),
		mediaModeration: z.boolean(),
		billing: z.boolean(),
		errorMonitoring: z.boolean(),
	}),
	uploadLimits: z.object({
		imageBytes: z.number().int().positive(),
		videoBytes: z.number().int().positive(),
	}),
	enabledLocales: z.array(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/)).min(1),
	retention: z.object({
		inputDays: z.number().int().positive(),
		outputDays: z.number().int().positive(),
		failedJobDays: z.number().int().positive(),
	}),
	circuitBreaker: z.object({
		failureThreshold: z.number().int().positive(),
		resetAfterSeconds: z.number().int().positive(),
	}),
	budgets: z.object({
		maximumJobCostMicros: z.number().int().positive(),
		maximumDailyUserCostMicros: z.number().int().positive(),
	}),
});

export type ProductConfigInput = z.input<typeof productConfigSchema>;
export type ProductConfig = z.output<typeof productConfigSchema>;
export type PlanId = z.infer<typeof planIdSchema>;
export type ProductModelKey = z.infer<typeof productModelKeySchema>;
export type ImageSkuKey = z.infer<typeof imageSkuKeySchema>;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];
export type CatalogVersion = z.infer<typeof catalogVersionSchema>;
export type PricingVersion = z.infer<typeof pricingVersionSchema>;

export const DEFAULT_PRODUCT_CONFIG = productConfigSchema.parse({
	planIds: PLAN_IDS,
	productKeys: EZPIC_PRODUCT_KEYS,
	catalogVersion: "2026-09-07.2",
	pricingVersion: "2026-09-07.2",
	brand: {
		siteName: "EzPic",
		siteDescription: "Private prompt-based AI image editing with transparent credits.",
		supportEmail: null,
	},
	features: {
		mediaGeneration: true,
		mediaModeration: true,
		billing: true,
		errorMonitoring: true,
	},
	uploadLimits: {
		imageBytes: 20 * 1024 * 1024,
		videoBytes: 250 * 1024 * 1024,
	},
	enabledLocales: ["en"],
	retention: {
		inputDays: 30,
		outputDays: 30,
		failedJobDays: 7,
	},
	circuitBreaker: {
		failureThreshold: 5,
		resetAfterSeconds: 60,
	},
	budgets: {
		maximumJobCostMicros: 5_000_000,
		maximumDailyUserCostMicros: 25_000_000,
	},
});

export function parseProductConfig(input: unknown): ProductConfig {
	return productConfigSchema.parse(input);
}
