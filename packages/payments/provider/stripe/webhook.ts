import type { IngestPaymentEventInput } from "@repo/database";
import { logger } from "@repo/logs";
import type Stripe from "stripe";

import type { VerifiedPaymentEvent } from "../webhook";

interface StripeWebhookDependencies {
	stripe: Stripe;
	webhookSecret: string;
	persist(input: IngestPaymentEventInput): Promise<{ replayed: boolean }>;
}

type StripeWebhookVerifierDependencies = Pick<
	StripeWebhookDependencies,
	"stripe" | "webhookSecret"
>;

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

export function createStripeWebhookVerifier(dependencies: StripeWebhookVerifierDependencies) {
	return async (rawBody: string, headers: Headers): Promise<VerifiedPaymentEvent> => {
		const signature = headers.get("stripe-signature");
		if (!signature || !dependencies.webhookSecret) {
			throw new Error("STRIPE_WEBHOOK_SIGNATURE_MISSING");
		}
		const event = await dependencies.stripe.webhooks.constructEventAsync(
			rawBody,
			signature,
			dependencies.webhookSecret,
		);
		return {
			providerEventId: event.id,
			normalizedTransactionId: getStripeNormalizedTransactionId(event),
			envelope: JSON.parse(JSON.stringify(event)) as Record<string, unknown>,
		};
	};
}

export function createStripeWebhookHandler(dependencies: StripeWebhookDependencies) {
	return async function stripeWebhookHandler(request: Request): Promise<Response> {
		let event: VerifiedPaymentEvent;
		try {
			const rawBody = await request.text();
			event = await createStripeWebhookVerifier(dependencies)(rawBody, request.headers);
		} catch {
			return new Response("Invalid request.", { status: 400 });
		}

		try {
			await dependencies.persist({
				provider: "stripe",
				providerEventId: event.providerEventId,
				normalizedTransactionId: event.normalizedTransactionId,
				verifiedAt: new Date(),
				receivedAt: new Date(),
				envelope: event.envelope as never,
			});
			return new Response(null, { status: 204 });
		} catch (error) {
			logger.error(
				{
					errorClass: classifyPersistenceError(error),
					providerEventId: event.providerEventId,
				},
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
