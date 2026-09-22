import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
	requestCheckoutRecoveryWithStore,
	claimCheckoutRecoveryWithStore,
	claimCheckoutActivationWithStore,
	finishCheckoutRecoveryWithStore,
	resolveCheckoutReviewWithStore,
	hasCheckoutFinancialReceipt,
	type CheckoutRecoveryPersistence,
	type OwnedCheckoutRecoveryInput,
	type CheckoutRecoveryResultInput,
} from "../../shared/checkout-recovery";
import { db } from "../client";
import { paymentCheckoutIntent, billingPlan } from "../schema/postgres";
export {
	checkoutRecoveryView,
	readCheckoutRecovery,
	checkoutRecoveryStatusSchema,
	canReviewLegacyCheckout,
} from "../../shared/checkout-recovery";
export type {
	CheckoutRecovery,
	RecoverableCheckout,
	CheckoutReviewObservation,
} from "../../shared/checkout-recovery";

export function checkoutRecoveryStore(): CheckoutRecoveryPersistence {
	return {
		transaction: (work) =>
			db.transaction(
				async (tx) => {
					async function find(id: string) {
						const [row] = await tx
							.select({ intent: paymentCheckoutIntent, billingPlan })
							.from(paymentCheckoutIntent)
							.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
							.where(eq(paymentCheckoutIntent.id, id))
							.limit(1);
						return row ? { ...row.intent, billingPlan: row.billingPlan } : null;
					}
					return work({
						async lock(owner) {
							const scope = `payment-subscription:${JSON.stringify([owner.ownerType, owner.ownerId])}`;
							await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
						},
						async lockProvider(intent) {
							for (const id of [
								...new Set(
									[intent.providerSessionId, intent.providerOrderId].filter((id): id is string =>
										Boolean(id),
									),
								),
							].sort((a, b) => a.localeCompare(b))) {
								const scope = `${intent.provider}:${id}`;
								await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
							}
						},
						find,
						async hasFinancialActivity(intent, requireUnapproved) {
							if (requireUnapproved) {
								const purchases = await tx.execute(
									sql`SELECT id FROM purchase WHERE provider = ${intent.provider} AND "subscriptionId" IN (${intent.providerSessionId}, ${intent.providerOrderId}) LIMIT 1`,
								);
								if (purchases.rows.length) return true;
							}
							const subscriptions =
								await tx.execute(sql`SELECT id FROM subscription WHERE "ownerType" = ${intent.ownerType} AND "ownerId" = ${intent.ownerId}
				AND ((provider = ${intent.provider} AND "providerSubscriptionId" IN (${intent.providerSessionId}, ${intent.providerOrderId}))
				OR ("refundTerminatedAt" IS NULL AND (status IN ('ACTIVE','PENDING','PAST_DUE') OR "currentPeriodEnd" > ${new Date()} OR (provider IN ('paypal','waffo') AND "renewalDisabledAt" IS NULL)))) LIMIT 1`);
							if (subscriptions.rows.length) return true;
							const events = await tx.execute<{
								envelope: unknown;
							}>(sql`SELECT envelope FROM payment_event WHERE provider = ${intent.provider} AND
				("providerSubscriptionId" IN (${intent.providerSessionId}, ${intent.providerOrderId}) OR envelope->'resource'->>'custom_id' = ${intent.id} OR envelope->'data'->>'orderMerchantExternalId' = ${intent.id}) LIMIT 1001`);
							return (
								events.rows.length > 1000 ||
								events.rows.some((event) =>
									hasCheckoutFinancialReceipt(event.envelope, requireUnapproved),
								)
							);
						},
						async update(id, patch) {
							await tx
								.update(paymentCheckoutIntent)
								.set({
									...patch,
									checkoutRecovery: JSON.parse(JSON.stringify(patch.checkoutRecovery)),
									updatedAt: new Date(),
								})
								.where(eq(paymentCheckoutIntent.id, id));
							return (await find(id))!;
						},
						async enqueue(id, sequence, availableAt) {
							await tx.execute(
								sql`INSERT INTO outbox_event (id, "eventType", "aggregateType", "aggregateId", "dedupeKey", payload, "availableAt") VALUES (${crypto.randomUUID()}, 'SUBSCRIPTION_CHECKOUT_RECOVERY', 'PAYMENT_CHECKOUT_INTENT', ${id}, ${`checkout-recovery:${id}:${sequence}`}, ${JSON.stringify({ checkoutIntentId: id, sequence })}::jsonb, ${availableAt}) ON CONFLICT ("dedupeKey") DO NOTHING`,
							);
						},
						async audit(intent, action, actorUserId, metadata) {
							await tx.execute(
								sql`INSERT INTO audit_log (id, "actorUserId", action, "targetType", "targetId", metadata) VALUES (${crypto.randomUUID()}, ${actorUserId ?? null}, ${action}, 'PAYMENT_CHECKOUT_INTENT', ${intent.id}, ${JSON.stringify({ ...metadata, provider: intent.provider })}::jsonb)`,
							);
						},
					});
				},
				{ isolationLevel: "serializable" },
			),
	};
}
export function requestCheckoutRecovery(input: OwnedCheckoutRecoveryInput) {
	return requestCheckoutRecoveryWithStore(input, checkoutRecoveryStore());
}
export function resolveCheckoutReview(input: Parameters<typeof resolveCheckoutReviewWithStore>[0]) {
	return resolveCheckoutReviewWithStore(input, checkoutRecoveryStore());
}
export function claimCheckoutRecovery(input: Parameters<typeof claimCheckoutRecoveryWithStore>[0]) {
	return claimCheckoutRecoveryWithStore(input, checkoutRecoveryStore());
}
export function claimCheckoutActivation(
	input: Parameters<typeof claimCheckoutActivationWithStore>[0],
) {
	return claimCheckoutActivationWithStore(input, checkoutRecoveryStore());
}
export function finishCheckoutRecovery(input: CheckoutRecoveryResultInput) {
	return finishCheckoutRecoveryWithStore(input, checkoutRecoveryStore());
}
export async function getPendingCheckoutForOwner(owner: {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
}) {
	const [row] = await db
		.select({ intent: paymentCheckoutIntent, billingPlan })
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.where(
			and(
				eq(paymentCheckoutIntent.ownerType, owner.ownerType),
				eq(paymentCheckoutIntent.ownerId, owner.ownerId),
				eq(paymentCheckoutIntent.productKind, "PLAN"),
				inArray(paymentCheckoutIntent.provider, ["paypal", "waffo"]),
				inArray(paymentCheckoutIntent.status, [
					"CREATED",
					"PROVIDER_CREATING",
					"PROVIDER_PENDING",
					"REVIEW",
				]),
			),
		)
		.orderBy(desc(paymentCheckoutIntent.createdAt), desc(paymentCheckoutIntent.id))
		.limit(1);
	return row ? { ...row.intent, billingPlan: row.billingPlan } : null;
}
export async function recoverPendingCheckouts(limit = 100, now = new Date()) {
	const candidates = await db.execute<{
		id: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		submittedByUserId: string;
	}>(sql`
		SELECT "id", "ownerType", "ownerId", "submittedByUserId" FROM payment_checkout_intent WHERE "productKind" = 'PLAN'
		AND provider IN ('paypal','waffo') AND status IN ('PROVIDER_PENDING','PROVIDER_CREATING','REVIEW')
		AND COALESCE("checkoutRecovery"->>'status', 'PENDING') NOT IN ('REVIEW', 'PAID')
		AND COALESCE(("checkoutRecovery"->>'nextCheckAt')::timestamptz, '-infinity') <= ${now}
		AND COALESCE(("checkoutRecovery"->>'leasedUntil')::timestamptz, '-infinity') <= ${now}
		ORDER BY "updatedAt", "id" LIMIT ${Math.min(Math.max(limit, 1), 1000)}`);
	for (const candidate of candidates.rows)
		await requestCheckoutRecovery({ ...candidate, actorUserId: candidate.submittedByUserId, now });
	return { requeued: candidates.rows.length };
}
