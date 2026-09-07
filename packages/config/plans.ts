import { z } from "zod";

import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_SKU_CREDIT_COSTS,
	IMAGE_SKU_KEYS_BY_PRODUCT,
	PLAN_IDS,
	planIdSchema,
	productModelKeySchema,
	type ProductModelKey,
} from "./product";

export const planEntitlementSchema = z.object({
	id: planIdSchema,
	monthlyCredits: z.number().int().nonnegative(),
	maximumConcurrentJobs: z.number().int().positive(),
	maximumInputBytes: z.number().int().positive(),
	allowedProducts: z.array(productModelKeySchema).min(1),
	prices: z.array(
		z.object({
			interval: z.enum(["month", "year"]),
			amount: z.number().positive(),
			currency: z.literal("USD"),
		}),
	),
});

export type PlanEntitlement = z.infer<typeof planEntitlementSchema>;

export const PLAN_ENTITLEMENTS = z
	.array(planEntitlementSchema)
	.length(PLAN_IDS.length)
	.parse([
		{
			id: "free",
			monthlyCredits: 25,
			maximumConcurrentJobs: 1,
			maximumInputBytes: 10 * 1024 * 1024,
			allowedProducts: ["image-nano-banana-2-lite"],
			prices: [],
		},
		{
			id: "creator",
			monthlyCredits: 700,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: [...EZPIC_PRODUCT_KEYS],
			prices: [
				{ interval: "month", amount: 19, currency: "USD" },
				{ interval: "year", amount: 190, currency: "USD" },
			],
		},
		{
			id: "ultimate",
			monthlyCredits: 1_800,
			maximumConcurrentJobs: 6,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: [...EZPIC_PRODUCT_KEYS],
			prices: [
				{ interval: "month", amount: 49, currency: "USD" },
				{ interval: "year", amount: 490, currency: "USD" },
			],
		},
		{
			id: "studio",
			monthlyCredits: 3_000,
			maximumConcurrentJobs: 10,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: [...EZPIC_PRODUCT_KEYS],
			prices: [
				{ interval: "month", amount: 79, currency: "USD" },
				{ interval: "year", amount: 790, currency: "USD" },
			],
		},
	]);

export function getPlanEntitlement(planId: PlanEntitlement["id"]): PlanEntitlement {
	const entitlement = PLAN_ENTITLEMENTS.find((plan) => plan.id === planId);
	if (!entitlement) throw new Error(`Unknown plan entitlement: ${planId}`);
	return entitlement;
}

export function getPlanUsageEstimate(planId: PlanEntitlement["id"]): {
	minimumImageEdits: number;
	maximumImageEdits: number;
	minimumCreditsPerImage: number;
	maximumCreditsPerImage: number;
} {
	const entitlement = getPlanEntitlement(planId);
	const creditCosts = entitlement.allowedProducts.flatMap(imageSkuCreditCostsForProduct);
	if (creditCosts.length === 0) {
		throw new Error(`Plan ${planId} does not include an image SKU`);
	}
	const minimumCreditsPerImage = Math.min(...creditCosts);
	const maximumCreditsPerImage = Math.max(...creditCosts);
	return {
		minimumImageEdits: Math.floor(entitlement.monthlyCredits / maximumCreditsPerImage),
		maximumImageEdits: Math.floor(entitlement.monthlyCredits / minimumCreditsPerImage),
		minimumCreditsPerImage,
		maximumCreditsPerImage,
	};
}

function imageSkuCreditCostsForProduct(productKey: ProductModelKey): number[] {
	const skuKeys = IMAGE_SKU_KEYS_BY_PRODUCT[productKey as keyof typeof IMAGE_SKU_KEYS_BY_PRODUCT];
	return skuKeys?.map((skuKey) => IMAGE_SKU_CREDIT_COSTS[skuKey]) ?? [];
}

export function resolvePlanEntitlement(
	metadata: unknown,
	planName: string | undefined,
): PlanEntitlement {
	const metadataPlanId =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).planId
			: undefined;
	const parsedMetadataPlanId = planIdSchema.safeParse(metadataPlanId);
	const normalizedPlanName = planName?.trim().toLowerCase();
	const planId = parsedMetadataPlanId.success
		? parsedMetadataPlanId.data
		: normalizedPlanName
			? PUBLIC_PLAN_NAME_ALIASES[normalizedPlanName]
			: undefined;
	return getPlanEntitlement(planId ?? "free");
}

const PUBLIC_PLAN_NAME_ALIASES: Readonly<Record<string, PlanEntitlement["id"]>> = {
	free: "free",
	creator: "creator",
	pro: "creator",
	ultimate: "ultimate",
	studio: "studio",
	max: "studio",
};
