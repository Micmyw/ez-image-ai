import { calculateCreditPackExpiresAt } from "@repo/config/server";
import {
	createCreditGrant,
	expireCreditLotsInTransaction,
	isDatabaseUniqueConflict,
	lockCreditPackProviderPayment,
	PAYMENT_PROVIDER_CORRELATION_MISSING,
	requeueCreditPackRefundEventsMissingCheckoutCorrelation,
	refundCreditGrant,
	type Prisma,
} from "@repo/database";

import type { CreditPackPaymentFact, CreditPackRefundFact } from "./lifecycle-normalization";

type TransactionClient = Prisma.TransactionClient;

interface CreditPackSnapshot {
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

export async function applyCreditPackPaymentFact(
	fact: CreditPackPaymentFact,
	client: TransactionClient,
	options: { now?: Date; paymentEventId?: string } = {},
): Promise<{ grantsCreated: number }> {
	const now = options.now ?? new Date();
	await lockCreditPackProviderPayment(
		{ provider: fact.provider, providerPaymentId: fact.providerPaymentId },
		client,
	);
	if (!fact.checkoutIntentId) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	await lockCheckoutIntent(client, fact.checkoutIntentId);

	const existing = await client.creditPackFulfillment.findUnique({
		where: {
			provider_providerPaymentId: {
				provider: fact.provider,
				providerPaymentId: fact.providerPaymentId,
			},
		},
		include: { checkoutIntent: true },
	});
	if (existing) {
		assertFulfillmentReplay(existing, fact);
		const account = await client.creditAccount.findUnique({
			where: {
				ownerType_ownerId: {
					ownerType: existing.ownerType,
					ownerId: existing.ownerId,
				},
			},
		});
		if (!account) throw new Error("CREDIT_PACK_CREDIT_ACCOUNT_MISSING");
		await createCreditGrant(
			{
				accountId: account.id,
				amount: existing.grantedCredits,
				referenceKey: existing.grantReferenceKey,
				expiresAt: existing.expiresAt,
				metadata: creditPackGrantMetadata(existing, fact.provider, fact.providerPaymentId),
			},
			client,
		);
		if (fact.provider === "paypal") {
			await requeueCreditPackRefundEventsMissingCheckoutCorrelation(
				{ provider: fact.provider, providerPaymentId: fact.providerPaymentId },
				client,
			);
		}
		return { grantsCreated: 0 };
	}

	const checkoutIntent = await client.paymentCheckoutIntent.findUnique({
		where: { id: fact.checkoutIntentId },
		include: { billingPlan: true },
	});
	if (!checkoutIntent) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	const snapshot = assertCreditPackCheckout(checkoutIntent, fact);
	await bindProviderOrder(checkoutIntent, fact, client);

	const orderBinding = await client.creditPackFulfillment.findFirst({
		where: { provider: fact.provider, providerOrderId: fact.providerOrderId },
	});
	if (orderBinding) throw new Error("CREDIT_PACK_ORDER_BINDING_CONFLICT");

	const purchase = await client.purchase.create({
		data: {
			provider: fact.provider,
			type: "ONE_TIME",
			productKind: "CREDIT_PACK",
			customerId: fact.providerCustomerId ?? `${fact.provider}:one-time:${fact.providerPaymentId}`,
			subscriptionId: null,
			priceId: checkoutIntent.billingPlan.providerPriceId,
			status: "completed",
			organizationId: checkoutIntent.ownerType === "ORGANIZATION" ? checkoutIntent.ownerId : null,
			userId: checkoutIntent.ownerType === "USER" ? checkoutIntent.ownerId : null,
		},
	});
	const fulfillmentId = crypto.randomUUID();
	const grantReferenceKey = `credit-pack:${fulfillmentId}:grant:v1`;
	const expiresAt = calculateCreditPackExpiresAt(fact.occurredAt, snapshot);
	const fulfillment = await client.creditPackFulfillment.create({
		data: {
			id: fulfillmentId,
			purchaseId: purchase.id,
			checkoutIntentId: checkoutIntent.id,
			billingPlanId: checkoutIntent.billingPlanId,
			ownerType: checkoutIntent.ownerType,
			ownerId: checkoutIntent.ownerId,
			provider: fact.provider,
			providerOrderId: fact.providerOrderId,
			providerPaymentId: fact.providerPaymentId,
			paidAmountMicros: fact.amountMicros,
			currency: fact.currency,
			baseCredits: snapshot.baseCredits,
			bonusCredits: snapshot.bonusCredits,
			grantedCredits: snapshot.totalCredits,
			grantReferenceKey,
			paidAt: fact.occurredAt,
			expiresAt,
			fulfilledAt: now,
		},
	});
	const account = await client.creditAccount.upsert({
		where: {
			ownerType_ownerId: {
				ownerType: fulfillment.ownerType,
				ownerId: fulfillment.ownerId,
			},
		},
		create: { ownerType: fulfillment.ownerType, ownerId: fulfillment.ownerId },
		update: {},
	});
	await createCreditGrant(
		{
			accountId: account.id,
			amount: fulfillment.grantedCredits,
			referenceKey: grantReferenceKey,
			expiresAt,
			metadata: creditPackGrantMetadata(fulfillment, fact.provider, fact.providerPaymentId),
		},
		client,
	);
	if (expiresAt <= now) {
		await expireCreditLotsInTransaction({ accountId: account.id, now }, client);
	}

	const completed = await client.paymentCheckoutIntent.updateMany({
		where: {
			id: checkoutIntent.id,
			provider: fact.provider,
			productKind: "CREDIT_PACK",
			status: "PROVIDER_PENDING",
			providerOrderId: fact.providerOrderId,
		},
		data: { status: "COMPLETED", activeScopeKey: null },
	});
	if (completed.count !== 1) throw new Error("CREDIT_PACK_CHECKOUT_COMPLETION_CONFLICT");

	await client.auditLog.create({
		data: {
			action: "CREDIT_PACK_FULFILLED",
			targetType: "CREDIT_PACK_FULFILLMENT",
			targetId: fulfillment.id,
			after: {
				provider: fact.provider,
				checkoutIntentId: checkoutIntent.id,
				paidAmountMicros: fact.amountMicros.toString(),
				grantedCredits: fulfillment.grantedCredits.toString(),
				expiresAt: expiresAt.toISOString(),
			},
			metadata: {
				paymentEventId: options.paymentEventId ?? null,
				providerEventId: fact.providerEventId,
			},
		},
	});
	await client.outboxEvent.create({
		data: {
			eventType: "CREDIT_PACK_FULFILLED",
			aggregateType: "CREDIT_PACK_FULFILLMENT",
			aggregateId: fulfillment.id,
			dedupeKey: `credit-pack-fulfilled:${fulfillment.id}:v1`,
			payload: { creditPackFulfillmentId: fulfillment.id },
		},
	});
	if (fact.provider === "paypal") {
		await requeueCreditPackRefundEventsMissingCheckoutCorrelation(
			{ provider: fact.provider, providerPaymentId: fact.providerPaymentId },
			client,
		);
	}
	return { grantsCreated: 1 };
}

export async function applyCreditPackRefundFact(
	fact: CreditPackRefundFact,
	client: TransactionClient,
	options: { now?: Date; paymentEventId?: string } = {},
): Promise<{ grantsCreated: number }> {
	const now = options.now ?? new Date();
	await lockCreditPackProviderPayment(
		{ provider: fact.provider, providerPaymentId: fact.providerPaymentId },
		client,
	);
	if (fact.amountMicros <= 0n) throw new Error("CREDIT_PACK_REFUND_AMOUNT_INVALID");

	const fulfillment = await client.creditPackFulfillment.findUnique({
		where: {
			provider_providerPaymentId: {
				provider: fact.provider,
				providerPaymentId: fact.providerPaymentId,
			},
		},
	});
	if (!fulfillment) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	if (fact.occurredAt < fulfillment.paidAt) {
		throw new Error("CREDIT_PACK_REFUND_TIME_INVALID");
	}
	if (fulfillment.currency !== fact.currency) {
		throw new Error("CREDIT_PACK_REFUND_CURRENCY_MISMATCH");
	}

	let adjustment = await client.creditPackAdjustment.findUnique({
		where: {
			provider_providerAdjustmentId: {
				provider: fact.provider,
				providerAdjustmentId: fact.providerRefundId,
			},
		},
	});
	if (adjustment) {
		if (
			adjustment.fulfillmentId !== fulfillment.id ||
			adjustment.amountMicros !== fact.amountMicros ||
			adjustment.currency !== fact.currency ||
			adjustment.status !== "SUCCEEDED"
		) {
			throw new Error("CREDIT_PACK_REFUND_BINDING_CONFLICT");
		}
		if (adjustment.creditsFinalizedAt) return { grantsCreated: 0 };
	} else {
		adjustment = await client.creditPackAdjustment.create({
			data: {
				fulfillmentId: fulfillment.id,
				provider: fact.provider,
				providerAdjustmentId: fact.providerRefundId,
				amountMicros: fact.amountMicros,
				currency: fact.currency,
				status: "SUCCEEDED",
				providerCreatedAt: fact.occurredAt,
				lastProviderChangeAt: fact.occurredAt,
				lastProviderChangeId: fact.providerEventId,
			},
		});
	}

	const totals = await client.creditPackAdjustment.aggregate({
		where: { fulfillmentId: fulfillment.id, status: "SUCCEEDED" },
		_sum: { amountMicros: true },
	});
	const refundedAmountMicros = totals._sum.amountMicros ?? 0n;
	const targetCredits = calculateCreditPackRefundTargetCredits({
		grantedCredits: fulfillment.grantedCredits,
		paidAmountMicros: fulfillment.paidAmountMicros,
		refundedAmountMicros,
	});
	if (targetCredits < fulfillment.refundedCredits) {
		throw new Error("CREDIT_PACK_REFUND_PROJECTION_CONFLICT");
	}
	const creditDelta = targetCredits - fulfillment.refundedCredits;
	const refundReferenceKey = `credit-pack-adjustment:${adjustment.id}:refund:v1`;
	if (creditDelta > 0n) {
		const account = await client.creditAccount.findUnique({
			where: {
				ownerType_ownerId: {
					ownerType: fulfillment.ownerType,
					ownerId: fulfillment.ownerId,
				},
			},
		});
		if (!account) throw new Error("CREDIT_PACK_CREDIT_ACCOUNT_MISSING");
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: creditDelta,
				grantReferenceKey: fulfillment.grantReferenceKey,
				referenceKey: refundReferenceKey,
				metadata: {
					productKind: "CREDIT_PACK",
					creditPackFulfillmentId: fulfillment.id,
					creditPackAdjustmentId: adjustment.id,
					provider: fact.provider,
					providerRefundId: fact.providerRefundId,
				},
			},
			client,
		);
	}
	const status =
		refundedAmountMicros === fulfillment.paidAmountMicros ? "REFUNDED" : "PARTIALLY_REFUNDED";
	await client.creditPackFulfillment.update({
		where: { id: fulfillment.id },
		data: { refundedAmountMicros, refundedCredits: targetCredits, status },
	});
	if (fulfillment.purchaseId) {
		await client.purchase.update({
			where: { id: fulfillment.purchaseId },
			data: { status: status === "REFUNDED" ? "refunded" : "partially_refunded" },
		});
	}
	await client.creditPackAdjustment.update({
		where: { id: adjustment.id },
		data: {
			finalizedCredits: creditDelta,
			creditsFinalizedAt: now,
			refundReferenceKey,
			lastProviderChangeAt: fact.occurredAt,
			lastProviderChangeId: fact.providerEventId,
		},
	});
	await client.auditLog.create({
		data: {
			action: "CREDIT_PACK_REFUND_APPLIED",
			targetType: "CREDIT_PACK_ADJUSTMENT",
			targetId: adjustment.id,
			after: {
				providerRefundId: fact.providerRefundId,
				amountMicros: fact.amountMicros.toString(),
				creditsRefunded: creditDelta.toString(),
				cumulativeCreditsRefunded: targetCredits.toString(),
			},
			metadata: {
				paymentEventId: options.paymentEventId ?? null,
				providerEventId: fact.providerEventId,
			},
		},
	});
	await client.outboxEvent.create({
		data: {
			eventType: "CREDIT_PACK_ADJUSTED",
			aggregateType: "CREDIT_PACK_ADJUSTMENT",
			aggregateId: adjustment.id,
			dedupeKey: `credit-pack-adjusted:${adjustment.id}:v1`,
			payload: { creditPackAdjustmentId: adjustment.id },
		},
	});
	return { grantsCreated: 0 };
}

export function calculateCreditPackRefundTargetCredits(input: {
	grantedCredits: bigint;
	paidAmountMicros: bigint;
	refundedAmountMicros: bigint;
}): bigint {
	if (
		input.grantedCredits <= 0n ||
		input.paidAmountMicros <= 0n ||
		input.refundedAmountMicros <= 0n ||
		input.refundedAmountMicros > input.paidAmountMicros
	) {
		throw new Error("CREDIT_PACK_REFUND_AMOUNT_INVALID");
	}
	const projected =
		(input.grantedCredits * input.refundedAmountMicros + input.paidAmountMicros - 1n) /
		input.paidAmountMicros;
	return projected > input.grantedCredits ? input.grantedCredits : projected;
}

async function lockCheckoutIntent(
	client: TransactionClient,
	checkoutIntentId: string,
): Promise<void> {
	const rows = await client.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "payment_checkout_intent"
		WHERE "id" = ${checkoutIntentId}
		FOR UPDATE`;
	if (rows.length === 0) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
}

function assertCreditPackCheckout(
	checkoutIntent: {
		id: string;
		provider: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		productKind: string;
		billingPlanId: string;
		planKey: string;
		interval: string;
		providerSessionId: string | null;
		providerOrderId: string | null;
		status: string;
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
		billingPlan: {
			provider: string;
			providerPriceId: string;
			productKind: string;
			name: string;
			creditsPerPeriod: bigint;
			priceMicros: bigint;
			currency: string;
			version: number;
			metadata: Prisma.JsonValue;
		};
	},
	fact: CreditPackPaymentFact,
): CreditPackSnapshot {
	if (
		checkoutIntent.productKind !== "CREDIT_PACK" ||
		checkoutIntent.billingPlan.productKind !== "CREDIT_PACK" ||
		checkoutIntent.provider !== fact.provider ||
		checkoutIntent.billingPlan.provider !== fact.provider ||
		checkoutIntent.status !== "PROVIDER_PENDING" ||
		checkoutIntent.interval !== "one-time"
	) {
		throw new Error("CREDIT_PACK_CHECKOUT_BINDING_INVALID");
	}
	if (checkoutIntent.providerSessionId === null) {
		throw new Error("CREDIT_PACK_CHECKOUT_SESSION_MISSING");
	}
	if (fact.provider === "paypal" && checkoutIntent.providerSessionId !== fact.providerOrderId) {
		throw new Error("CREDIT_PACK_CHECKOUT_ORDER_MISMATCH");
	}
	if (
		fact.provider === "waffo" &&
		fact.providerCustomerId !== `${checkoutIntent.ownerType}:${checkoutIntent.ownerId}`
	) {
		throw new Error("CREDIT_PACK_OWNER_MISMATCH");
	}
	if (checkoutIntent.billingPlan.priceMicros !== fact.amountMicros) {
		throw new Error("CREDIT_PACK_AMOUNT_MISMATCH");
	}
	if (checkoutIntent.billingPlan.currency !== fact.currency) {
		throw new Error("CREDIT_PACK_CURRENCY_MISMATCH");
	}

	const snapshot = readCreditPackSnapshot(checkoutIntent);
	if (snapshot.eligibilityEvaluatedAt > fact.occurredAt) {
		throw new Error("CREDIT_PACK_SNAPSHOT_TIME_INVALID");
	}
	const metadata = checkoutIntent.billingPlan.metadata;
	if (
		checkoutIntent.billingPlan.name !== checkoutIntent.planKey ||
		checkoutIntent.billingPlan.creditsPerPeriod !== snapshot.baseCredits ||
		metadataString(metadata, "productKind") !== "CREDIT_PACK" ||
		metadataString(metadata, "packKey") !== checkoutIntent.planKey ||
		metadataString(metadata, "catalogVersion") !== snapshot.catalogVersion ||
		metadataString(metadata, "pricingVersion") !== snapshot.pricingVersion ||
		metadataInteger(metadata, "expiryMonths") !== snapshot.expiryMonths ||
		metadataInteger(metadata, "version") !== checkoutIntent.billingPlan.version
	) {
		throw new Error("CREDIT_PACK_SNAPSHOT_MISMATCH");
	}
	return snapshot;
}

function readCreditPackSnapshot(input: {
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
}): CreditPackSnapshot {
	const snapshot = {
		catalogVersion: input.creditPackCatalogVersion,
		pricingVersion: input.creditPackPricingVersion,
		subscriberEligibilityVersion: input.creditPackSubscriberEligibilityVersion,
		baseCredits: input.creditPackBaseCredits,
		bonusCredits: input.creditPackBonusCredits,
		totalCredits: input.creditPackTotalCredits,
		expiryMonths: input.creditPackExpiryMonths,
		subscriberBonusEligible: input.creditPackSubscriberBonusEligible,
		subscriberSubscriptionId: input.creditPackSubscriberSubscriptionId,
		subscriberPlanKey: input.creditPackSubscriberPlanKey,
		eligibilityEvaluatedAt: input.creditPackEligibilityEvaluatedAt,
	};
	if (
		!snapshot.catalogVersion ||
		!snapshot.pricingVersion ||
		!snapshot.subscriberEligibilityVersion ||
		snapshot.baseCredits === null ||
		snapshot.bonusCredits === null ||
		snapshot.totalCredits === null ||
		snapshot.expiryMonths === null ||
		snapshot.subscriberBonusEligible === null ||
		!snapshot.eligibilityEvaluatedAt ||
		snapshot.baseCredits <= 0n ||
		snapshot.bonusCredits < 0n ||
		snapshot.totalCredits !== snapshot.baseCredits + snapshot.bonusCredits ||
		snapshot.expiryMonths <= 0 ||
		!Number.isInteger(snapshot.expiryMonths)
	) {
		throw new Error("CREDIT_PACK_SNAPSHOT_INVALID");
	}
	if (
		snapshot.subscriberBonusEligible !==
		Boolean(snapshot.subscriberSubscriptionId && snapshot.subscriberPlanKey)
	) {
		throw new Error("CREDIT_PACK_SUBSCRIBER_SNAPSHOT_INVALID");
	}
	if (
		(snapshot.subscriberBonusEligible && snapshot.bonusCredits <= 0n) ||
		(!snapshot.subscriberBonusEligible && snapshot.bonusCredits !== 0n)
	) {
		throw new Error("CREDIT_PACK_SUBSCRIBER_SNAPSHOT_INVALID");
	}
	return snapshot as CreditPackSnapshot;
}

async function bindProviderOrder(
	checkoutIntent: { id: string; providerOrderId: string | null },
	fact: CreditPackPaymentFact,
	client: TransactionClient,
): Promise<void> {
	if (checkoutIntent.providerOrderId === fact.providerOrderId) return;
	if (checkoutIntent.providerOrderId !== null) {
		throw new Error("CREDIT_PACK_CHECKOUT_ORDER_MISMATCH");
	}
	try {
		const bound = await client.paymentCheckoutIntent.updateMany({
			where: {
				id: checkoutIntent.id,
				provider: fact.provider,
				productKind: "CREDIT_PACK",
				status: "PROVIDER_PENDING",
				providerOrderId: null,
			},
			data: { providerOrderId: fact.providerOrderId },
		});
		if (bound.count !== 1) throw new Error("CREDIT_PACK_CHECKOUT_ORDER_MISMATCH");
	} catch (error) {
		if (isDatabaseUniqueConflict(error)) {
			throw new Error("CREDIT_PACK_CHECKOUT_ORDER_CONFLICT");
		}
		throw error;
	}
}

function creditPackGrantMetadata(
	fulfillment: { id: string },
	provider: string,
	providerPaymentId: string,
): Prisma.InputJsonObject {
	return {
		productKind: "CREDIT_PACK",
		creditPackFulfillmentId: fulfillment.id,
		provider,
		providerPaymentId,
	};
}

function assertFulfillmentReplay(
	fulfillment: {
		checkoutIntentId: string;
		provider: string;
		providerOrderId: string;
		providerPaymentId: string;
		paidAmountMicros: bigint;
		currency: string;
		checkoutIntent: { status: string; productKind: string };
	},
	fact: CreditPackPaymentFact,
): void {
	if (
		!fact.checkoutIntentId ||
		fulfillment.checkoutIntentId !== fact.checkoutIntentId ||
		fulfillment.provider !== fact.provider ||
		fulfillment.providerOrderId !== fact.providerOrderId ||
		fulfillment.providerPaymentId !== fact.providerPaymentId ||
		fulfillment.paidAmountMicros !== fact.amountMicros ||
		fulfillment.currency !== fact.currency ||
		fulfillment.checkoutIntent.productKind !== "CREDIT_PACK" ||
		fulfillment.checkoutIntent.status !== "COMPLETED"
	) {
		throw new Error("CREDIT_PACK_PAYMENT_REPLAY_CONFLICT");
	}
}

function metadataString(value: Prisma.JsonValue, key: string): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value[key];
	return typeof result === "string" ? result : null;
}

function metadataInteger(value: Prisma.JsonValue, key: string): number | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value[key];
	return typeof result === "number" && Number.isInteger(result) ? result : null;
}
