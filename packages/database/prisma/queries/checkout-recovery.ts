import {
	requestCheckoutRecoveryWithStore,
	claimCheckoutRecoveryWithStore,
	claimCheckoutActivationWithStore,
	finishCheckoutRecoveryWithStore,
	hasCheckoutFinancialReceipt,
	type CheckoutRecoveryPersistence,
	type OwnedCheckoutRecoveryInput,
	type CheckoutRecoveryResultInput,
} from "../../shared/checkout-recovery";
import type { Prisma } from "../generated/client";
import { runSerializable, type MediaTransactionClient } from "./media/types";
export {
	checkoutRecoveryView,
	readCheckoutRecovery,
	checkoutRecoveryStatusSchema,
} from "../../shared/checkout-recovery";
export type { CheckoutRecovery, RecoverableCheckout } from "../../shared/checkout-recovery";

export function checkoutRecoveryStore(client: MediaTransactionClient): CheckoutRecoveryPersistence {
	return {
		transaction: (work) =>
			runSerializable(client, async (tx) =>
				work({
					async lock(owner) {
						const scope = `payment-subscription:${JSON.stringify([owner.ownerType, owner.ownerId])}`;
						await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))::text AS "locked"`;
					},
					find: (id) =>
						tx.paymentCheckoutIntent.findUnique({ where: { id }, include: { billingPlan: true } }),
					async hasFinancialActivity(intent) {
						const subscription = await tx.subscription.findFirst({
							where: {
								ownerType: intent.ownerType,
								ownerId: intent.ownerId,
								OR: [
									{
										provider: intent.provider,
										providerSubscriptionId: {
											in: [intent.providerSessionId, intent.providerOrderId].filter(
												(v): v is string => Boolean(v),
											),
										},
									},
									{
										refundTerminatedAt: null,
										OR: [
											{ status: { in: ["ACTIVE", "PENDING", "PAST_DUE"] } },
											{ currentPeriodEnd: { gt: new Date() } },
											{ provider: { in: ["paypal", "waffo"] }, renewalDisabledAt: null },
										],
									},
								],
							},
							select: { id: true },
						});
						if (subscription) return true;
						const events = await tx.paymentEvent.findMany({
							where: {
								provider: intent.provider,
								OR: [
									{
										providerSubscriptionId: {
											in: [intent.providerSessionId, intent.providerOrderId].filter(
												(v): v is string => Boolean(v),
											),
										},
									},
									{ envelope: { path: ["resource", "custom_id"], equals: intent.id } },
									{ envelope: { path: ["data", "orderMerchantExternalId"], equals: intent.id } },
								],
							},
							select: { envelope: true },
							take: 1001,
						});
						return (
							events.length > 1000 ||
							events.some((event) => hasCheckoutFinancialReceipt(event.envelope))
						);
					},
					update: (id, patch) =>
						tx.paymentCheckoutIntent.update({
							where: { id },
							data: {
								...patch,
								checkoutRecovery: JSON.parse(
									JSON.stringify(patch.checkoutRecovery),
								) as Prisma.InputJsonValue,
							},
							include: { billingPlan: true },
						}),
					async enqueue(id, sequence, availableAt) {
						await tx.outboxEvent.upsert({
							where: { dedupeKey: `checkout-recovery:${id}:${sequence}` },
							create: {
								eventType: "SUBSCRIPTION_CHECKOUT_RECOVERY",
								aggregateType: "PAYMENT_CHECKOUT_INTENT",
								aggregateId: id,
								dedupeKey: `checkout-recovery:${id}:${sequence}`,
								payload: { checkoutIntentId: id, sequence },
								availableAt,
							},
							update: {},
						});
					},
					async audit(intent, action, actorUserId) {
						await tx.auditLog.create({
							data: {
								actorUserId,
								action,
								targetType: "PAYMENT_CHECKOUT_INTENT",
								targetId: intent.id,
								metadata: { provider: intent.provider },
							},
						});
					},
				}),
			),
	};
}
export function requestCheckoutRecovery(
	input: OwnedCheckoutRecoveryInput,
	client: MediaTransactionClient,
) {
	return requestCheckoutRecoveryWithStore(input, checkoutRecoveryStore(client));
}
export function claimCheckoutRecovery(
	input: Parameters<typeof claimCheckoutRecoveryWithStore>[0],
	client: MediaTransactionClient,
) {
	return claimCheckoutRecoveryWithStore(input, checkoutRecoveryStore(client));
}
export function claimCheckoutActivation(
	input: Parameters<typeof claimCheckoutActivationWithStore>[0],
	client: MediaTransactionClient,
) {
	return claimCheckoutActivationWithStore(input, checkoutRecoveryStore(client));
}
export function finishCheckoutRecovery(
	input: CheckoutRecoveryResultInput,
	client: MediaTransactionClient,
) {
	return finishCheckoutRecoveryWithStore(input, checkoutRecoveryStore(client));
}
export function getPendingCheckoutForOwner(
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: MediaTransactionClient,
) {
	return client.paymentCheckoutIntent.findFirst({
		where: {
			...owner,
			productKind: "PLAN",
			provider: { in: ["paypal", "waffo"] },
			status: { in: ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING", "REVIEW"] },
		},
		include: { billingPlan: true },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
	});
}
/** Hourly recovery also covers lost workers and browser tabs closed before return. */
export async function recoverPendingCheckouts(
	client: MediaTransactionClient,
	limit = 100,
	now = new Date(),
) {
	const candidates = await client.$queryRaw<
		Array<{
			id: string;
			ownerType: "USER" | "ORGANIZATION";
			ownerId: string;
			submittedByUserId: string;
		}>
	>`
		SELECT "id", "ownerType", "ownerId", "submittedByUserId" FROM payment_checkout_intent
		WHERE "productKind" = 'PLAN' AND provider IN ('paypal', 'waffo') AND status IN ('PROVIDER_PENDING', 'PROVIDER_CREATING', 'REVIEW')
		AND COALESCE(("checkoutRecovery"->>'nextCheckAt')::timestamptz, '-infinity') <= ${now}
		AND COALESCE(("checkoutRecovery"->>'leasedUntil')::timestamptz, '-infinity') <= ${now}
		ORDER BY "updatedAt", "id" LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
	for (const candidate of candidates)
		await requestCheckoutRecovery(
			{ ...candidate, actorUserId: candidate.submittedByUserId, now },
			client,
		);
	return { requeued: candidates.length };
}
