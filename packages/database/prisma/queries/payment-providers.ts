import type { Prisma } from "../generated/client";
import { runSerializable, type MediaTransactionClient } from "./media/types";

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
	const productKind = input.productKind ?? "PLAN";
	const creditPackSnapshot = creditPackSnapshotColumns(input);
	const activeScopeKey = paymentCheckoutActiveScope(input);
	const idempotencyScopeKey = paymentCheckoutIdempotencyScope(input);
	const result = await runSerializable(client, async (tx) => {
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${idempotencyScopeKey}, 0)
			)::text AS "locked"`;
		await tx.$queryRaw<Array<{ locked: string }>>`
			SELECT pg_advisory_xact_lock(hashtextextended(${activeScopeKey}, 0))::text AS "locked"`;

		const directReplay = await tx.paymentCheckoutIntent.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
		});
		const aliasReplay = await tx.paymentCheckoutIntentIdempotencyAlias.findUnique({
			where: {
				ownerType_ownerId_idempotencyKey: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
				},
			},
			include: { checkoutIntent: true },
		});
		if (directReplay && aliasReplay) {
			throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
		}
		const replay = directReplay ?? aliasReplay?.checkoutIntent;
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
		} else if (
			active?.status === "PROVIDER_PENDING" &&
			active.providerSessionId &&
			active.providerCheckoutUrl &&
			matchesTrustedCheckoutCommand(active, input)
		) {
			await tx.paymentCheckoutIntentIdempotencyAlias.create({
				data: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					idempotencyKey: input.idempotencyKey,
					checkoutIntentId: active.id,
				},
			});
			return { intent: active, replayed: true };
		} else if (active) {
			throw new Error("PAYMENT_CHECKOUT_INTENT_CONFLICT");
		}

		const intent = await tx.paymentCheckoutIntent.create({
			data: {
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

export async function resetPaymentCheckoutIntentProviderCreating(
	input: PaymentOwner & {
		intentId: string;
		provider: PaymentProviderName;
		expectedProductKind: PaymentProductKind;
	},
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			productKind: input.expectedProductKind,
			status: "PROVIDER_CREATING",
			providerSessionId: null,
			providerCheckoutUrl: null,
			providerOrderId: null,
		},
		data: { status: "CREATED" },
	});
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
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			status: input.expectedStatus,
			productKind: input.expectedProductKind,
			...(input.expectedProviderSessionId
				? { providerSessionId: input.expectedProviderSessionId }
				: {}),
			...(input.expectedProviderOrderId ? { providerOrderId: input.expectedProviderOrderId } : {}),
		},
		data: { status: "REVIEW" },
	});
}

export async function bindPaymentCheckoutIntentSession(
	input: {
		intentId: string;
		provider: PaymentProviderName;
		providerSessionId: string;
		providerOrderId?: string | null;
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
			...(input.providerOrderId ? { providerOrderId: null } : {}),
		},
		data: {
			providerSessionId: input.providerSessionId,
			...(input.providerOrderId ? { providerOrderId: input.providerOrderId } : {}),
			providerCheckoutUrl: input.providerCheckoutUrl,
			status: "PROVIDER_PENDING",
			expiresAt: input.expiresAt ?? null,
		},
	});
	if (updated.count !== 1) throw new Error("PAYMENT_CHECKOUT_INTENT_BINDING_CONFLICT");
	return client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.intentId } });
}

export async function bindPaymentCheckoutIntentOrder(
	input: { intentId: string; provider: PaymentProviderName; providerOrderId: string },
	client: Prisma.TransactionClient,
) {
	const updated = await client.paymentCheckoutIntent.updateMany({
		where: {
			id: input.intentId,
			provider: input.provider,
			providerOrderId: null,
			status: { in: ["CREATED", "PROVIDER_CREATING", "PROVIDER_PENDING"] },
		},
		data: { providerOrderId: input.providerOrderId },
	});
	if (updated.count === 1) {
		return client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: input.intentId } });
	}
	const existing = await client.paymentCheckoutIntent.findUnique({ where: { id: input.intentId } });
	if (existing?.provider === input.provider && existing.providerOrderId === input.providerOrderId) {
		return existing;
	}
	throw new Error("PAYMENT_CHECKOUT_INTENT_ORDER_BINDING_CONFLICT");
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

export async function getPaymentCheckoutIntentByProviderOrder(
	provider: PaymentProviderName,
	providerOrderId: string,
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.findUnique({
		where: { provider_providerOrderId: { provider, providerOrderId } },
		include: { billingPlan: true },
	});
}

export async function getPaymentCheckoutIntentById(id: string, client: Prisma.TransactionClient) {
	return client.paymentCheckoutIntent.findUnique({
		where: { id },
		include: { billingPlan: true },
	});
}

export async function getPaymentCheckoutIntentForOwner(
	input: PaymentOwner & { intentId: string },
	client: Prisma.TransactionClient,
) {
	return client.paymentCheckoutIntent.findFirst({
		where: { id: input.intentId, ownerType: input.ownerType, ownerId: input.ownerId },
		include: { billingPlan: true, creditPackFulfillment: true },
	});
}

export async function getPaymentCheckoutIntentForOwnerByIdempotencyKey(
	input: PaymentOwner & { idempotencyKey: string },
	client: Prisma.TransactionClient,
) {
	const directIntent = await client.paymentCheckoutIntent.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: { billingPlan: true, creditPackFulfillment: true },
	});
	const alias = await client.paymentCheckoutIntentIdempotencyAlias.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: {
			checkoutIntent: { include: { billingPlan: true, creditPackFulfillment: true } },
		},
	});
	if (directIntent && alias) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	}
	if (
		alias &&
		(alias.checkoutIntent.ownerType !== input.ownerType ||
			alias.checkoutIntent.ownerId !== input.ownerId)
	) {
		throw new Error("PAYMENT_CHECKOUT_INTENT_IDEMPOTENCY_CONFLICT");
	}
	return directIntent ?? alias?.checkoutIntent ?? null;
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
