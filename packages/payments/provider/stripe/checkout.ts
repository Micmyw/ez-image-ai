import type Stripe from "stripe";

import type {
	CreateCheckoutLink,
	CreateCheckoutLinkOptions,
	CreateProviderCheckout,
} from "../../types";

function checkoutMetadata(options: CreateCheckoutLinkOptions): Record<string, string> {
	return {
		billing_plan_id: options.billingPlanId,
		plan_key: options.planKey,
		owner_type: options.ownerType,
		owner_id: options.ownerId,
		submitted_by_user_id: options.submittedByUserId,
		checkout_intent_id: options.checkoutIntentId,
	};
}

export const createStripeCheckout: (
	stripe: Stripe,
	options: CreateCheckoutLinkOptions,
) => ReturnType<CreateProviderCheckout> = async (stripe, options) => {
	const metadata = checkoutMetadata(options);
	const response = await stripe.checkout.sessions.create(
		{
			mode: options.type === "subscription" ? "subscription" : "payment",
			success_url: options.redirectUrl ?? "",
			line_items: [{ quantity: options.seats ?? 1, price: options.priceId }],
			...(options.customerId
				? { customer: options.customerId }
				: { customer_email: options.email }),
			...(options.type === "one-time"
				? {
						payment_intent_data: { metadata },
						...(options.customerId ? {} : { customer_creation: "always" as const }),
					}
				: {
						subscription_data: {
							metadata,
							trial_period_days: options.trialPeriodDays,
						},
					}),
			metadata,
		},
		{ idempotencyKey: options.idempotencyKey },
	);
	if (!response.id || !response.url) throw new Error("STRIPE_CHECKOUT_RESPONSE_INVALID");
	return {
		checkoutUrl: response.url,
		providerSessionId: response.id,
		expiresAt:
			typeof response.expires_at === "number" ? new Date(response.expires_at * 1_000) : null,
	};
};

export const createStripeCheckoutLink: (
	stripe: Stripe,
	options: CreateCheckoutLinkOptions,
) => ReturnType<CreateCheckoutLink> = async (stripe, options) =>
	(await createStripeCheckout(stripe, options)).checkoutUrl;
