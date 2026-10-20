import {
	microsToStripeMinor,
	paymentCurrency,
	stripeMinorToMicros,
	type AdminRefundPayment,
} from "@repo/database";
import type Stripe from "stripe";

import type {
	AdminRefundAdapter,
	AdminRefundObservation,
	AdminRefundRequestRecord,
} from "./admin-refunds-types";
import { getStripeClient } from "./stripe";

export function createStripeAdminRefundAdapter(
	stripe: Pick<Stripe, "charges" | "refunds"> = getStripeClient(),
): AdminRefundAdapter {
	function normalize(
		payment: AdminRefundPayment,
		request: AdminRefundRequestRecord,
		refund: Stripe.Refund,
	): AdminRefundObservation {
		const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
		if (
			chargeId !== payment.providerChargeId ||
			paymentCurrency(refund.currency) !== request.currency ||
			stripeMinorToMicros(BigInt(refund.amount), request.currency) !== request.amountMicros ||
			refund.metadata?.admin_refund_request !== request.providerRequestId
		)
			throw new Error("STRIPE_REFUND_BINDING_MISMATCH");
		if (refund.status === "succeeded")
			return {
				status: "SUCCEEDED",
				providerRefundId: refund.id,
				amountMicros: request.amountMicros,
				currency: request.currency,
				occurredAt: new Date(refund.created * 1_000),
			};
		if (refund.status === "failed" || refund.status === "canceled")
			return { status: "FAILED", providerRefundId: refund.id, error: "STRIPE_REFUND_FAILED" };
		return { status: "PROCESSING", providerRefundId: refund.id };
	}
	return {
		name: "stripe",
		async verifyPayment(payment) {
			if (payment.provider !== "stripe" || !payment.providerChargeId)
				throw new Error("STRIPE_REFUND_PAYMENT_UNSUPPORTED");
			const charge = await stripe.charges.retrieve(payment.providerChargeId);
			if (
				charge.id !== payment.providerChargeId ||
				!charge.paid ||
				!charge.captured ||
				charge.livemode !== (payment.providerEnvironment === "live") ||
				paymentCurrency(charge.currency) !== payment.currency ||
				stripeMinorToMicros(BigInt(charge.amount_captured), payment.currency) !==
					payment.amountMicros ||
				stripeMinorToMicros(BigInt(charge.amount_refunded), payment.currency) !==
					payment.refundedAmountMicros ||
				(payment.providerPaymentIntentId &&
					(typeof charge.payment_intent === "string"
						? charge.payment_intent
						: charge.payment_intent?.id) !== payment.providerPaymentIntentId)
			)
				throw new Error("STRIPE_REFUND_PAYMENT_MISMATCH");
		},
		async submit(payment, request) {
			if (!payment.providerChargeId) throw new Error("STRIPE_REFUND_PAYMENT_UNSUPPORTED");
			const minor = microsToStripeMinor(request.amountMicros, request.currency);
			if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("STRIPE_REFUND_AMOUNT_INVALID");
			const refund = await stripe.refunds.create(
				{
					charge: payment.providerChargeId,
					amount: Number(minor),
					reason: "requested_by_customer",
					metadata: { admin_refund_request: request.providerRequestId },
				},
				{ idempotencyKey: request.providerRequestId },
			);
			return normalize(payment, request, refund);
		},
		async inspect(payment, request) {
			if (!payment.providerChargeId) throw new Error("STRIPE_REFUND_PAYMENT_UNSUPPORTED");
			if (request.providerRefundId)
				return normalize(payment, request, await stripe.refunds.retrieve(request.providerRefundId));
			let startingAfter: string | undefined;
			const matches: Stripe.Refund[] = [];
			for (let page = 0; page < 10; page += 1) {
				const result = await stripe.refunds.list({
					charge: payment.providerChargeId,
					limit: 100,
					...(startingAfter ? { starting_after: startingAfter } : {}),
				});
				matches.push(
					...result.data.filter(
						(refund) => refund.metadata?.admin_refund_request === request.providerRequestId,
					),
				);
				if (!result.has_more) {
					return matches.length === 1
						? normalize(payment, request, matches[0]!)
						: { status: "UNKNOWN", error: "STRIPE_REFUND_CONFIRMATION_PENDING" };
				}
				startingAfter = result.data.at(-1)?.id;
				if (!startingAfter) break;
			}
			return { status: "UNKNOWN", error: "STRIPE_REFUND_CONFIRMATION_PENDING" };
		},
	};
}
