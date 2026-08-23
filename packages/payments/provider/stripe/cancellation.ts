import Stripe from "stripe";

interface StripeSubscriptionCancellationClient {
	subscriptions: {
		retrieve: (subscriptionId: string) => Promise<{ status: string }>;
		cancel: (subscriptionId: string) => Promise<unknown>;
	};
}

export async function cancelStripeSubscription(
	stripe: StripeSubscriptionCancellationClient,
	subscriptionId: string,
) {
	const subscription = await retrieveStripeSubscription(stripe, subscriptionId);

	if (!subscription || subscription.status === "canceled") {
		return;
	}

	try {
		await stripe.subscriptions.cancel(subscriptionId);
	} catch (error) {
		if (isMissingStripeSubscription(error)) {
			return;
		}

		throw error;
	}
}

async function retrieveStripeSubscription(
	stripe: StripeSubscriptionCancellationClient,
	subscriptionId: string,
) {
	try {
		return await stripe.subscriptions.retrieve(subscriptionId);
	} catch (error) {
		if (isMissingStripeSubscription(error)) {
			return null;
		}

		throw error;
	}
}

function isMissingStripeSubscription(error: unknown) {
	return (
		error instanceof Stripe.errors.StripeInvalidRequestError &&
		error.code === "resource_missing" &&
		error.param === "id"
	);
}
