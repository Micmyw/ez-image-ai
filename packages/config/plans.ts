import { z } from "zod";

import { PLAN_IDS, planIdSchema, productModelKeySchema } from "./product";

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
			allowedProducts: ["image-fast"],
			prices: [],
		},
		{
			id: "creator",
			monthlyCredits: 1_000,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
			prices: [
				{ interval: "month", amount: 19, currency: "USD" },
				{ interval: "year", amount: 190, currency: "USD" },
			],
		},
		{
			id: "studio",
			monthlyCredits: 5_000,
			maximumConcurrentJobs: 10,
			maximumInputBytes: 20 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality"],
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

export function resolvePlanEntitlement(
	metadata: unknown,
	planName: string | undefined,
): PlanEntitlement {
	const metadataPlanId =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? (metadata as Record<string, unknown>).planId
			: undefined;
	const planId = [metadataPlanId, planName?.trim().toLowerCase()].find(
		(value): value is PlanEntitlement["id"] =>
			value === "free" || value === "creator" || value === "studio",
	);
	return getPlanEntitlement(planId ?? "free");
}
