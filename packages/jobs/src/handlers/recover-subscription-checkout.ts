import { db } from "@repo/database/client";
import { getPaymentProvider, recoverSubscriptionCheckout } from "@repo/payments";

export function recoverCheckout(input: { checkoutIntentId: string; sequence: number }) {
	return recoverSubscriptionCheckout(input, db, {
		getProvider: getPaymentProvider,
		environment: process.env,
	});
}
