import type { IngestPaymentEventInput } from "@repo/database";
import { logger } from "@repo/logs";
import type Stripe from "stripe";

interface StripeWebhookDependencies {
	stripe: Stripe;
	webhookSecret: string;
	persist(input: IngestPaymentEventInput): Promise<{ replayed: boolean }>;
}

export function getStripeNormalizedTransactionId(event: Stripe.Event): string | undefined {
	const object = event.data.object as Stripe.Event.Data.Object & {
		id?: string;
		charge?: string | Stripe.Charge | null;
		payment_intent?: string | Stripe.PaymentIntent | null;
	};
	if (
		event.type === "refund.created" ||
		event.type === "refund.updated" ||
		event.type === "refund.failed" ||
		event.type === "charge.refund.updated"
	) {
		return object.id ? `refund:${object.id}` : undefined;
	}
	if (event.type === "invoice.paid") return object.id ? `invoice:${object.id}` : undefined;
	const transaction = object.payment_intent ?? object.charge;
	if (typeof transaction === "string" && transaction.length > 0) return transaction;
	if (transaction && typeof transaction === "object" && transaction.id) return transaction.id;
	return undefined;
}

export function createStripeWebhookHandler(dependencies: StripeWebhookDependencies) {
	return async function stripeWebhookHandler(request: Request): Promise<Response> {
		const signature = request.headers.get("stripe-signature");
		if (!signature || !dependencies.webhookSecret) {
			return new Response("Invalid request.", { status: 400 });
		}

		let event: Stripe.Event;
		try {
			const rawBody = await request.text();
			event = await dependencies.stripe.webhooks.constructEventAsync(
				rawBody,
				signature,
				dependencies.webhookSecret,
			);
		} catch {
			return new Response("Invalid request.", { status: 400 });
		}

		try {
			await dependencies.persist({
				provider: "stripe",
				providerEventId: event.id,
				normalizedTransactionId: getStripeNormalizedTransactionId(event),
				verifiedAt: new Date(),
				receivedAt: new Date(),
				envelope: JSON.parse(JSON.stringify(event)),
			});
			return new Response(null, { status: 204 });
		} catch (error) {
			logger.error(
				{ errorClass: classifyPersistenceError(error), providerEventId: event.id },
				"Stripe payment event persistence failed",
			);
			return new Response("Webhook persistence failed.", { status: 500 });
		}
	};
}

function classifyPersistenceError(
	error: unknown,
): "DATABASE_CONFLICT" | "DATABASE_UNAVAILABLE" | "DATABASE_ERROR" {
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	if (code === "P2002") return "DATABASE_CONFLICT";
	if (
		code === "P1000" ||
		code === "P1001" ||
		code === "P1002" ||
		code === "P1008" ||
		code === "P1017" ||
		code === "P2024"
	) {
		return "DATABASE_UNAVAILABLE";
	}
	return "DATABASE_ERROR";
}
