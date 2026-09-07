import type Stripe from "stripe";

import type {
	CreateCheckoutLink,
	CreateCheckoutLinkOptions,
	CreateProviderCheckout,
} from "../../types";

export const STRIPE_CHECKOUT_DISABLED_ERROR = "STRIPE_CHECKOUT_DISABLED";

export async function rejectStripeCheckout(): Promise<never> {
	throw new Error(STRIPE_CHECKOUT_DISABLED_ERROR);
}

export const createStripeCheckout: (
	stripe: Stripe,
	options: CreateCheckoutLinkOptions,
) => ReturnType<CreateProviderCheckout> = async (stripe, options) => {
	void stripe;
	void options;
	return rejectStripeCheckout();
};

export const createStripeCheckoutLink: (
	stripe: Stripe,
	options: CreateCheckoutLinkOptions,
) => ReturnType<CreateCheckoutLink> = async (stripe, options) =>
	(await createStripeCheckout(stripe, options)).checkoutUrl;
