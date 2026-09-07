import { ORPCError } from "@orpc/server";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	findPriceByPlanId,
	getPaymentProvider,
	getProviderPriceIdByPlanId,
	isPaymentProviderConfigured,
} from "@repo/payments";
import { config as paymentsConfig } from "@repo/payments/config";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { localeMiddleware } from "../../../orpc/middleware/locale-middleware";
import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";
import { isExactBillingPlanSnapshot } from "../provider-availability";
import { recoverProviderCreatingCheckout } from "./checkout-recovery";

export const checkoutInputSchema = z
	.object({
		provider: z.enum(["paypal", "waffo"]),
		planId: z.enum(["creator", "ultimate", "studio"]),
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
	.handler(async ({ input, context: { session, user } }) => {
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

		const owner = await resolveCheckoutOwner(user.id, session.activeOrganizationId);
		const customer = await getPaymentCustomer(provider, owner, db);
		let checkoutIntent;
		let trustedBillingPlan = billingPlan;
		const existingIntent = await getPaymentCheckoutIntentForOwnerByIdempotencyKey(
			{ ...owner, idempotencyKey },
			db,
		);
		if (existingIntent) {
			if (!isTrustedSubscriptionIntent(existingIntent, provider, planId, interval, user.id)) {
				throw new ORPCError("CONFLICT");
			}
			checkoutIntent = { intent: existingIntent, replayed: true };
			trustedBillingPlan = existingIntent.billingPlan;
		} else {
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
				if (isCheckoutIntentConflict(error)) {
					throw new ORPCError("CONFLICT");
				}
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		}
		if (
			checkoutIntent.replayed &&
			checkoutIntent.intent.status === "PROVIDER_PENDING" &&
			checkoutIntent.intent.providerSessionId &&
			checkoutIntent.intent.providerCheckoutUrl
		) {
			return { checkoutLink: checkoutIntent.intent.providerCheckoutUrl };
		}
		if (
			checkoutIntent.intent.status !== "CREATED" &&
			checkoutIntent.intent.status !== "PROVIDER_CREATING"
		) {
			throw new ORPCError("CONFLICT");
		}
		const checkoutOptions = {
			type: "subscription" as const,
			priceId: trustedBillingPlan.providerPriceId,
			currency: trustedBillingPlan.currency,
			billingPlanId: checkoutIntent.intent.billingPlanId,
			checkoutIntentId: checkoutIntent.intent.id,
			idempotencyKey: checkoutIntent.intent.idempotencyKey,
			planKey: checkoutIntent.intent.planKey,
			...owner,
			submittedByUserId: user.id,
			...(owner.ownerType === "USER"
				? { userId: owner.ownerId }
				: { organizationId: owner.ownerId }),
			email: user.email,
			name: user.name ?? "",
			redirectUrl: checkoutReturnUrl(planId),
			customerId: customer?.providerCustomerId,
			trialPeriodDays: "trialPeriodDays" in price ? price.trialPeriodDays : undefined,
		};
		if (checkoutIntent.intent.status === "PROVIDER_CREATING") {
			try {
				const recovery = await recoverProviderCreatingCheckout(
					{
						provider: providerDefinition,
						owner,
						intent: checkoutIntent.intent,
						checkoutOptions,
						now: new Date(),
					},
					db,
				);
				if (recovery.kind === "RECOVERED") {
					return { checkoutLink: recovery.checkout.checkoutUrl };
				}
				if (recovery.kind === "REVIEW") throw new ORPCError("CONFLICT");
			} catch (error) {
				if (error instanceof ORPCError) throw error;
				logger.error(
					{ provider, errorClass: checkoutErrorClass(error) },
					"Payment checkout recovery failed",
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		}
		try {
			await markPaymentCheckoutIntentProviderCreating(
				{ intentId: checkoutIntent.intent.id, provider },
				db,
			);
		} catch (error) {
			if (isCheckoutIntentConflict(error)) throw new ORPCError("CONFLICT");
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}

		try {
			const checkout = await providerDefinition.createCheckout(checkoutOptions);

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
						providerCheckoutUrl: checkout.checkoutUrl,
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

function checkoutReturnUrl(planId: "creator" | "ultimate" | "studio"): string {
	const url = new URL("/checkout-return", getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000));
	url.searchParams.set("expectedPlanId", planId);
	url.searchParams.set("returnTo", "/create?upgrade=complete");
	return url.toString();
}

async function resolveCheckoutOwner(
	userId: string,
	activeOrganizationId: string | null | undefined,
) {
	if (paymentsConfig.billingAttachedTo === "user") {
		return { ownerType: "USER" as const, ownerId: userId };
	}
	if (!activeOrganizationId) throw new ORPCError("FORBIDDEN");
	const membership = await verifyOrganizationBillingManagement(activeOrganizationId, userId);
	if (!membership || membership.organization.id !== activeOrganizationId) {
		throw new ORPCError("FORBIDDEN");
	}
	return { ownerType: "ORGANIZATION" as const, ownerId: activeOrganizationId };
}

function isTrustedSubscriptionIntent(
	intent: NonNullable<Awaited<ReturnType<typeof getPaymentCheckoutIntentForOwnerByIdempotencyKey>>>,
	provider: "paypal" | "waffo",
	planId: "creator" | "ultimate" | "studio",
	interval: "month" | "year",
	submittedByUserId: string,
): boolean {
	return (
		intent.provider === provider &&
		intent.submittedByUserId === submittedByUserId &&
		intent.productKind === "PLAN" &&
		intent.planKey === planId &&
		intent.interval === interval &&
		intent.billingPlanId === intent.billingPlan.id &&
		intent.billingPlan.provider === provider &&
		intent.billingPlan.productKind === "PLAN" &&
		intent.billingPlan.name === planId
	);
}

function isCheckoutIntentConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		[
			"PAYMENT_CHECKOUT_INTENT_CONFLICT",
			"PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT",
			"PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE",
			"PAYMENT_CHECKOUT_INTENT_PROVIDER_CREATE_CONFLICT",
		].includes(error.message)
	);
}

function checkoutErrorClass(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message === "PAYMENT_CHECKOUT_SESSION_CONFLICT") return message;
	if (message.startsWith("PAYMENT_CHECKOUT_INTENT_")) return "PAYMENT_CHECKOUT_INTENT_ERROR";
	return "PAYMENT_PROVIDER_ERROR";
}
