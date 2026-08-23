import { z } from "zod";

import { PLAN_IDS, planIdSchema, productModelKeySchema } from "./product";

export const planEntitlementSchema = z.object({
	id: planIdSchema,
	monthlyCredits: z.number().int().nonnegative(),
	maximumConcurrentJobs: z.number().int().positive(),
	maximumInputBytes: z.number().int().positive(),
	allowedProducts: z.array(productModelKeySchema).min(1),
	stripePriceId: z
		.string()
		.regex(/^price_[A-Za-z0-9]+$/)
		.nullable(),
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
			stripePriceId: null,
		},
		{
			id: "creator",
			monthlyCredits: 1_000,
			maximumConcurrentJobs: 3,
			maximumInputBytes: 100 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality", "video-fast"],
			stripePriceId: "price_creator",
		},
		{
			id: "studio",
			monthlyCredits: 5_000,
			maximumConcurrentJobs: 10,
			maximumInputBytes: 250 * 1024 * 1024,
			allowedProducts: ["image-fast", "image-quality", "video-fast", "video-quality"],
			stripePriceId: "price_studio",
		},
	]);
