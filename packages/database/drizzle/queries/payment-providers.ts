import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../client";
import {
	billingPlan,
	creditPackFulfillment,
	paymentCheckoutIntent,
	paymentCheckoutIntentIdempotencyAlias,
	paymentCustomer,
} from "../schema/postgres";

export type PaymentProviderName = "stripe" | "paypal" | "waffo";
export type CreditPackPaymentProviderName = Exclude<PaymentProviderName, "stripe">;
export type PaymentOwner = { ownerType: "USER" | "ORGANIZATION"; ownerId: string };

type PaymentProductKind = "PLAN" | "CREDIT_PACK";

export interface CreditPackCheckoutIntentSnapshotInput {
	catalogVersion: string;
	pricingVersion: string;
	subscriberEligibilityVersion: string;
	baseCredits: bigint;
	bonusCredits: bigint;
	totalCredits: bigint;
	expiryMonths: number;
	subscriberBonusEligible: boolean;
	subscriberSubscriptionId: string | null;
	subscriberPlanKey: string | null;
	eligibilityEvaluatedAt: Date;
}

interface CreatePaymentCheckoutIntentBase extends PaymentOwner {
	submittedByUserId: string;
	billingPlanId: string;
	planKey: string;
	idempotencyKey: string;
	now?: Date;
}

export type CreatePaymentCheckoutIntentInput = CreatePaymentCheckoutIntentBase &
	(
		| {
				provider: PaymentProviderName;
				productKind?: "PLAN";
				interval: "month" | "year";
				creditPackSnapshot?: never;
		  }
		| {
				provider: CreditPackPaymentProviderName;
				productKind: "CREDIT_PACK";
				interval: "one-time";
				creditPackSnapshot: CreditPackCheckoutIntentSnapshotInput;
		  }
	);

export async function getPaymentCustomer(provider: PaymentProviderName, owner: PaymentOwner) {
	const [row] = await db
		.select()
		.from(paymentCustomer)
		.where(
			and(
				eq(paymentCustomer.provider, provider),
				eq(paymentCustomer.ownerType, owner.ownerType),
				eq(paymentCustomer.ownerId, owner.ownerId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function upsertPaymentCustomer(
	input: PaymentOwner & { provider: PaymentProviderName; providerCustomerId: string },
) {
	const [row] = await db
		.insert(paymentCustomer)
		.values(input)
		.onConflictDoUpdate({
			target: [paymentCustomer.provider, paymentCustomer.ownerType, paymentCustomer.ownerId],
			set: { providerCustomerId: input.providerCustomerId, updatedAt: new Date() },
		})
		.returning();
	return row;
}

export async function createPaymentCheckoutIntent(input: CreatePaymentCheckoutIntentInput) {
	const now = input.now ?? new Date();
	const productKind = input.productKind ?? "PLAN";
	const creditPackSnapshot = creditPackSnapshotColumns(input);
	const activeScopeKey = paymentCheckoutActiveScope(input);
	const idempotencyScopeKey = paymentCheckoutIdempotencyScope(input);
	const result = await db.transaction(
		async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyScopeKey}, 0))`,
			);
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${activeScopeKey}, 0))`);
			const [directReplay] = await tx
				.select()
				.from(paymentCheckoutIntent)
				.where(
					and(
						eq(paymentCheckoutIntent.ownerType, input.ownerType),
						eq(paymentCheckoutIntent.ownerId, input.ownerId),
						eq(paymentCheckoutIntent.idempotencyKey, input.idempotencyKey),
					),
				)
				.limit(1);
			const [aliasReplay] = await tx
				.select({ intent: paymentCheckoutIntent })
				.from(paymentCheckoutIntentIdempotencyAlias)
				.innerJoin(
					paymentCheckoutIntent,
					eq(paymentCheckoutIntentIdempotencyAlias.checkoutIntentId, paymentCheckoutIntent.id),
				)
				.where(
					and(
						eq(paymentCheckoutIntentIdempotencyAlias.ownerType, input.ownerType),
						eq(paymentCheckoutIntentIdempotencyAlias.ownerId, input.ownerId),
						eq(paymentCheckoutIntentIdempotencyAlias.idempotencyKey, input.idempotencyKey),
					),
				)
				.limit(1);
			if (directReplay && aliasReplay) {
				throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
			}
			const replay = directReplay ?? aliasReplay?.intent;
			if (replay) {
				if (!matchesTrustedCheckoutCommand(replay, input)) {
					throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
				}
				if (replay.status === "CREATED") return { intent: replay, replayed: true };
				if (
					replay.status === "PROVIDER_PENDING" &&
					replay.providerSessionId &&
					replay.providerCheckoutUrl
				) {
					if (replay.expiresAt && replay.expiresAt <= now) {
						await tx
							.update(paymentCheckoutIntent)
							.set({ status: "EXPIRED", activeScopeKey: null, updatedAt: now })
							.where(eq(paymentCheckoutIntent.id, replay.id));
						return { unsafeReplay: true as const };
					}
					return { intent: replay, replayed: true };
				}
				throw new Error("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
			}

			const [active] = await tx
				.select()
				.from(paymentCheckoutIntent)
				.where(eq(paymentCheckoutIntent.activeScopeKey, activeScopeKey))
				.limit(1);
			if (
				active?.status === "PROVIDER_PENDING" &&
				active.providerSessionId &&
				active.providerCheckoutUrl &&
				active.expiresAt &&
				active.expiresAt <= now
			) {
				await tx
					.update(paymentCheckoutIntent)
					.set({ status: "EXPIRED", activeScopeKey: null, updatedAt: now })
					.where(eq(paymentCheckoutIntent.id, active.id));
			} else if (
				active?.status === "PROVIDER_PENDING" &&
				active.providerSessionId &&
				active.providerCheckoutUrl &&
				matchesTrustedCheckoutCommand(active, input)
			) {
				await tx.insert(paymentCheckoutIntentIdempotencyAlias).values({
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
					checkoutIntentId: active.id,
				});
				return { intent: active, replayed: true };
			} else if (active) {
				throw new Error("PAYMENT_CHECKOUT_INTENT_CONFLICT");
			}

			const [intent] = await tx
				.insert(paymentCheckoutIntent)
				.values({
					provider: input.provider,
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					submittedByUserId: input.submittedByUserId,
					productKind,
					billingPlanId: input.billingPlanId,
					planKey: input.planKey,
					interval: input.interval,
					idempotencyKey: input.idempotencyKey,
					activeScopeKey,
					expiresAt: null,
					...creditPackSnapshot,
				})
				.returning();
			if (!intent) throw new Error("PAYMENT_CHECKOUT_INTENT_CREATE_FAILED");
			return { intent, replayed: false };
		},
		{ isolationLevel: "serializable" },
	);
	if ("unsafeReplay" in result) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
	}
	return result;
}

export async function markPaymentCheckoutIntentProviderCreating(input: {
	intentId: string;
	provider: PaymentProviderName;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ status: "PROVIDER_CREATING", updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.status, "CREATED"),
				isNull(paymentCheckoutIntent.providerSessionId),
				isNull(paymentCheckoutIntent.providerCheckoutUrl),
			),
		)
		.returning();
	if (rows.length !== 1) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_PROVIDER_CREATE_CONFLICT");
	}
	return rows[0];
}

export async function resetPaymentCheckoutIntentProviderCreating(
	input: PaymentOwner & {
		intentId: string;
		provider: PaymentProviderName;
		expectedProductKind: PaymentProductKind;
	},
) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ status: "CREATED", updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.ownerType, input.ownerType),
				eq(paymentCheckoutIntent.ownerId, input.ownerId),
				eq(paymentCheckoutIntent.productKind, input.expectedProductKind),
				eq(paymentCheckoutIntent.status, "PROVIDER_CREATING"),
				isNull(paymentCheckoutIntent.providerSessionId),
				isNull(paymentCheckoutIntent.providerCheckoutUrl),
				isNull(paymentCheckoutIntent.providerOrderId),
			),
		)
		.returning({ id: paymentCheckoutIntent.id });
	return { count: rows.length };
}

export async function transitionPaymentCheckoutIntentToReview(
	input: PaymentOwner & {
		intentId: string;
		provider: PaymentProviderName;
		expectedStatus: "PROVIDER_CREATING" | "PROVIDER_PENDING";
		expectedProductKind: PaymentProductKind;
		expectedProviderSessionId?: string;
		expectedProviderOrderId?: string;
	},
) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ status: "REVIEW", updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.ownerType, input.ownerType),
				eq(paymentCheckoutIntent.ownerId, input.ownerId),
				eq(paymentCheckoutIntent.status, input.expectedStatus),
				eq(paymentCheckoutIntent.productKind, input.expectedProductKind),
				...(input.expectedProviderSessionId
					? [eq(paymentCheckoutIntent.providerSessionId, input.expectedProviderSessionId)]
					: []),
				...(input.expectedProviderOrderId
					? [eq(paymentCheckoutIntent.providerOrderId, input.expectedProviderOrderId)]
					: []),
			),
		)
		.returning({ id: paymentCheckoutIntent.id });
	return { count: rows.length };
}

export async function bindPaymentCheckoutIntentSession(input: {
	intentId: string;
	provider: PaymentProviderName;
	providerSessionId: string;
	providerOrderId?: string | null;
	providerCheckoutUrl: string;
	expiresAt?: Date | null;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({
			providerSessionId: input.providerSessionId,
			...(input.providerOrderId ? { providerOrderId: input.providerOrderId } : {}),
			providerCheckoutUrl: input.providerCheckoutUrl,
			status: "PROVIDER_PENDING",
			updatedAt: new Date(),
			expiresAt: input.expiresAt ?? null,
		})
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.status, "PROVIDER_CREATING"),
				isNull(paymentCheckoutIntent.providerSessionId),
				isNull(paymentCheckoutIntent.providerCheckoutUrl),
				...(input.providerOrderId ? [isNull(paymentCheckoutIntent.providerOrderId)] : []),
			),
		)
		.returning();
	if (rows.length !== 1) throw new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT");
	return rows[0];
}

export async function bindPaymentCheckoutIntentOrder(input: {
	intentId: string;
	provider: PaymentProviderName;
	providerOrderId: string;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ providerOrderId: input.providerOrderId, updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				isNull(paymentCheckoutIntent.providerOrderId),
				inArray(paymentCheckoutIntent.status, ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING"]),
			),
		)
		.returning();
	if (rows[0]) return rows[0];
	const [existing] = await db
		.select()
		.from(paymentCheckoutIntent)
		.where(eq(paymentCheckoutIntent.id, input.intentId))
		.limit(1);
	if (existing?.provider === input.provider && existing.providerOrderId === input.providerOrderId) {
		return existing;
	}
	throw new Error("PAYMENT_CHECKOUT_INTENT_ORDER_BINDING_CONFLICT");
}

export async function getPaymentCheckoutIntentByProviderSession(
	provider: PaymentProviderName,
	providerSessionId: string,
) {
	const [row] = await db
		.select({ intent: paymentCheckoutIntent, plan: billingPlan })
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.where(
			and(
				eq(paymentCheckoutIntent.provider, provider),
				eq(paymentCheckoutIntent.providerSessionId, providerSessionId),
			),
		)
		.limit(1);
	return row ? { ...row.intent, billingPlan: row.plan } : null;
}

export async function getPaymentCheckoutIntentByProviderOrder(
	provider: PaymentProviderName,
	providerOrderId: string,
) {
	const [row] = await db
		.select({ intent: paymentCheckoutIntent, plan: billingPlan })
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.where(
			and(
				eq(paymentCheckoutIntent.provider, provider),
				eq(paymentCheckoutIntent.providerOrderId, providerOrderId),
			),
		)
		.limit(1);
	return row ? { ...row.intent, billingPlan: row.plan } : null;
}

export async function getPaymentCheckoutIntentById(id: string) {
	const [row] = await db
		.select({ intent: paymentCheckoutIntent, plan: billingPlan })
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.where(eq(paymentCheckoutIntent.id, id))
		.limit(1);
	return row ? { ...row.intent, billingPlan: row.plan } : null;
}

export async function getPaymentCheckoutIntentForOwner(input: PaymentOwner & { intentId: string }) {
	const [row] = await db
		.select({
			intent: paymentCheckoutIntent,
			plan: billingPlan,
			fulfillment: creditPackFulfillment,
		})
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.leftJoin(
			creditPackFulfillment,
			eq(paymentCheckoutIntent.id, creditPackFulfillment.checkoutIntentId),
		)
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.ownerType, input.ownerType),
				eq(paymentCheckoutIntent.ownerId, input.ownerId),
			),
		)
		.limit(1);
	return row
		? { ...row.intent, billingPlan: row.plan, creditPackFulfillment: row.fulfillment }
		: null;
}

export async function getPaymentCheckoutIntentForOwnerByIdempotencyKey(
	input: PaymentOwner & { idempotencyKey: string },
) {
	const [directRow] = await db
		.select({
			intent: paymentCheckoutIntent,
			plan: billingPlan,
			fulfillment: creditPackFulfillment,
		})
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.leftJoin(
			creditPackFulfillment,
			eq(paymentCheckoutIntent.id, creditPackFulfillment.checkoutIntentId),
		)
		.where(
			and(
				eq(paymentCheckoutIntent.ownerType, input.ownerType),
				eq(paymentCheckoutIntent.ownerId, input.ownerId),
				eq(paymentCheckoutIntent.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	const [aliasRow] = await db
		.select({
			intent: paymentCheckoutIntent,
			plan: billingPlan,
			fulfillment: creditPackFulfillment,
		})
		.from(paymentCheckoutIntentIdempotencyAlias)
		.innerJoin(
			paymentCheckoutIntent,
			eq(paymentCheckoutIntentIdempotencyAlias.checkoutIntentId, paymentCheckoutIntent.id),
		)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.leftJoin(
			creditPackFulfillment,
			eq(paymentCheckoutIntent.id, creditPackFulfillment.checkoutIntentId),
		)
		.where(
			and(
				eq(paymentCheckoutIntentIdempotencyAlias.ownerType, input.ownerType),
				eq(paymentCheckoutIntentIdempotencyAlias.ownerId, input.ownerId),
				eq(paymentCheckoutIntentIdempotencyAlias.idempotencyKey, input.idempotencyKey),
			),
		)
		.limit(1);
	if (directRow && aliasRow) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	}
	if (
		aliasRow &&
		(aliasRow.intent.ownerType !== input.ownerType || aliasRow.intent.ownerId !== input.ownerId)
	) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	}
	const row = directRow ?? aliasRow;
	return row
		? { ...row.intent, billingPlan: row.plan, creditPackFulfillment: row.fulfillment }
		: null;
}

export async function completePaymentCheckoutIntent(input: {
	intentId: string;
	provider: PaymentProviderName;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ status: "COMPLETED", activeScopeKey: null, updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.status, "PROVIDER_PENDING"),
			),
		)
		.returning({ id: paymentCheckoutIntent.id });
	return { count: rows.length };
}

export async function reviewPaymentCheckoutIntent(input: {
	intentId: string;
	provider: PaymentProviderName;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({ status: "REVIEW", updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
			),
		)
		.returning({ id: paymentCheckoutIntent.id });
	return { count: rows.length };
}

function paymentCheckoutActiveScope(
	input: PaymentOwner & {
		productKind?: PaymentProductKind;
		planKey: string;
		interval: string;
	},
) {
	const legacyPlanScope = `${input.ownerType}:${input.ownerId}:${input.planKey}:${input.interval}`;
	const productKind = input.productKind ?? "PLAN";
	if (productKind === "PLAN") return legacyPlanScope;
	return `${input.ownerType}:${input.ownerId}:${productKind}:${input.planKey}:${input.interval}`;
}

function paymentCheckoutIdempotencyScope(input: PaymentOwner & { idempotencyKey: string }) {
	return `payment-checkout-idempotency:${JSON.stringify([
		input.ownerType,
		input.ownerId,
		input.idempotencyKey,
	])}`;
}

function matchesTrustedCheckoutCommand(
	intent: {
		provider: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		submittedByUserId: string;
		productKind: PaymentProductKind;
		billingPlanId: string;
		planKey: string;
		interval: string;
		creditPackCatalogVersion: string | null;
		creditPackPricingVersion: string | null;
		creditPackSubscriberEligibilityVersion: string | null;
		creditPackBaseCredits: bigint | null;
		creditPackBonusCredits: bigint | null;
		creditPackTotalCredits: bigint | null;
		creditPackExpiryMonths: number | null;
		creditPackSubscriberBonusEligible: boolean | null;
		creditPackSubscriberSubscriptionId: string | null;
		creditPackSubscriberPlanKey: string | null;
		creditPackEligibilityEvaluatedAt: Date | null;
	},
	input: CreatePaymentCheckoutIntentInput,
): boolean {
	const expectedProductKind = input.productKind ?? "PLAN";
	const stableCommandMatches =
		intent.provider === input.provider &&
		intent.ownerType === input.ownerType &&
		intent.ownerId === input.ownerId &&
		intent.submittedByUserId === input.submittedByUserId &&
		intent.productKind === expectedProductKind &&
		intent.planKey === input.planKey &&
		intent.interval === input.interval;
	if (!stableCommandMatches) return false;

	// Subscriber eligibility and catalog pricing are evaluated only for the first
	// command. A retry or matching active checkout must reuse that persisted decision
	// even when time, subscription state, or the active BillingPlan version changed.
	if (expectedProductKind === "CREDIT_PACK") {
		return hasValidFrozenCreditPackSnapshot(intent);
	}

	const expectedSnapshot = creditPackSnapshotColumns(input);
	return (
		intent.creditPackCatalogVersion === expectedSnapshot.creditPackCatalogVersion &&
		intent.creditPackPricingVersion === expectedSnapshot.creditPackPricingVersion &&
		intent.creditPackSubscriberEligibilityVersion ===
			expectedSnapshot.creditPackSubscriberEligibilityVersion &&
		intent.creditPackBaseCredits === expectedSnapshot.creditPackBaseCredits &&
		intent.creditPackBonusCredits === expectedSnapshot.creditPackBonusCredits &&
		intent.creditPackTotalCredits === expectedSnapshot.creditPackTotalCredits &&
		intent.creditPackExpiryMonths === expectedSnapshot.creditPackExpiryMonths &&
		intent.creditPackSubscriberBonusEligible ===
			expectedSnapshot.creditPackSubscriberBonusEligible &&
		intent.creditPackSubscriberSubscriptionId ===
			expectedSnapshot.creditPackSubscriberSubscriptionId &&
		intent.creditPackSubscriberPlanKey === expectedSnapshot.creditPackSubscriberPlanKey &&
		sameInstant(
			intent.creditPackEligibilityEvaluatedAt,
			expectedSnapshot.creditPackEligibilityEvaluatedAt,
		)
	);
}

function hasValidFrozenCreditPackSnapshot(input: {
	creditPackCatalogVersion: string | null;
	creditPackPricingVersion: string | null;
	creditPackSubscriberEligibilityVersion: string | null;
	creditPackBaseCredits: bigint | null;
	creditPackBonusCredits: bigint | null;
	creditPackTotalCredits: bigint | null;
	creditPackExpiryMonths: number | null;
	creditPackSubscriberBonusEligible: boolean | null;
	creditPackSubscriberSubscriptionId: string | null;
	creditPackSubscriberPlanKey: string | null;
	creditPackEligibilityEvaluatedAt: Date | null;
}): boolean {
	return (
		nonempty(input.creditPackCatalogVersion) &&
		nonempty(input.creditPackPricingVersion) &&
		nonempty(input.creditPackSubscriberEligibilityVersion) &&
		input.creditPackBaseCredits !== null &&
		input.creditPackBaseCredits > 0n &&
		input.creditPackBonusCredits !== null &&
		input.creditPackBonusCredits >= 0n &&
		input.creditPackTotalCredits === input.creditPackBaseCredits + input.creditPackBonusCredits &&
		input.creditPackExpiryMonths === 6 &&
		typeof input.creditPackSubscriberBonusEligible === "boolean" &&
		input.creditPackEligibilityEvaluatedAt !== null &&
		Number.isFinite(input.creditPackEligibilityEvaluatedAt.getTime()) &&
		(input.creditPackSubscriberBonusEligible
			? input.creditPackBonusCredits > 0n &&
				nonempty(input.creditPackSubscriberSubscriptionId) &&
				nonempty(input.creditPackSubscriberPlanKey)
			: input.creditPackBonusCredits === 0n &&
				input.creditPackSubscriberSubscriptionId === null &&
				input.creditPackSubscriberPlanKey === null)
	);
}

function creditPackSnapshotColumns(input: CreatePaymentCheckoutIntentInput) {
	if (input.productKind !== "CREDIT_PACK") {
		return {
			creditPackCatalogVersion: null,
			creditPackPricingVersion: null,
			creditPackSubscriberEligibilityVersion: null,
			creditPackBaseCredits: null,
			creditPackBonusCredits: null,
			creditPackTotalCredits: null,
			creditPackExpiryMonths: null,
			creditPackSubscriberBonusEligible: null,
			creditPackSubscriberSubscriptionId: null,
			creditPackSubscriberPlanKey: null,
			creditPackEligibilityEvaluatedAt: null,
		};
	}

	const snapshot = input.creditPackSnapshot;
	if (
		(input.provider !== "paypal" && input.provider !== "waffo") ||
		input.interval !== "one-time" ||
		!nonempty(snapshot.catalogVersion) ||
		!nonempty(snapshot.pricingVersion) ||
		!nonempty(snapshot.subscriberEligibilityVersion) ||
		snapshot.baseCredits <= 0n ||
		snapshot.bonusCredits < 0n ||
		snapshot.totalCredits !== snapshot.baseCredits + snapshot.bonusCredits ||
		snapshot.expiryMonths !== 6 ||
		!Number.isFinite(snapshot.eligibilityEvaluatedAt.getTime()) ||
		(snapshot.subscriberBonusEligible
			? snapshot.bonusCredits <= 0n ||
				!nonempty(snapshot.subscriberSubscriptionId) ||
				!nonempty(snapshot.subscriberPlanKey)
			: snapshot.bonusCredits !== 0n ||
				snapshot.subscriberSubscriptionId !== null ||
				snapshot.subscriberPlanKey !== null)
	) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_CREDIT_PACK_SNAPSHOT_INVALID");
	}

	return {
		creditPackCatalogVersion: snapshot.catalogVersion,
		creditPackPricingVersion: snapshot.pricingVersion,
		creditPackSubscriberEligibilityVersion: snapshot.subscriberEligibilityVersion,
		creditPackBaseCredits: snapshot.baseCredits,
		creditPackBonusCredits: snapshot.bonusCredits,
		creditPackTotalCredits: snapshot.totalCredits,
		creditPackExpiryMonths: snapshot.expiryMonths,
		creditPackSubscriberBonusEligible: snapshot.subscriberBonusEligible,
		creditPackSubscriberSubscriptionId: snapshot.subscriberSubscriptionId,
		creditPackSubscriberPlanKey: snapshot.subscriberPlanKey,
		creditPackEligibilityEvaluatedAt: snapshot.eligibilityEvaluatedAt,
	};
}

function nonempty(value: string | null): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function sameInstant(left: Date | null, right: Date | null): boolean {
	return left === null ? right === null : right !== null && left.getTime() === right.getTime();
}
