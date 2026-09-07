import Stripe from "stripe";

import type {
	CancelSubscription,
	CreateCheckoutLink,
	CreateCustomerPortalLink,
	PaymentProvider,
	SetSubscriptionSeats,
	WebhookHandler,
} from "../../types";
import { cancelStripeSubscription } from "./cancellation";
import { rejectStripeCheckout } from "./checkout";
import { createStripeWebhookHandler } from "./webhook";

let stripeClient: Stripe | null = null;

export function getStripeClient() {
	if (stripeClient) {
		return stripeClient;
	}

	const stripeSecretKey = process.env.STRIPE_SECRET_KEY as string;

	if (!stripeSecretKey) {
		throw new Error("Missing env variable STRIPE_SECRET_KEY");
	}

	stripeClient = new Stripe(stripeSecretKey, { apiVersion: "2026-07-29.dahlia" });

	return stripeClient;
}

export const createCheckoutLink: CreateCheckoutLink = async (options) => {
	void options;
	return rejectStripeCheckout();
};

export const createCustomerPortalLink: CreateCustomerPortalLink = async ({
	customerId,
	redirectUrl,
}) => {
	const stripeClient = getStripeClient();

	const response = await stripeClient.billingPortal.sessions.create({
		customer: customerId,
		return_url: redirectUrl ?? "",
	});

	return response.url;
};

export const setSubscriptionSeats: SetSubscriptionSeats = async ({ id, seats }) => {
	const stripeClient = getStripeClient();

	const subscription = await stripeClient.subscriptions.retrieve(id);

	if (!subscription) {
		throw new Error("Subscription not found.");
	}

	await stripeClient.subscriptions.update(id, {
		items: [
			{
				id: subscription.items.data[0].id,
				quantity: seats,
			},
		],
	});
};

export const cancelSubscription: CancelSubscription = async (id) => {
	await cancelStripeSubscription(getStripeClient(), id);
};

export function createStripeProvider(): PaymentProvider {
	return {
		name: "stripe",
		capabilities: {
			checkout: false,
			portal: true,
			cancellation: true,
			seatUpdates: true,
			webhooks: true,
		},
		createCheckout: (options) => {
			void options;
			return rejectStripeCheckout();
		},
		createPortal: createCustomerPortalLink,
		cancelSubscription,
		setSubscriptionSeats,
	};
}

export const webhookHandler: WebhookHandler = (request) =>
	createStripeWebhookHandler({
		stripe: getStripeClient(),
		webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
		async persist(input) {
			const { db, ingestPaymentEvent } = await import("@repo/database");
			const result = await ingestPaymentEvent(input, db);
			return { replayed: result.replayed };
		},
	})(request);
