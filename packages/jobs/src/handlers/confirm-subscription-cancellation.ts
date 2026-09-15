import { db } from "@repo/database/client";
import { confirmSubscriptionCancellation, getPaymentProvider } from "@repo/payments";

export function confirmCancellation(input: { subscriptionId: string }) {
	return confirmSubscriptionCancellation(input, db, {
		getProvider: getPaymentProvider,
		environment: process.env,
	});
}
