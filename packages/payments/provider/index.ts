import { createConfiguredPayPalWebhookVerifier } from "./paypal";
import {
	cancelSubscription,
	createCheckoutLink,
	createCustomerPortalLink,
	getStripeClient,
	setSubscriptionSeats,
	webhookHandler as stripeWebhookHandler,
} from "./stripe";
import { createStripeWebhookVerifier } from "./stripe/webhook";
import { createConfiguredWaffoWebhookVerifier } from "./waffo";
import { createPaymentWebhookHandler } from "./webhook";

export const webhookHandler = createPaymentWebhookHandler({
	verifiers: {
		stripe: (rawBody, headers) =>
			createStripeWebhookVerifier({
				stripe: getStripeClient(),
				webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
			})(rawBody, headers),
		paypal: (rawBody, headers) => createConfiguredPayPalWebhookVerifier()(rawBody, headers),
		waffo: (rawBody, headers) => createConfiguredWaffoWebhookVerifier()(rawBody, headers),
	},
	async persist(input) {
		const { db, ingestPaymentEvent } = await import("@repo/database");
		const result = await ingestPaymentEvent({ ...input, envelope: input.envelope as never }, db);
		return { replayed: result.replayed };
	},
});

export {
	cancelSubscription,
	createCheckoutLink,
	createCustomerPortalLink,
	getStripeClient,
	setSubscriptionSeats,
	stripeWebhookHandler,
};
export * from "./paypal";
export * from "./lifecycle-normalization";
export * from "./lifecycle-reducer";
export * from "./management";
export * from "./processor";
export * from "./registry";
export * from "./runtime-registry";
export * from "./stripe/billing-source";
export * from "./stripe/cancellation";
export * from "./stripe/checkout";
export * from "./stripe/webhook";
export * from "./waffo";
export * from "./webhook";
