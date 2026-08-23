import type Stripe from "stripe";

import type { CreateCheckoutLink, CreateCheckoutLinkOptions } from "../../types";

function checkoutMetadata(options: CreateCheckoutLinkOptions): Record<string, string> {
	return {
		billing_plan_id: options.billingPlanId,
		plan_key: options.planKey,
		owner_type: options.ownerType,
		owner_id: options.ownerId,
		submitted_by_user_id: options.submittedByUserId,
	};
}

export async function createStripeCheckoutLink(
	stripe: Stripe,
	options: CreateCheckoutLinkOptions,
): ReturnType<CreateCheckoutLink> {
	const metadata = checkoutMetadata(options);
	const response = await stripe.checkout.sessions.create({
		mode: options.type === "subscription" ? "subscription" : "payment",
		success_url: options.redirectUrl ?? "",
		line_items: [{ quantity: options.seats ?? 1, price: options.priceId }],
		...(options.customerId ? { customer: options.customerId } : { customer_email: options.email }),
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
	});
	return response.url;
}
