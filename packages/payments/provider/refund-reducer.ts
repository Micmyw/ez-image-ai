import {
	PAYMENT_PROVIDER_CORRELATION_MISSING,
	refundCreditGrant,
	type Prisma,
} from "@repo/database";

import {
	applyCreditPackRefundFact,
	calculateCreditPackRefundTargetCredits,
} from "./credit-pack-reducer";
import type { ProviderRefundFact } from "./lifecycle-normalization";

export async function applyProviderRefundFact(
	fact: ProviderRefundFact,
	client: Prisma.TransactionClient,
	options: { now?: Date; paymentEventId?: string } = {},
): Promise<{ grantsCreated: number }> {
	const pack = await client.creditPackFulfillment.findUnique({
		where: {
			provider_providerPaymentId: {
				provider: fact.provider,
				providerPaymentId: fact.providerPaymentId,
			},
		},
	});
	if (pack) {
		if (fact.providerSubscriptionId && fact.providerSubscriptionId !== pack.providerOrderId)
			throw new Error("PAYMENT_PROVIDER_REFUND_BINDING_CONFLICT");
		return applyCreditPackRefundFact(fact, client, options);
	}
	const paymentKey = `${fact.provider}:${fact.providerPaymentId}`;
	const binding = await client.billingPeriod.findFirst({
		where: { providerInvoicePaymentId: paymentKey },
		include: { subscription: { include: { plan: true } } },
	});
	if (!binding) throw new Error(PAYMENT_PROVIDER_CORRELATION_MISSING);
	const subscription = binding.subscription;
	if (
		subscription.provider !== fact.provider ||
		(fact.providerSubscriptionId &&
			fact.providerSubscriptionId !== subscription.providerSubscriptionId)
	)
		throw new Error("PAYMENT_PROVIDER_REFUND_BINDING_CONFLICT");
	// Same subscription -> payment -> period lock order as fulfillment. Granting
	// a due month also locks its period before touching the credit account.
	await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${fact.provider}:${subscription.providerSubscriptionId}`}, 0))::text AS "locked"`;
	await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-provider-payment:${paymentKey}`}, 0))::text AS "locked"`;
	await client.$queryRaw`SELECT "id" FROM "billing_period" WHERE "providerInvoicePaymentId" = ${paymentKey} ORDER BY "startsAt", "id" FOR UPDATE`;
	const periods = await client.billingPeriod.findMany({
		where: { providerInvoicePaymentId: paymentKey },
		orderBy: [{ startsAt: "asc" }, { id: "asc" }],
	});
	if (
		!periods.length ||
		periods.some(
			(p) => p.subscriptionId !== subscription.id || p.paidAmount !== binding.paidAmount,
		) ||
		binding.paidAmount <= 0n
	)
		throw new Error("PAYMENT_PROVIDER_REFUND_BINDING_CONFLICT");
	if (
		fact.currency !== subscription.plan.currency ||
		fact.amountMicros <= 0n ||
		fact.amountMicros > binding.paidAmount
	)
		throw new Error("PAYMENT_PROVIDER_REFUND_AMOUNT_INVALID");
	if (fact.occurredAt < periods[0]!.startsAt)
		throw new Error("PAYMENT_PROVIDER_REFUND_TIME_INVALID");
	const kind = fact.adjustmentKind ?? "REFUND";
	let adjustment = await client.subscriptionPaymentAdjustment.findUnique({
		where: {
			provider_providerAdjustmentId: {
				provider: fact.provider,
				providerAdjustmentId: fact.providerRefundId,
			},
		},
	});
	if (adjustment) {
		if (
			adjustment.subscriptionId !== subscription.id ||
			adjustment.providerPaymentId !== fact.providerPaymentId ||
			adjustment.amountMicros !== fact.amountMicros ||
			adjustment.currency !== fact.currency ||
			adjustment.kind !== kind
		)
			throw new Error("PAYMENT_PROVIDER_REFUND_BINDING_CONFLICT");
		if (adjustment.creditsFinalizedAt) return { grantsCreated: 0 };
	} else {
		adjustment = await client.subscriptionPaymentAdjustment.create({
			data: {
				subscriptionId: subscription.id,
				provider: fact.provider,
				providerPaymentId: fact.providerPaymentId,
				providerAdjustmentId: fact.providerRefundId,
				amountMicros: fact.amountMicros,
				currency: fact.currency,
				kind,
				providerCreatedAt: fact.occurredAt,
				paymentEventId: options.paymentEventId,
			},
		});
	}
	const adjustments = await client.subscriptionPaymentAdjustment.findMany({
		where: { provider: fact.provider, providerPaymentId: fact.providerPaymentId },
	});
	const refundAmount = adjustments
		.filter((a) => a.kind === "REFUND")
		.reduce((sum, a) => sum + a.amountMicros, 0n);
	const reversedAmount = adjustments
		.filter((a) => a.kind === "REVERSAL")
		.reduce((max, a) => (a.amountMicros > max ? a.amountMicros : max), 0n);
	if (refundAmount > binding.paidAmount) throw new Error("PAYMENT_PROVIDER_REFUND_AMOUNT_INVALID");
	// Reversal describes withdrawn payment funds, not an additional refund on top
	// of amounts already refunded for that same sale.
	const totalAmount = refundAmount > reversedAmount ? refundAmount : reversedAmount;
	const totalCredits = periods.reduce((sum, p) => sum + p.creditAmount, 0n);
	const alreadyRefunded = periods.reduce((sum, p) => sum + p.refundedCredits, 0n);
	const target = calculateCreditPackRefundTargetCredits({
		grantedCredits: totalCredits,
		paidAmountMicros: binding.paidAmount,
		refundedAmountMicros: totalAmount,
	});
	let remaining = target - alreadyRefunded;
	if (remaining < 0n) throw new Error("PAYMENT_PROVIDER_REFUND_PROJECTION_CONFLICT");
	const finalizedCredits = remaining;
	const account = await client.creditAccount.findUnique({
		where: {
			ownerType_ownerId: { ownerType: subscription.ownerType, ownerId: subscription.ownerId },
		},
	});
	for (const period of periods) {
		const available = period.creditAmount - period.refundedCredits;
		const allocated = available < remaining ? available : remaining;
		if (allocated > 0n) {
			const grant = period.grantReferenceKey
				? await client.creditLedgerEntry.findUnique({
						where: { referenceKey: period.grantReferenceKey },
					})
				: null;
			if (grant && period.grantReferenceKey) {
				if (!account) throw new Error("PAYMENT_PROVIDER_CREDIT_ACCOUNT_MISSING");
				// A period may have been granted after an earlier partial refund;
				// only the still-unrefunded portion of its actual grant is revocable.
				await refundCreditGrant(
					{
						accountId: account.id,
						amount: allocated,
						grantReferenceKey: period.grantReferenceKey,
						referenceKey: `provider-refund:${adjustment.id}:${period.id}`,
						metadata: {
							provider: fact.provider,
							providerRefundId: fact.providerRefundId,
							billingPeriodId: period.id,
							paymentEventId: options.paymentEventId ?? null,
						},
					},
					client,
				);
			}
			remaining -= allocated;
		}
		await client.billingPeriod.update({
			where: { id: period.id },
			data: {
				refundedAmount: totalAmount,
				refundedCredits: { increment: allocated },
				...(period.refundedCredits + allocated === period.creditAmount
					? { status: "REFUNDED" }
					: {}),
			},
		});
	}
	if (remaining !== 0n) throw new Error("PAYMENT_PROVIDER_REFUND_PROJECTION_CONFLICT");
	await client.subscriptionPaymentAdjustment.update({
		where: { id: adjustment.id },
		data: { finalizedCredits, creditsFinalizedAt: options.now ?? new Date() },
	});
	await client.auditLog.create({
		data: {
			action: "SUBSCRIPTION_PAYMENT_REFUND_APPLIED",
			targetType: "PAYMENT_EVENT",
			targetId: options.paymentEventId ?? adjustment.id,
			after: {
				adjustmentId: adjustment.id,
				provider: fact.provider,
				providerPaymentId: fact.providerPaymentId,
				refundedAmountMicros: totalAmount.toString(),
				refundedCredits: finalizedCredits.toString(),
			},
			metadata: { providerEventId: fact.providerEventId },
		},
	});
	return { grantsCreated: 0 };
}
