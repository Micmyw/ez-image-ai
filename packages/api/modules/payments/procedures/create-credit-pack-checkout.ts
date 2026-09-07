import { ORPCError } from "@orpc/server";
import { creditPackKeySchema, resolvePlanEntitlement } from "@repo/config";
import { createCreditPackCheckoutSnapshot } from "@repo/config/server";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	findEffectivePaidSubscription,
	getPaymentCheckoutIntentForOwner,
	getPaymentCheckoutIntentForOwnerByIdempotencyKey,
	getPaymentCustomer,
	markPaymentCheckoutIntentProviderCreating,
} from "@repo/database";
import { db } from "@repo/database/client";
import { logger } from "@repo/logs";
import {
	getCreditPackProviderProductId,
	getPaymentProvider,
	isPaymentProviderConfigured,
} from "@repo/payments";
import { config as paymentsConfig } from "@repo/payments/config";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { verifyOrganizationBillingManagement } from "../../organizations/lib/membership";
import { isExactCreditPackBillingPlanSnapshot } from "../provider-availability";
import { recoverProviderCreatingCheckout } from "./checkout-recovery";

const creditPackCheckoutProviderSchema = z.enum(["paypal", "waffo"]);

export const creditPackCheckoutInputSchema = z
	.object({
		provider: creditPackCheckoutProviderSchema,
		packKey: creditPackKeySchema,
		idempotencyKey: z
			.string()
			.trim()
			.regex(/^\w[\w.:-]{7,127}$/),
	})
	.strict();

export const createCreditPackCheckout = protectedProcedure
	.route({
		method: "POST",
		path: "/payments/create-credit-pack-checkout",
		tags: ["Payments"],
		summary: "Create a credit-pack checkout",
		description: "Creates a server-priced one-time checkout through PayPal or Waffo",
	})
	.input(creditPackCheckoutInputSchema)
	.output(z.object({ checkoutLink: z.url() }))
	.handler(async ({ input, context: { session, user } }) => {
		const { provider, packKey, idempotencyKey } = input;
		if (!isPaymentProviderConfigured(provider)) throw new ORPCError("NOT_FOUND");

		const providerDefinition = getPaymentProvider(provider);
		if (!providerDefinition?.capabilities.checkout) throw new ORPCError("NOT_FOUND");
		const owner = await resolveCreditPackCheckoutOwner(user.id, session.activeOrganizationId);
		let trustedIntent = await getPaymentCheckoutIntentForOwnerByIdempotencyKey(
			{ ...owner, idempotencyKey },
			db,
		);
		if (trustedIntent) {
			if (!isTrustedCreditPackIntent(trustedIntent, provider, packKey, user.id)) {
				throw new ORPCError("CONFLICT");
			}
			if (
				trustedIntent.status === "PROVIDER_PENDING" &&
				trustedIntent.providerSessionId &&
				trustedIntent.providerCheckoutUrl
			) {
				return { checkoutLink: trustedIntent.providerCheckoutUrl };
			}
			if (trustedIntent.status !== "CREATED" && trustedIntent.status !== "PROVIDER_CREATING") {
				throw new ORPCError("CONFLICT");
			}
		} else {
			const providerProductId = getCreditPackProviderProductId(provider, packKey);
			if (!providerProductId) throw new ORPCError("NOT_FOUND");
			const billingPlan = await db.billingPlan.findUnique({
				where: {
					provider_providerPriceId: { provider, providerPriceId: providerProductId },
				},
			});
			if (
				!isExactCreditPackBillingPlanSnapshot(billingPlan, provider, providerProductId, {
					packKey,
				})
			) {
				throw new ORPCError("NOT_FOUND");
			}

			const now = new Date();
			const subscriber = await findEffectivePaidSubscription({ ...owner, now }, db);
			const subscriberPlanKey = resolveSubscriberPlanKey(subscriber, owner);
			const snapshot = createCreditPackCheckoutSnapshot(packKey, subscriberPlanKey !== null);
			let checkoutIntent;
			try {
				checkoutIntent = await createPaymentCheckoutIntent(
					{
						provider,
						...owner,
						submittedByUserId: user.id,
						billingPlanId: billingPlan.id,
						productKind: "CREDIT_PACK",
						planKey: packKey,
						interval: "one-time",
						idempotencyKey,
						now,
						creditPackSnapshot: {
							catalogVersion: snapshot.catalogVersion,
							pricingVersion: snapshot.pricingVersion,
							subscriberEligibilityVersion: snapshot.subscriberEligibilityVersion,
							baseCredits: BigInt(snapshot.baseCredits),
							bonusCredits: BigInt(snapshot.bonusCredits),
							totalCredits: BigInt(snapshot.totalCredits),
							expiryMonths: snapshot.expiryMonths,
							subscriberBonusEligible: snapshot.subscriberBonusEligible,
							subscriberSubscriptionId: subscriberPlanKey ? (subscriber?.id ?? null) : null,
							subscriberPlanKey,
							eligibilityEvaluatedAt: now,
						},
					},
					db,
				);
			} catch (error) {
				if (isCreditPackCheckoutConflict(error)) throw new ORPCError("CONFLICT");
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}

			if (
				checkoutIntent.intent.status !== "CREATED" &&
				checkoutIntent.intent.status !== "PROVIDER_PENDING"
			) {
				throw new ORPCError("CONFLICT");
			}
			trustedIntent = await getPaymentCheckoutIntentForOwner(
				{ intentId: checkoutIntent.intent.id, ...owner },
				db,
			);
			if (!isTrustedCreditPackIntent(trustedIntent, provider, packKey, user.id)) {
				throw new ORPCError("CONFLICT");
			}
			if (
				trustedIntent.status === "PROVIDER_PENDING" &&
				trustedIntent.providerSessionId &&
				trustedIntent.providerCheckoutUrl
			) {
				return { checkoutLink: trustedIntent.providerCheckoutUrl };
			}
			if (trustedIntent.status !== "CREATED" && trustedIntent.status !== "PROVIDER_CREATING") {
				throw new ORPCError("CONFLICT");
			}
		}

		const customer = await getPaymentCustomer(provider, owner, db);
		const checkoutOptions = {
			type: "one-time" as const,
			priceId: trustedIntent.billingPlan.providerPriceId,
			currency: trustedIntent.billingPlan.currency,
			amountMicros: trustedIntent.billingPlan.priceMicros,
			description: `EzPic ${trustedIntent.creditPackBaseCredits.toString()} credits`,
			billingPlanId: trustedIntent.billingPlanId,
			checkoutIntentId: trustedIntent.id,
			idempotencyKey: trustedIntent.idempotencyKey,
			planKey: trustedIntent.planKey,
			...owner,
			submittedByUserId: user.id,
			...(owner.ownerType === "USER"
				? { userId: owner.ownerId }
				: { organizationId: owner.ownerId }),
			email: user.email,
			name: user.name ?? "",
			redirectUrl: creditPackCheckoutReturnUrl(trustedIntent.id),
			customerId: customer?.providerCustomerId,
		};

		if (trustedIntent.status === "PROVIDER_CREATING") {
			try {
				const recovery = await recoverProviderCreatingCheckout(
					{
						provider: providerDefinition,
						owner,
						intent: trustedIntent,
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
					{ provider, errorClass: creditPackCheckoutErrorClass(error) },
					"Credit-pack checkout recovery failed",
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR");
			}
		}

		try {
			await markPaymentCheckoutIntentProviderCreating({ intentId: trustedIntent.id, provider }, db);
		} catch (error) {
			if (isCreditPackCheckoutConflict(error)) throw new ORPCError("CONFLICT");
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}

		try {
			const checkout = await providerDefinition.createCheckout(checkoutOptions);
			await bindPaymentCheckoutIntentSession(
				{
					intentId: trustedIntent.id,
					provider,
					providerSessionId: checkout.providerSessionId,
					...(provider === "paypal" ? { providerOrderId: checkout.providerSessionId } : {}),
					providerCheckoutUrl: checkout.checkoutUrl,
					expiresAt: checkout.expiresAt,
				},
				db,
			);
			return { checkoutLink: checkout.checkoutUrl };
		} catch (error) {
			logger.error(
				{ provider, errorClass: creditPackCheckoutErrorClass(error) },
				"Credit-pack checkout creation failed",
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR");
		}
	});

async function resolveCreditPackCheckoutOwner(
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

function resolveSubscriberPlanKey(
	subscription: {
		id: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		plan: { metadata: unknown; name: string };
	} | null,
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
): "creator" | "ultimate" | "studio" | null {
	if (
		!subscription ||
		subscription.ownerType !== owner.ownerType ||
		subscription.ownerId !== owner.ownerId
	) {
		return null;
	}
	const planId = resolvePlanEntitlement(subscription.plan.metadata, subscription.plan.name).id;
	return planId === "creator" || planId === "ultimate" || planId === "studio" ? planId : null;
}

function isTrustedCreditPackIntent(
	intent: Awaited<ReturnType<typeof getPaymentCheckoutIntentForOwner>>,
	provider: "paypal" | "waffo",
	packKey: string,
	submittedByUserId: string,
): intent is NonNullable<typeof intent> & {
	creditPackBaseCredits: bigint;
	billingPlan: NonNullable<typeof intent>["billingPlan"];
} {
	return Boolean(
		intent &&
		intent.provider === provider &&
		intent.submittedByUserId === submittedByUserId &&
		intent.productKind === "CREDIT_PACK" &&
		intent.planKey === packKey &&
		intent.interval === "one-time" &&
		nonempty(intent.creditPackCatalogVersion) &&
		nonempty(intent.creditPackPricingVersion) &&
		nonempty(intent.creditPackSubscriberEligibilityVersion) &&
		intent.creditPackBaseCredits &&
		intent.creditPackBaseCredits > 0n &&
		intent.creditPackBonusCredits !== null &&
		intent.creditPackBonusCredits >= 0n &&
		intent.creditPackTotalCredits ===
			intent.creditPackBaseCredits + intent.creditPackBonusCredits &&
		intent.creditPackExpiryMonths === 6 &&
		intent.creditPackEligibilityEvaluatedAt instanceof Date &&
		validFrozenSubscriberEligibility(intent) &&
		intent.billingPlanId === intent.billingPlan.id &&
		intent.billingPlan.productKind === "CREDIT_PACK" &&
		intent.billingPlan.provider === provider &&
		intent.billingPlan.name === packKey &&
		intent.billingPlan.creditsPerPeriod === intent.creditPackBaseCredits &&
		intent.billingPlan.priceMicros > 0n &&
		intent.billingPlan.currency === "USD",
	);
}

function validFrozenSubscriberEligibility(intent: {
	creditPackSubscriberBonusEligible: boolean | null;
	creditPackBonusCredits: bigint | null;
	creditPackSubscriberSubscriptionId: string | null;
	creditPackSubscriberPlanKey: string | null;
}): boolean {
	if (intent.creditPackSubscriberBonusEligible === true) {
		return Boolean(
			intent.creditPackBonusCredits &&
			intent.creditPackBonusCredits > 0n &&
			nonempty(intent.creditPackSubscriberSubscriptionId) &&
			isPaidPlanKey(intent.creditPackSubscriberPlanKey),
		);
	}
	return (
		intent.creditPackSubscriberBonusEligible === false &&
		intent.creditPackBonusCredits === 0n &&
		intent.creditPackSubscriberSubscriptionId === null &&
		intent.creditPackSubscriberPlanKey === null
	);
}

function nonempty(value: string | null): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPaidPlanKey(value: string | null): boolean {
	return value === "creator" || value === "ultimate" || value === "studio";
}

function creditPackCheckoutReturnUrl(intentId: string): string {
	const url = new URL(
		"/credit-pack-checkout-return",
		getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000),
	);
	url.searchParams.set("intentId", intentId);
	return url.toString();
}

function isCreditPackCheckoutConflict(error: unknown): boolean {
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

function creditPackCheckoutErrorClass(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("PAYMENT_CHECKOUT_INTENT_")) {
		return "PAYMENT_CHECKOUT_INTENT_ERROR";
	}
	return "PAYMENT_PROVIDER_ERROR";
}
