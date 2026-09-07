import { creditPackKeySchema } from "@repo/config";
import { db } from "@repo/database/client";
import { getCreditPackProviderProductId, isPaymentProviderConfigured } from "@repo/payments";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import { resolveCreditPackProviderAvailability } from "../provider-availability";

const creditPackProviderSchema = z.enum(["paypal", "waffo"]);

const capabilitiesSchema = z.object({
	checkout: z.boolean(),
	portal: z.boolean(),
	cancellation: z.boolean(),
	seatUpdates: z.boolean(),
	webhooks: z.boolean(),
});

export const creditPackProviderAvailabilityInputSchema = z
	.object({ packKey: creditPackKeySchema })
	.strict();

export const getCreditPackProviderAvailability = publicProcedure
	.route({
		method: "GET",
		path: "/payments/credit-pack-provider-availability",
		tags: ["Payments"],
		summary: "List available credit-pack payment providers",
		description: "Lists server-authorized PayPal and Waffo credit-pack checkout options",
	})
	.input(creditPackProviderAvailabilityInputSchema)
	.output(
		z.object({
			providers: z.array(
				z.object({
					name: creditPackProviderSchema,
					capabilities: capabilitiesSchema,
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		const providers = await resolveCreditPackProviderAvailability(input, {
			isConfigured: (provider) => isPaymentProviderConfigured(provider),
			getProviderProductId: (provider) => getCreditPackProviderProductId(provider, input.packKey),
			findBillingPlan: (provider, providerProductId) =>
				db.billingPlan.findUnique({
					where: {
						provider_providerPriceId: {
							provider,
							providerPriceId: providerProductId,
						},
					},
				}),
		});
		return {
			providers: providers.flatMap((provider) => {
				if (provider.name !== "paypal" && provider.name !== "waffo") return [];
				return [{ name: provider.name, capabilities: provider.capabilities }];
			}),
		};
	});
