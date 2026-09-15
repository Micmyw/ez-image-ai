import { db } from "@repo/database/client";
import { getPaymentProvider, terminateRefundedSubscription } from "@repo/payments";

export function terminateSubscriptionAfterRefund(input: { subscriptionId: string }) {
	return terminateRefundedSubscription(input, db, {
		getProvider: getPaymentProvider,
		environment: process.env,
	});
}
