import { z } from "zod";

export const PLAN_IDS = ["free", "creator", "studio"] as const;
export const PRODUCT_MODEL_KEYS = [
	"image-fast",
	"image-quality",
	"video-fast",
	"video-quality",
] as const;

export const planIdSchema = z.enum(PLAN_IDS);
export const productModelKeySchema = z.enum(PRODUCT_MODEL_KEYS);
export const catalogVersionSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/, "Invalid catalog version");
export const pricingVersionSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/, "Invalid pricing version");

const httpsUrlSchema = z.url().refine((url) => url.startsWith("https://"), {
	message: "Public URLs must use HTTPS",
});

export const productConfigSchema = z.object({
	planIds: z.array(planIdSchema).min(1),
	productKeys: z.array(productModelKeySchema).min(1),
	catalogVersion: catalogVersionSchema,
	pricingVersion: pricingVersionSchema,
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
	publicUrls: z.object({
		marketing: httpsUrlSchema,
		saas: httpsUrlSchema,
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
export type CatalogVersion = z.infer<typeof catalogVersionSchema>;
export type PricingVersion = z.infer<typeof pricingVersionSchema>;

export const DEFAULT_PRODUCT_CONFIG = productConfigSchema.parse({
	planIds: PLAN_IDS,
	productKeys: PRODUCT_MODEL_KEYS,
	catalogVersion: "2026-08-24.1",
	pricingVersion: "2026-08-13.1",
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
	publicUrls: {
		marketing: "https://example.com",
		saas: "https://app.example.com",
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
