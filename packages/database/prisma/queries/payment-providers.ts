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
	const activeScopeKey = paymentCheckoutActiveScope(input);
	const idempotencyScopeKey = paymentCheckoutIdempotencyScope(input);
	const result = await runSerializable(client, async (tx) => {
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${idempotencyScopeKey}, 0)
			)::text AS "locked"`;
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(hashtextextended(${activeScopeKey}, 0))::text AS "locked"`;

		const replay = await tx.paymentCheckoutIntent.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
		});
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
					await tx.paymentCheckoutIntent.update({
						where: { id: replay.id },
						data: { status: "EXPIRED", activeScopeKey: null },
					});
					return { unsafeReplay: true as const };
				}
				return { intent: replay, replayed: true };
			}
			throw new Error("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
		}

		const active = await tx.paymentCheckoutIntent.findUnique({ where: { activeScopeKey } });
		if (
			active?.status === "PROVIDER_PENDING" &&
			active.providerSessionId &&
			active.providerCheckoutUrl &&
			active.expiresAt &&
			active.expiresAt <= now
		) {
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
				expiresAt: null,
			},
		});
		return { intent, replayed: false };
	});
	if ("unsafeReplay" in result) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_REPLAY_UNSAFE");
	}
	return result;
}

export async function markPaymentCheckoutIntentProviderCreating(
	input: { intentId: string; provider: PaymentProviderName },
	client: Prisma.TransactionClient,
) {
	const updated = await client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			status: "CREATED",
			providerSessionId: null,
			providerCheckoutUrl: null,
		},
		data: { status: "PROVIDER_CREATING" },
	});
	if (updated.count !== 1) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_PROVIDER_CREATE_CONFLICT");
	}
	return client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.intentId } });
}

export async function bindPaymentCheckoutIntentSession(
	input: {
		intentId: string;
		provider: PaymentProviderName;
		providerSessionId: string;
		providerCheckoutUrl: string;
		expiresAt?: Date | null;
	},
	client: Prisma.TransactionClient,
) {
	const updated = await client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			status: "PROVIDER_CREATING",
			providerSessionId: null,
			providerCheckoutUrl: null,
		},
		data: {
			providerSessionId: input.providerSessionId,
			providerCheckoutUrl: input.providerCheckoutUrl,
			status: "PROVIDER_PENDING",
			expiresAt: input.expiresAt ?? null,
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
			status: "PROVIDER_PENDING",
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
		data: { status: "REVIEW" },
	});
}

function paymentCheckoutActiveScope(input: PaymentOwner & { planKey: string; interval: string }) {
	return `${input.ownerType}:${input.ownerId}:${input.planKey}:${input.interval}`;
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
		billingPlanId: string;
		planKey: string;
		interval: string;
	},
	input: CreatePaymentCheckoutIntentInput,
): boolean {
	return (
		intent.provider === input.provider &&
		intent.ownerType === input.ownerType &&
		intent.ownerId === input.ownerId &&
		intent.submittedByUserId === input.submittedByUserId &&
		intent.billingPlanId === input.billingPlanId &&
		intent.planKey === input.planKey &&
		intent.interval === input.interval
	);
}
