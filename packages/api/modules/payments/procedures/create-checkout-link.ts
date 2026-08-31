import { ORPCError } from "@orpc/server";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCustomer,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	findPriceByPlanId,
	getPaymentProvider,
	getProviderPriceIdByPlanId,
	isPaymentProviderConfigured,
	paymentProviderNames,
} from "@repo/payments";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { protectedProcedure } from "../../../orpc/procedures";
import { isExactBillingPlanSnapshot } from "../provider-availability";

export const checkoutInputSchema = z
	.object({
		provider: z.enum(paymentProviderNames),
		planId: z.enum(["creator", "studio"]),
		interval: z.enum(["month", "year"]),
		idempotencyKey: z
			.string()
			.trim()
			.regex(/^\w[\w.:-]{7,127}$/),
	})
	.strict();

export const createCheckoutLink = protectedProcedure
	.use(localeMiddleware)
	.route({
		method: "POST",
		path: "/payments/create-checkout-link",
		tags: ["Payments"],
		summary: "Create a provider-aware checkout link",
		description: "Creates a server-authorized subscription checkout",
	})
	.input(checkoutInputSchema)
	.output(z.object({ checkoutLink: z.url() }))
	.handler(async ({ input, context: { user } }) => {
		const { provider, planId, interval, idempotencyKey } = input;
		if (!isPaymentProviderConfigured(provider)) throw new ORPCError("NOT_FOUND");

		const providerDefinition = getPaymentProvider(provider);
		if (!providerDefinition?.capabilities.checkout) throw new ORPCError("NOT_FOUND");
		const price = findPriceByPlanId(planId, { type: "subscription", interval });
		const providerPriceId = getProviderPriceIdByPlanId(provider, planId, {
			type: "subscription",
			interval,
		});
		if (!price || !providerPriceId) throw new ORPCError("NOT_FOUND");

		const billingPlan = await db.billingPlan.findUnique({
			where: {
				provider_providerPriceId: { provider, providerPriceId },
			},
		});
		if (
			!isExactBillingPlanSnapshot(billingPlan, provider, providerPriceId, {
				planId,
				interval,
			})
		) {
			throw new ORPCError("NOT_FOUND");
		}

		const owner = { ownerType: "USER" as const, ownerId: user.id };
		const customer = await getPaymentCustomer(provider, owner, db);
		let checkoutIntent;
		try {
			checkoutIntent = await createPaymentCheckoutIntent(
				{
					provider,
					...owner,
					submittedByUserId: user.id,
					billingPlanId: billingPlan.id,
					planKey: planId,
					interval,
					idempotencyKey,
				},
				db,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "PAYMENT_CHECKOUT_INTENT_CONFLICT") {
				throw new ORPCError("CONFLICT");
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}

		try {
			const checkout = await providerDefinition.createCheckout({
				type: "subscription",
				priceId: providerPriceId,
				currency: price.currency,
				billingPlanId: billingPlan.id,
				checkoutIntentId: checkoutIntent.intent.id,
				idempotencyKey,
				planKey: planId,
				...owner,
				submittedByUserId: user.id,
				userId: user.id,
				email: user.email,
				name: user.name ?? "",
				redirectUrl: checkoutReturnUrl(planId),
				customerId: customer?.providerCustomerId,
				trialPeriodDays: "trialPeriodDays" in price ? price.trialPeriodDays : undefined,
			});

			if (checkoutIntent.intent.providerSessionId) {
				if (checkoutIntent.intent.providerSessionId !== checkout.providerSessionId) {
					throw new Error("PAYMENT_CHECKOUT_SESSION_CONFLICT");
				}
			} else {
				await bindPaymentCheckoutIntentSession(
					{
						intentId: checkoutIntent.intent.id,
						provider,
						providerSessionId: checkout.providerSessionId,
						expiresAt: checkout.expiresAt,
					},
					db,
				);
			}
			return { checkoutLink: checkout.checkoutUrl };
		} catch (error) {
			logger.error(
				{ provider, errorClass: checkoutErrorClass(error) },
				"Payment checkout creation failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

function checkoutReturnUrl(planId: "creator" | "studio"): string {
	const url = new URL("/checkout-return", getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000));
	url.searchParams.set("expectedPlanId", planId);
	url.searchParams.set("returnTo", "/create?upgrade=complete");
	return url.toString();
}

function checkoutErrorClass(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message === "PAYMENT_CHECKOUT_SESSION_CONFLICT") return message;
	if (message.startsWith("PAYMENT_CHECKOUT_INTENT_")) return "PAYMENT_CHECKOUT_INTENT_ERROR";
	return "PAYMENT_PROVIDER_ERROR";
}
