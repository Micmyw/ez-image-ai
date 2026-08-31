import type { Prisma } from "../generated/client";
import { runSerializable, type MediaTransactionClient } from "./media/types";

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

export async function getPaymentCustomer(
	provider: PaymentProviderName,
	owner: PaymentOwner,
	client: Prisma.TransactionClient,
) {
	return client.paymentCustomer.findUnique({
		where: {
			provider_ownerType_ownerId: {
				provider,
				ownerType: owner.ownerType,
				ownerId: owner.ownerId,
			},
		},
	});
}

export async function upsertPaymentCustomer(
	input: PaymentOwner & { provider: PaymentProviderName; providerCustomerId: string },
	client: Prisma.TransactionClient,
) {
	return client.paymentCustomer.upsert({
		where: {
			provider_ownerType_ownerId: {
				provider: input.provider,
				ownerType: input.ownerType,
				ownerId: input.ownerId,
			},
		},
		create: input,
		update: { providerCustomerId: input.providerCustomerId },
	});
}

export async function createPaymentCheckoutIntent(
	input: CreatePaymentCheckoutIntentInput,
	client: MediaTransactionClient,
) {
	const now = input.now ?? new Date();
	const expiresAt = new Date(now.getTime() + (input.expiresInSeconds ?? 30 * 60) * 1_000);
	const activeScopeKey = paymentCheckoutActiveScope(input);
	return runSerializable(client, async (tx) => {
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(hashtextextended(${activeScopeKey}, 0))::text AS "locked"`;

		const replay = await tx.paymentCheckoutIntent.findUnique({
			where: {
				provider_ownerType_ownerId_idempotencyKey: {
					provider: input.provider,
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
		});
		if (replay) return { intent: replay, replayed: true };

		const active = await tx.paymentCheckoutIntent.findUnique({ where: { activeScopeKey } });
		if (active && active.expiresAt <= now) {
			await tx.paymentCheckoutIntent.update({
				where: { id: active.id },
				data: { status: "EXPIRED", activeScopeKey: null },
			});
		} else if (active) {
			throw new Error("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		}

		const intent = await tx.paymentCheckoutIntent.create({
			data: {
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
			},
		});
		return { intent, replayed: false };
	});
}

export async function bindPaymentCheckoutIntentSession(
	input: {
		intentId: string;
		provider: PaymentProviderName;
		providerSessionId: string;
		expiresAt?: Date | null;
	},
	client: Prisma.TransactionClient,
) {
	const updated = await client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			status: "CREATED",
			providerSessionId: null,
		},
		data: {
			providerSessionId: input.providerSessionId,
			status: "PROVIDER_PENDING",
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
		},
	});
	if (updated.count !== 1) throw new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT");
	return client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.intentId } });
}

export async function getPaymentCheckoutIntentByProviderSession(
	provider: PaymentProviderName,
	providerSessionId: string,
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.findUnique({
		where: { provider_providerSessionId: { provider, providerSessionId } },
		include: { billingPlan: true },
	});
}

export async function getPaymentCheckoutIntentById(id: string, client: Prisma.TransactionClient) {
	return client.paymentCheckoutIntent.findUnique({
		where: { id },
		include: { billingPlan: true },
	});
}

export async function completePaymentCheckoutIntent(
	input: { intentId: string; provider: PaymentProviderName },
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			status: { in: ["CREATED", "PROVIDER_PENDING"] },
		},
		data: { status: "COMPLETED", activeScopeKey: null },
	});
}

export async function reviewPaymentCheckoutIntent(
	input: { intentId: string; provider: PaymentProviderName },
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.updateMany({
		where: { id: input.intentId, provider: input.provider },
		data: { status: "REVIEW", activeScopeKey: null },
	});
}

function paymentCheckoutActiveScope(input: PaymentOwner & { planKey: string; interval: string }) {
	return `${input.ownerType}:${input.ownerId}:${input.planKey}:${input.interval}`;
}
