import { PORTRAIT_PACK_TRIAL_LIMIT } from "@repo/config/portrait-packs";

export interface PortraitPackTrialInput {
	subjectKey: string;
	requestId: string;
	cardKeys: string[];
}

export function existingPortraitPackTrial<T extends { requestId: string }>(
	issued: readonly T[],
	requestId: string,
) {
	return (
		issued.find((receipt) => receipt.requestId === requestId) ??
		(issued.length >= PORTRAIT_PACK_TRIAL_LIMIT ? issued.at(-1) : undefined)
	);
}

// A prior real payment qualifies after the subscription ends or the credits expire.
// The linked payment event distinguishes a live purchase from a sandbox fulfillment.
export const PORTRAIT_PACK_PURCHASE_SQL = `WITH viewer AS (SELECT $1::text AS id)
SELECT (
	EXISTS (
		SELECT 1 FROM credit_pack_fulfillment f
		JOIN payment_checkout_intent c ON c.id = f."checkoutIntentId"
		CROSS JOIN viewer v
		WHERE c.status = 'COMPLETED' AND c."productKind" = 'CREDIT_PACK'
			AND c.provider = f.provider
			AND c."ownerType" = f."ownerType" AND c."ownerId" = f."ownerId"
			AND ((f."ownerType" = 'USER' AND f."ownerId" = v.id)
				OR (f."ownerType" = 'ORGANIZATION' AND c."submittedByUserId" = v.id))
			AND f.status IN ('FULFILLED', 'PARTIALLY_REFUNDED')
			AND f."paidAmountMicros" > f."refundedAmountMicros"
			AND EXISTS (
				SELECT 1 FROM payment_event e
				WHERE e.provider = f.provider AND e.status = 'PROCESSED'
					AND e."verifiedAt" IS NOT NULL
					AND ((e.provider = 'paypal' AND e."providerEnvironment" = 'live'
						AND e.envelope->>'event_type' = 'PAYMENT.CAPTURE.COMPLETED'
						AND (e."normalizedTransactionId" = f."providerPaymentId"
							OR e.envelope->'resource'->>'id' = f."providerPaymentId"))
					OR (e.provider = 'waffo' AND e."providerEnvironment" = 'prod'
						AND e.envelope->>'eventType' = 'order.completed'
						AND (e.envelope->'data'->>'paymentId' = f."providerPaymentId"
							OR e.envelope->'data'->'payment'->>'paymentId' = f."providerPaymentId")))
			)
	) OR EXISTS (
		SELECT 1 FROM subscription s JOIN billing_period p ON p."subscriptionId" = s.id
		CROSS JOIN viewer v
		WHERE ((s."ownerType" = 'USER' AND s."ownerId" = v.id)
			OR (s."ownerType" = 'ORGANIZATION' AND EXISTS (
				SELECT 1 FROM payment_checkout_intent c
				WHERE c."ownerType" = 'ORGANIZATION' AND c."ownerId" = s."ownerId"
					AND c.provider = s.provider AND c."productKind" = 'PLAN'
					AND c.status = 'COMPLETED' AND c."submittedByUserId" = v.id
					AND (c.id = s."initialPaymentEvidence"->>'checkoutIntentId'
						OR (s.provider = 'paypal' AND c."providerSessionId" = s."providerSubscriptionId")
						OR (s.provider = 'waffo' AND c."providerOrderId" = s."providerSubscriptionId"))
			)))
			AND p.status IN ('ACTIVE', 'CLOSED') AND p."paidAmount" > p."refundedAmount"
			AND EXISTS (
				SELECT 1 FROM payment_event e
				WHERE e.provider = s.provider AND e.status = 'PROCESSED'
					AND e."verifiedAt" IS NOT NULL
					AND ((e.provider = 'paypal' AND e."providerEnvironment" = 'live'
						AND e.envelope->>'event_type' = 'PAYMENT.SALE.COMPLETED'
						AND e.envelope->'resource'->>'billing_agreement_id' = s."providerSubscriptionId"
						AND e.envelope->'resource'->>'id' = regexp_replace(p."providerInvoicePaymentId", '^paypal:', ''))
					OR (e.provider = 'waffo' AND e."providerEnvironment" = 'prod'
						AND e.envelope->>'eventType' = 'subscription.payment_succeeded'
						AND e.envelope->'data'->>'orderId' = s."providerSubscriptionId"
						AND e.envelope->'data'->>'paymentId' = regexp_replace(p."providerInvoicePaymentId", '^waffo:', ''))
					OR (e.provider = 'stripe' AND e.envelope->>'type' = 'invoice.paid'
						AND e.envelope->'livemode' = 'true'::jsonb
						AND e.envelope->'data'->'object'->>'id' = p."providerInvoiceId"))
			)
	)
) AS unlocked`;
