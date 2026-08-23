import { db } from "@repo/database/client";
import { processStripePaymentEvent, type PaymentEventAttempt } from "@repo/payments";

export async function processPaymentEvent(
	payload: { paymentEventId: string },
	attempt: PaymentEventAttempt,
) {
	return processStripePaymentEvent(payload, db, attempt);
}
