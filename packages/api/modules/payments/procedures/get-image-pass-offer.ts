import { isImagePassBillingPlan, IMAGE_PASS_PAYPAL_SKU } from "@repo/config/image-pass.server";
import { db } from "@repo/database/client";
import { isPaymentProviderCheckoutAvailable } from "@repo/payments";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { assertBillingEnvironmentReady, isNewBillingEnabled } from "../billing-gate";
import { isBillingPlanEnvironmentCompatible } from "../provider-availability";

interface OfferAvailabilityDependencies {
	isBillingEnabled(): boolean;
	findPlan(): Promise<
		(NonNullable<Parameters<typeof isImagePassBillingPlan>[0]> & { active: boolean }) | null
	>;
	isCheckoutAvailable(): Promise<boolean>;
	assertEnvironmentReady(): Promise<void>;
}

export async function resolveImagePassOfferAvailability(
	dependencies: OfferAvailabilityDependencies,
): Promise<{ available: boolean }> {
	try {
		if (!dependencies.isBillingEnabled()) return { available: false };
		const plan = await dependencies.findPlan();
		if (
			!plan?.active ||
			!isImagePassBillingPlan(plan) ||
			!isBillingPlanEnvironmentCompatible(plan.metadata, "paypal")
		)
			return { available: false };
		await dependencies.assertEnvironmentReady();
		return { available: await dependencies.isCheckoutAvailable() };
	} catch {
		// Public advertising must fail closed without exposing internal billing details.
		return { available: false };
	}
}

export const getImagePassOffer = publicProcedure
	.route({ method: "GET", path: "/payments/image-pass-offer", tags: ["Payments"] })
	.input(z.object({}).strict().optional())
	.output(z.object({ available: z.boolean() }))
	.handler(async ({ context: { responseHeaders } }) => {
		responseHeaders?.set("Cache-Control", "no-store");
		return resolveImagePassOfferAvailability({
			isBillingEnabled: isNewBillingEnabled,
			findPlan: () =>
				db.billingPlan.findUnique({
					where: {
						provider_providerPriceId: {
							provider: "paypal",
							providerPriceId: IMAGE_PASS_PAYPAL_SKU,
						},
					},
				}),
			isCheckoutAvailable: () => isPaymentProviderCheckoutAvailable("paypal"),
			assertEnvironmentReady: assertBillingEnvironmentReady,
		});
	});
