import { IMAGE_PASS_AMOUNT_MICROS } from "@repo/config/image-pass.server";
import {
	fulfillImagePassPurchaseInTransaction,
	revokeImagePassPurchaseInTransaction,
	getImagePassPurchaseByProviderPayment,
	PAYMENT_PROVIDER_CORRELATION_MISSING,
	type Prisma,
} from "@repo/database";

import {
	normalizeProviderPaymentEvent,
	type CreditPackPaymentFact,
	type CreditPackRefundFact,
} from "./lifecycle-normalization";

type Tx = Prisma.TransactionClient;

export async function lockImagePassPayment(providerPaymentId: string, tx: Tx) {
	await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`image-pass-payment:paypal:${providerPaymentId}`}, 0))::text AS "locked"`;
}

/** Called only for a persisted, verified PayPal event after product-kind routing. */
export async function applyImagePassPaymentFact(
	fact: CreditPackPaymentFact,
	tx: Tx,
	options: { paymentEventId?: string } = {},
): Promise<{ grantsCreated: number }> {
	if (
		fact.provider !== "paypal" ||
		fact.amountMicros !== IMAGE_PASS_AMOUNT_MICROS ||
		fact.currency !== "USD"
	)
		throw new Error("IMAGE_PASS_PAYMENT_AMOUNT_INVALID");
	if (!fact.checkoutIntentId) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	await lockImagePassPayment(fact.providerPaymentId, tx);
	const result = await fulfillImagePassPurchaseInTransaction(
		{
			checkoutIntentId: fact.checkoutIntentId,
			provider: "paypal",
			providerPaymentId: fact.providerPaymentId,
			providerOrderId: fact.providerOrderId,
			amountMicros: fact.amountMicros,
			currency: fact.currency,
			occurredAt: fact.occurredAt,
			paymentEventId: options.paymentEventId,
		},
		tx,
	);
	await requeueImagePassAdjustments(fact.providerPaymentId, tx);
	return { grantsCreated: result.created ? 1 : 0 };
}

/** Returns null for another product so its existing reducer remains authoritative. */
export async function tryApplyImagePassAdjustment(
	fact: CreditPackRefundFact,
	tx: Tx,
	kind: "REFUND" | "DISPUTE" = fact.adjustmentKind === "REVERSAL" ? "DISPUTE" : "REFUND",
): Promise<{ grantsCreated: number } | null> {
	if (fact.provider !== "paypal") return null;
	await lockImagePassPayment(fact.providerPaymentId, tx);
	const grant = await getImagePassPurchaseByProviderPayment(
		{ provider: "paypal", providerPaymentId: fact.providerPaymentId },
		tx,
	);
	if (!grant) return null;
	await revokeImagePassPurchaseInTransaction(
		{
			provider: "paypal",
			providerPaymentId: fact.providerPaymentId,
			providerAdjustmentId: fact.providerRefundId,
			amountMicros: fact.amountMicros,
			currency: fact.currency,
			occurredAt: fact.occurredAt,
			kind,
		},
		tx,
	);
	return { grantsCreated: 0 };
}

export async function requeueImagePassAdjustments(providerPaymentId: string, tx: Tx) {
	const candidates = await tx.$queryRaw<Array<{ id: string; envelope: unknown }>>`
		SELECT event."id", event."envelope" FROM "payment_event" event
		WHERE event."provider" = 'paypal' AND event."status" IN ('FAILED','DEAD_LETTER')
		AND event."lastErrorClass" = 'TRANSIENT'
		AND event."failureReason" = ${PAYMENT_PROVIDER_CORRELATION_MISSING}
		AND ((event."envelope"->>'event_type' = 'PAYMENT.CAPTURE.REVERSED'
		  AND event."envelope" #>> '{resource,id}' = ${providerPaymentId})
		OR (event."envelope"->>'event_type' = 'PAYMENT.CAPTURE.REFUNDED' AND EXISTS (
		 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event."envelope" #> '{resource,links}') = 'array'
		 THEN event."envelope" #> '{resource,links}' ELSE '[]'::jsonb END) link
		 WHERE link->>'rel' = 'up' AND substring(link->>'href' FROM '^https://[^/]+/v2/payments/captures/([^/]+)$') = ${providerPaymentId}))
		OR (event."envelope"->>'event_type' = 'CUSTOMER.DISPUTE.CREATED' AND EXISTS (
		 SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(event."envelope" #> '{resource,disputed_transactions}') = 'array'
		 THEN event."envelope" #> '{resource,disputed_transactions}' ELSE '[]'::jsonb END) disputed
		 WHERE disputed->>'seller_transaction_id' = ${providerPaymentId})))
		ORDER BY event."receivedAt", event."id" FOR UPDATE OF event SKIP LOCKED`;
	for (const candidate of candidates) {
		let normalized;
		try {
			normalized = normalizeProviderPaymentEvent("paypal", candidate.envelope);
		} catch {
			continue;
		}
		if (
			!(["CREDIT_PACK_REFUNDED", "PAYMENT_REFUNDED", "PAYMENT_DISPUTED"] as string[]).includes(
				normalized.kind,
			) ||
			!("providerPaymentId" in normalized.fact) ||
			normalized.fact.providerPaymentId !== providerPaymentId
		)
			continue;
		const changed = await tx.paymentEvent.updateMany({
			where: {
				id: candidate.id,
				status: { in: ["FAILED", "DEAD_LETTER"] },
				lastErrorClass: "TRANSIENT",
				failureReason: PAYMENT_PROVIDER_CORRELATION_MISSING,
			},
			data: {
				status: "FAILED",
				attemptCount: 0,
				processedAt: null,
				processingToken: null,
				processingLeasedUntil: null,
			},
		});
		if (changed.count !== 1) continue;
		const dedupeKey = `image-pass-adjustment-correlation-replay:${candidate.id}`;
		await tx.outboxEvent.upsert({
			where: { dedupeKey },
			create: {
				eventType: "PAYMENT_EVENT_RECEIVED",
				aggregateType: "PAYMENT_EVENT",
				aggregateId: candidate.id,
				dedupeKey,
				payload: { paymentEventId: candidate.id },
			},
			update: {},
		});
	}
}
