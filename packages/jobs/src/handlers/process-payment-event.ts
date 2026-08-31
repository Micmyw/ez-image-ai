import { db } from "@repo/database/client";
import {
	createStripeBillingSource,
	getStripeClient,
	processProviderPaymentEvent,
	processStripePaymentEvent,
	type PaymentEventAttempt,
} from "@repo/payments";

export async function processPaymentEvent(
	payload: { paymentEventId: string },
	attempt: PaymentEventAttempt,
) {
	const event = await db.paymentEvent.findUnique({
		where: { id: payload.paymentEventId },
		select: { provider: true },
	});
	if (event?.provider !== "stripe") {
		return processProviderPaymentEvent(payload, db, attempt);
	}
	return processStripePaymentEvent(payload, db, attempt, {
		billingSource: createStripeBillingSource(getStripeClient()),
	});
}
