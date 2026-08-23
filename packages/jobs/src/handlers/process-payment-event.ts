import { db } from "@repo/database/client";
import { processStripePaymentEvent } from "@repo/payments";

export async function processPaymentEvent(payload: { paymentEventId: string }) {
	return processStripePaymentEvent(payload, db);
}
