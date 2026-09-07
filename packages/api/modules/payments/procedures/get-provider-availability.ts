import { db } from "@repo/database/client";
import { getProviderPriceIdByPlanId, isPaymentProviderConfigured } from "@repo/payments";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { resolveProviderAvailability } from "../provider-availability";

const capabilitiesSchema = z.object({
	checkout: z.boolean(),
	portal: z.boolean(),
	cancellation: z.boolean(),
	seatUpdates: z.boolean(),
	webhooks: z.boolean(),
});

export const getProviderAvailability = protectedProcedure
	.route({
		method: "GET",
		path: "/payments/provider-availability",
		tags: ["Payments"],
		summary: "List server-authorized subscription payment providers",
		description: "Lists available PayPal and Waffo subscription checkout options",
	})
	.input(
		z
			.object({
				planId: z.enum(["creator", "ultimate", "studio"]),
				interval: z.enum(["month", "year"]),
			})
			.strict(),
	)
	.output(
		z.object({
			providers: z.array(
				z.object({
					name: z.enum(["paypal", "waffo"]),
					capabilities: capabilitiesSchema,
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		const providers = await resolveProviderAvailability(input, {
			isConfigured: (provider) => isPaymentProviderConfigured(provider),
			getProviderPriceId: (provider) =>
				getProviderPriceIdByPlanId(provider, input.planId, {
					type: "subscription",
					interval: input.interval,
				}),
			findBillingPlan: (provider, providerPriceId) =>
				db.billingPlan.findUnique({
					where: { provider_providerPriceId: { provider, providerPriceId } },
				}),
		});
		return {
			providers: providers.flatMap((provider) => {
				if (provider.name !== "paypal" && provider.name !== "waffo") return [];
				return [{ name: provider.name, capabilities: provider.capabilities }];
			}),
		};
	});
