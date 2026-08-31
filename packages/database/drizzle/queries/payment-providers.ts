import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../client";
import { billingPlan, paymentCheckoutIntent, paymentCustomer } from "../schema/postgres";

export type PaymentProviderName = "stripe" | "paypal" | "waffo";
export type PaymentOwner = { ownerType: "USER" | "ORGANIZATION"; ownerId: string };

export interface CreatePaymentCheckoutIntentInput extends PaymentOwner {
	provider: PaymentProviderName;
	submittedByUserId: string;
	billingPlanId: string;
	planKey: string;
	interval: "month" | "year";
	idempotencyKey: string;
	now?: Date;
	expiresInSeconds?: number;
}

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
	const expiresAt = new Date(now.getTime() + (input.expiresInSeconds ?? 30 * 60) * 1_000);
	const activeScopeKey = paymentCheckoutActiveScope(input);
	return db.transaction(
		async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${activeScopeKey}, 0))`);
			const [replay] = await tx
				.select()
				.from(paymentCheckoutIntent)
				.where(
					and(
						eq(paymentCheckoutIntent.provider, input.provider),
						eq(paymentCheckoutIntent.ownerType, input.ownerType),
						eq(paymentCheckoutIntent.ownerId, input.ownerId),
						eq(paymentCheckoutIntent.idempotencyKey, input.idempotencyKey),
					),
				)
				.limit(1);
			if (replay) return { intent: replay, replayed: true };

			const [active] = await tx
				.select()
				.from(paymentCheckoutIntent)
				.where(eq(paymentCheckoutIntent.activeScopeKey, activeScopeKey))
				.limit(1);
			if (active && active.expiresAt <= now) {
				await tx
					.update(paymentCheckoutIntent)
					.set({ status: "EXPIRED", activeScopeKey: null, updatedAt: now })
					.where(eq(paymentCheckoutIntent.id, active.id));
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
					billingPlanId: input.billingPlanId,
					planKey: input.planKey,
					interval: input.interval,
					idempotencyKey: input.idempotencyKey,
					activeScopeKey,
					expiresAt,
				})
				.returning();
			if (!intent) throw new Error("PAYMENT_CHECKOUT_INTENT_CREATE_FAILED");
			return { intent, replayed: false };
		},
		{ isolationLevel: "serializable" },
	);
}

export async function bindPaymentCheckoutIntentSession(input: {
	intentId: string;
	provider: PaymentProviderName;
	providerSessionId: string;
	expiresAt?: Date | null;
}) {
	const rows = await db
		.update(paymentCheckoutIntent)
		.set({
			providerSessionId: input.providerSessionId,
			status: "PROVIDER_PENDING",
			updatedAt: new Date(),
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
		})
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
				eq(paymentCheckoutIntent.status, "CREATED"),
			),
		)
		.returning();
	if (rows.length !== 1) throw new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT");
	return rows[0];
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

export async function getPaymentCheckoutIntentById(id: string) {
	const [row] = await db
		.select({ intent: paymentCheckoutIntent, plan: billingPlan })
		.from(paymentCheckoutIntent)
		.innerJoin(billingPlan, eq(paymentCheckoutIntent.billingPlanId, billingPlan.id))
		.where(eq(paymentCheckoutIntent.id, id))
		.limit(1);
	return row ? { ...row.intent, billingPlan: row.plan } : null;
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
				inArray(paymentCheckoutIntent.status, ["CREATED", "PROVIDER_PENDING"]),
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
		.set({ status: "REVIEW", activeScopeKey: null, updatedAt: new Date() })
		.where(
			and(
				eq(paymentCheckoutIntent.id, input.intentId),
				eq(paymentCheckoutIntent.provider, input.provider),
			),
		)
		.returning({ id: paymentCheckoutIntent.id });
	return { count: rows.length };
}

function paymentCheckoutActiveScope(input: PaymentOwner & { planKey: string; interval: string }) {
	return `${input.ownerType}:${input.ownerId}:${input.planKey}:${input.interval}`;
}
