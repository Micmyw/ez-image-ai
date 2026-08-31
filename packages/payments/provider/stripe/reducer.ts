import { createCreditGrant, refundCreditGrant, runSerializable, type Prisma } from "@repo/database";

import {
	calculateCumulativeCreditRefund,
	createAnnualBillingPeriods,
	isExactBillingInterval,
	shouldApplyRefundEvent,
	shouldApplySubscriptionEvent,
} from "./events";
import type {
	StripeBillingFact,
	StripeInvoicePaymentFailedFact,
	StripePaidInvoiceFact,
	StripeRefundFact,
	StripeSubscriptionFact,
} from "./normalization";

type TransactionClient = Prisma.TransactionClient;
type DatabaseClient = Parameters<typeof runSerializable>[0];

export interface ApplyStripeBillingFactOptions {
	paymentEventId?: string;
	now?: Date;
}

export async function applyStripeBillingFact(
	fact: StripeBillingFact,
	client: TransactionClient,
	options: ApplyStripeBillingFactOptions = {},
): Promise<{ grantsCreated: number }> {
	switch (fact.kind) {
		case "SUBSCRIPTION":
			await applySubscriptionFact(fact, client);
			return { grantsCreated: 0 };
		case "PAID_INVOICE":
			return {
				grantsCreated: await applyPaidInvoiceFact(fact, client, options.now ?? new Date()),
			};
		case "INVOICE_PAYMENT_FAILED":
			await applyInvoicePaymentFailedFact(fact, client);
			return { grantsCreated: 0 };
		case "REFUND":
			await applyRefundFact(fact, client, options);
			return { grantsCreated: 0 };
	}
}

async function applyPaidInvoiceFact(
	fact: StripePaidInvoiceFact,
	client: TransactionClient,
	operationNow: Date,
): Promise<number> {
	await lockStripeSubscriptionAndCustomer(fact.providerSubscriptionId, fact.customerId, client);
	const subscription = await exactlyOneSubscription(fact.providerSubscriptionId, client);
	await assertInvoiceSubscriptionCompatibility(subscription, fact.customerId, client);
	const invoicePlan = await client.billingPlan.findUnique({
		where: {
			provider_providerPriceId: { provider: "stripe", providerPriceId: fact.priceId },
		},
	});
	// BillingPlan rows are immutable price/entitlement snapshots. An inactive row is still
	// required to recover a historical invoice after the subscription has moved to another plan.
	if (!invoicePlan) throw new Error("STRIPE_INVOICE_PLAN_UNMAPPED");
	const intervalValue = jsonString(invoicePlan.metadata, "interval");
	if (intervalValue !== "month" && intervalValue !== "year") {
		throw new Error("STRIPE_INVOICE_PLAN_INTERVAL_INVALID");
	}
	const interval = intervalValue;
	if (
		!isExactBillingInterval({
			interval,
			startsAt: fact.periodStart,
			endsAt: fact.periodEnd,
		})
	) {
		throw new Error(
			interval === "year"
				? "STRIPE_ANNUAL_INVOICE_PERIOD_INVALID"
				: "STRIPE_MONTHLY_INVOICE_PERIOD_INVALID",
		);
	}
	const shouldApplyStatus = shouldActivateSubscriptionFromInvoice(subscription, fact, operationNow);
	if (shouldApplyStatus) {
		if (subscription.scheduledPlanId && subscription.scheduledPlanId !== invoicePlan.id) {
			throw new Error("STRIPE_SCHEDULED_PLAN_MISMATCH");
		}
		if (!subscription.scheduledPlanId && invoicePlan.id !== subscription.planId) {
			throw new Error("STRIPE_UNSCHEDULED_PLAN_CHANGE");
		}
		await client.subscription.update({
			where: { id: subscription.id },
			data: {
				...(subscription.scheduledPlanId ? { planId: invoicePlan.id, scheduledPlanId: null } : {}),
				status: "ACTIVE",
				currentPeriodStart: fact.periodStart,
				currentPeriodEnd: fact.periodEnd,
				graceEndsAt: null,
				lastProviderEventAt: fact.context.changeAt,
				lastProviderEventId: fact.context.changeId,
			},
		});
	}
	if (shouldApplyStatus) {
		await client.purchase.update({
			where: { id: subscription.purchase!.id },
			data: { priceId: fact.priceId, status: purchaseStatus("ACTIVE") },
		});
	}

	const periods =
		interval === "year"
			? createAnnualBillingPeriods({
					startsAt: fact.periodStart,
					endsAt: fact.periodEnd,
					creditsPerPeriod: invoicePlan.creditsPerPeriod,
				})
			: [
					{
						startsAt: fact.periodStart,
						endsAt: fact.periodEnd,
						creditAmount: invoicePlan.creditsPerPeriod,
					},
				];

	let activePeriodId: string | null = null;
	for (const [index, period] of periods.entries()) {
		const grantReferenceKey = `stripe-invoice:${fact.providerInvoiceId}:period:${index}:grant`;
		const temporalStatus = billingPeriodStatusAt(period, operationNow);
		const existing = await client.billingPeriod.findUnique({
			where: {
				subscriptionId_startsAt: {
					subscriptionId: subscription.id,
					startsAt: period.startsAt,
				},
			},
		});
		if (existing) {
			assertCompatibleBillingPeriod(existing, fact, period, grantReferenceKey);
		}
		const saved = existing
			? await client.billingPeriod.update({
					where: { id: existing.id },
					data: {
						status: mergeBillingPeriodStatus(existing.status, temporalStatus),
						grantReferenceKey: existing.grantReferenceKey ?? grantReferenceKey,
						providerInvoiceId: fact.providerInvoiceId,
						providerInvoicePaymentId: fact.providerInvoicePaymentId,
						providerChargeId: fact.providerChargeId,
						providerPaymentIntentId: fact.providerPaymentIntentId,
						paidAmount: fact.amountPaid,
					},
				})
			: await client.billingPeriod.create({
					data: {
						subscriptionId: subscription.id,
						startsAt: period.startsAt,
						endsAt: period.endsAt,
						status: temporalStatus,
						creditAmount: period.creditAmount,
						grantReferenceKey,
						providerInvoiceId: fact.providerInvoiceId,
						providerInvoicePaymentId: fact.providerInvoicePaymentId,
						providerChargeId: fact.providerChargeId,
						providerPaymentIntentId: fact.providerPaymentIntentId,
						paidAmount: fact.amountPaid,
					},
				});
		if (saved.status === "ACTIVE") activePeriodId = saved.id;
	}

	if (!activePeriodId) return 0;
	const activePeriod = await client.billingPeriod.findUniqueOrThrow({
		where: { id: activePeriodId },
	});
	const netCredits = activePeriod.creditAmount - activePeriod.refundedCredits;
	if (netCredits <= 0n) {
		await client.billingPeriod.update({
			where: { id: activePeriod.id },
			data: { status: "REFUNDED" },
		});
		return 0;
	}
	const account = await ensureCreditAccount(subscription.ownerType, subscription.ownerId, client);
	const existingGrant = await client.creditLedgerEntry.findUnique({
		where: { referenceKey: activePeriod.grantReferenceKey! },
	});
	await createCreditGrant(
		{
			accountId: account.id,
			// An invoice replay after a refund must validate the original grant command,
			// not reinterpret the same reference as either its gross or current net value.
			amount: existingGrant ? readGrantCommandAmount(existingGrant.metadata) : netCredits,
			referenceKey: activePeriod.grantReferenceKey!,
			expiresAt: activePeriod.endsAt,
			metadata: {
				providerInvoiceId: fact.providerInvoiceId,
				providerInvoicePaymentId: fact.providerInvoicePaymentId,
				billingPeriodId: activePeriod.id,
			},
		},
		client,
	);
	return existingGrant ? 0 : 1;
}

function shouldActivateSubscriptionFromInvoice(
	subscription: {
		status: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
		currentPeriodStart: Date | null;
		lastProviderEventAt: Date | null;
	},
	fact: StripePaidInvoiceFact,
	operationNow: Date,
): boolean {
	if (
		operationNow.getTime() < fact.periodStart.getTime() ||
		operationNow.getTime() >= fact.periodEnd.getTime()
	) {
		return false;
	}
	if (subscription.status === "CANCELED" || subscription.status === "EXPIRED") return false;
	if (
		subscription.currentPeriodStart &&
		fact.periodEnd.getTime() <= subscription.currentPeriodStart.getTime()
	) {
		return false;
	}
	if (!subscription.lastProviderEventAt) return true;
	// Stripe event timestamps and reconciliation cutoffs have only second-level ordering.
	// An equal timestamp cannot safely order a subscription lifecycle event against an invoice,
	// so leave lifecycle state unchanged while still applying the independently idempotent invoice.
	return fact.context.changeAt.getTime() > subscription.lastProviderEventAt.getTime();
}

type TemporalBillingPeriodStatus = "PENDING" | "ACTIVE" | "CLOSED";

function billingPeriodStatusAt(
	period: { startsAt: Date; endsAt: Date },
	observedAt: Date,
): TemporalBillingPeriodStatus {
	if (observedAt.getTime() < period.startsAt.getTime()) return "PENDING";
	if (observedAt.getTime() >= period.endsAt.getTime()) return "CLOSED";
	return "ACTIVE";
}

function mergeBillingPeriodStatus(
	existing: TemporalBillingPeriodStatus | "VOID" | "REFUNDED",
	incoming: TemporalBillingPeriodStatus,
): TemporalBillingPeriodStatus | "VOID" | "REFUNDED" {
	if (existing === "VOID" || existing === "REFUNDED") return existing;
	const rank: Record<TemporalBillingPeriodStatus, number> = {
		PENDING: 0,
		ACTIVE: 1,
		CLOSED: 2,
	};
	return rank[incoming] > rank[existing] ? incoming : existing;
}

async function applyRefundFact(
	fact: StripeRefundFact,
	client: TransactionClient,
	options: ApplyStripeBillingFactOptions,
): Promise<void> {
	const now = options.now ?? new Date();
	const { refund, shouldApply } = await upsertStripeRefundLifecycle(
		fact,
		client,
		options.paymentEventId,
	);
	// Legacy processors could mutate either the immutable refund ledger or future
	// ungranted billing-period projections before Stripe reached a successful terminal
	// state. Check the whole charge before every early return so pending/failed/canceled
	// facts cannot make that contamination look processed and healthy.
	await assertNoUnsupportedLegacyRefundMutation(fact.providerChargeId, client);

	if (
		refund.status !== "SUCCEEDED" ||
		refund.creditsFinalizedAt ||
		(!shouldApply && fact.status !== "SUCCEEDED")
	) {
		return;
	}

	const lockedRows = await client.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "billing_period"
		WHERE "providerChargeId" = ${fact.providerChargeId}
		ORDER BY "startsAt" ASC, "id" ASC FOR UPDATE`;
	if (lockedRows.length === 0) throw new Error("STRIPE_REFUND_BINDING_PENDING");
	const periods = await client.billingPeriod.findMany({
		where: { id: { in: lockedRows.map((row) => row.id) } },
		include: { subscription: true },
		orderBy: [{ startsAt: "asc" }, { id: "asc" }],
	});
	assertOneInvoiceGroup(periods);
	const firstPeriod = periods[0]!;
	if (firstPeriod.paidAmount <= 0n) throw new Error("STRIPE_REFUND_BINDING_AMBIGUOUS");

	const succeededRefunds = await client.stripeRefund.aggregate({
		where: {
			provider: "stripe",
			providerChargeId: fact.providerChargeId,
			status: "SUCCEEDED",
		},
		_sum: { amount: true },
	});
	const succeededRefundAmount = succeededRefunds._sum.amount ?? 0n;
	if (succeededRefundAmount > firstPeriod.paidAmount) {
		throw new Error("STRIPE_REFUND_AMOUNT_EXCEEDS_INVOICE");
	}
	const invoiceCredits = periods.reduce((sum, period) => sum + period.creditAmount, 0n);
	const creditsAlreadyRefunded = periods.reduce((sum, period) => sum + period.refundedCredits, 0n);
	const cumulativeCredits = calculateCumulativeCreditRefund({
		invoicePaidAmount: firstPeriod.paidAmount,
		invoiceCredits,
		cumulativeSucceededRefundAmount: succeededRefundAmount,
	});
	let creditsToRefund = cumulativeCredits - creditsAlreadyRefunded;
	if (creditsToRefund < 0n) creditsToRefund = 0n;
	let finalizedCredits = 0n;
	const account = await ensureCreditAccount(
		firstPeriod.subscription.ownerType,
		firstPeriod.subscription.ownerId,
		client,
	);

	for (const period of periods) {
		if (creditsToRefund <= 0n) break;
		const refundable = period.creditAmount - period.refundedCredits;
		const allocated = refundable < creditsToRefund ? refundable : creditsToRefund;
		if (allocated <= 0n) continue;
		const grant = period.grantReferenceKey
			? await client.creditLedgerEntry.findUnique({
					where: { referenceKey: period.grantReferenceKey },
				})
			: null;
		if (grant && period.grantReferenceKey) {
			await refundCreditGrant(
				{
					accountId: account.id,
					amount: allocated,
					grantReferenceKey: period.grantReferenceKey,
					referenceKey: `stripe-refund:${fact.providerRefundId}:${period.id}`,
					metadata: {
						providerRefundId: fact.providerRefundId,
						providerChargeId: fact.providerChargeId,
						billingPeriodId: period.id,
					},
				},
				client,
			);
		}
		await client.billingPeriod.update({
			where: { id: period.id },
			data: {
				refundedCredits: { increment: allocated },
				...(period.refundedCredits + allocated === period.creditAmount
					? { status: "REFUNDED" }
					: {}),
			},
		});
		creditsToRefund -= allocated;
		finalizedCredits += allocated;
	}
	if (creditsToRefund !== 0n) throw new Error("STRIPE_REFUND_CREDIT_ALLOCATION_INCONSISTENT");

	await client.billingPeriod.update({
		where: { id: firstPeriod.id },
		data: { refundedAmount: succeededRefundAmount },
	});
	await client.stripeRefund.update({
		where: { id: refund.id },
		data: { finalizedCredits, creditsFinalizedAt: now },
	});
}

export async function persistStripeRefundLifecycleForReview(
	fact: StripeRefundFact,
	client: TransactionClient,
): Promise<void> {
	await upsertStripeRefundLifecycle(fact, client);
}

async function upsertStripeRefundLifecycle(
	fact: StripeRefundFact,
	client: TransactionClient,
	paymentEventId?: string,
) {
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(hashtextextended(${`stripe-refund:${fact.providerChargeId}`}, 0))::text AS "locked"`;
	let refund = await client.stripeRefund.findUnique({
		where: {
			provider_providerRefundId: {
				provider: "stripe",
				providerRefundId: fact.providerRefundId,
			},
		},
	});
	if (refund) assertCompatibleRefund(refund, fact);
	if (
		refund &&
		fact.context.origin === "RECONCILIATION" &&
		isTerminalRefundStatus(refund.status) &&
		refund.status !== fact.status &&
		fact.context.changeAt.getTime() >= refund.lastProviderChangeAt.getTime()
	) {
		throw new Error("STRIPE_REFUND_TERMINAL_CONFLICT");
	}
	const shouldApply = refund ? shouldApplyRefundFact(refund, fact) : true;
	if (!refund) {
		refund = await client.stripeRefund.create({
			data: {
				provider: "stripe",
				providerRefundId: fact.providerRefundId,
				providerChargeId: fact.providerChargeId,
				providerPaymentIntentId: fact.providerPaymentIntentId,
				amount: fact.amount,
				currency: fact.currency,
				status: fact.status,
				providerCreatedAt: fact.providerCreatedAt,
				lastProviderChangeAt: fact.context.changeAt,
				lastProviderChangeId: fact.context.changeId,
			},
		});
	} else if (shouldApply) {
		refund = await client.stripeRefund.update({
			where: { id: refund.id },
			data: {
				status: fact.status,
				providerPaymentIntentId: refund.providerPaymentIntentId ?? fact.providerPaymentIntentId,
				lastProviderChangeAt: fact.context.changeAt,
				lastProviderChangeId: fact.context.changeId,
			},
		});
	}

	if (paymentEventId) {
		await client.stripeRefundReceipt.upsert({
			where: { paymentEventId },
			create: { refundId: refund.id, paymentEventId },
			update: {},
		});
	}
	return { refund, shouldApply };
}

async function assertNoUnsupportedLegacyRefundMutation(
	providerChargeId: string,
	client: TransactionClient,
): Promise<void> {
	const contaminated = await client.$queryRaw<Array<{ contaminated: boolean }>>`
		WITH legacy_refund AS (
			SELECT split_part(entry."referenceKey", ':', 2) AS "providerRefundId",
			       SUM(entry."amount")::bigint AS "ledgerCredits"
			FROM "credit_ledger_entry" entry
			JOIN "billing_period" period
			  ON period."id" = split_part(entry."referenceKey", ':', 3)
			WHERE entry."type" = 'REFUND'
			  AND entry."referenceKey" ~ '^stripe-refund:re_[A-Za-z0-9_-]+:[^:]+$'
			  AND period."providerChargeId" = ${providerChargeId}
			GROUP BY split_part(entry."referenceKey", ':', 2)
		), compensated_repair AS (
			SELECT refund."providerRefundId", authority."approvedCredits"
			FROM "stripe_refund_repair_authority" authority
			JOIN "stripe_refund_repair_receipt" receipt
			  ON receipt."authorityId" = authority."id"
			 AND receipt."compensatedCredits" = authority."approvedCredits"
			JOIN "stripe_refund" refund ON refund."id" = authority."refundId"
			JOIN "stripe_reconciliation_issue" issue
			  ON issue."id" = authority."issueId"
			 AND issue."provider" = 'stripe'
			 AND issue."entityType" = 'REFUND'
			 AND issue."providerObjectId" = refund."providerRefundId"
			 AND issue."code" = 'STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
			 AND issue."issueKey" =
			     'stripe:REFUND:' || refund."providerRefundId" || ':STRIPE_LEGACY_REFUND_REPAIR_REQUIRED'
			 AND issue."status" = 'RESOLVED'
			JOIN "credit_ledger_entry" compensation
			  ON compensation."type" IN ('GRANT', 'DEBT_REPAYMENT')
			 AND compensation."metadata" #>> '{command,metadata,authorityId}' = authority."id"
			 AND compensation."metadata" #>> '{command,metadata,providerRefundId}' =
			     refund."providerRefundId"
			WHERE authority."action" = 'COMPENSATE_FAILED_OR_CANCELED'
			GROUP BY refund."providerRefundId", authority."id", authority."approvedCredits"
			HAVING SUM(compensation."amount") = authority."approvedCredits"
		), legacy_contamination AS (
			SELECT 1
			FROM legacy_refund legacy
			LEFT JOIN "stripe_refund" refund
			  ON refund."provider" = 'stripe'
			 AND refund."providerRefundId" = legacy."providerRefundId"
			WHERE (
				refund."id" IS NULL
				OR refund."status" <> 'SUCCEEDED'
				OR refund."creditsFinalizedAt" IS NULL
				OR refund."finalizedCredits" < legacy."ledgerCredits"
			)
			  AND NOT EXISTS (
				SELECT 1
				FROM compensated_repair repair
				WHERE repair."providerRefundId" = legacy."providerRefundId"
				  AND repair."approvedCredits" = legacy."ledgerCredits"
			  )
			LIMIT 1
		), projection_totals AS (
			SELECT
				COALESCE((
					SELECT SUM(period."refundedCredits")
					FROM "billing_period" period
					WHERE period."providerChargeId" = ${providerChargeId}
				), 0)::bigint AS "projectedCredits",
				COALESCE((
					SELECT SUM(refund."finalizedCredits")
					FROM "stripe_refund" refund
					WHERE refund."provider" = 'stripe'
					  AND refund."providerChargeId" = ${providerChargeId}
					  AND refund."status" = 'SUCCEEDED'
					  AND refund."creditsFinalizedAt" IS NOT NULL
				), 0)::bigint AS "authenticatedCredits"
		)
		SELECT TRUE AS "contaminated"
		WHERE EXISTS (SELECT 1 FROM legacy_contamination)
		   OR EXISTS (
			SELECT 1 FROM projection_totals
			WHERE "projectedCredits" > "authenticatedCredits"
		   )`;
	if (contaminated.length > 0) throw new Error("STRIPE_LEGACY_REFUND_REPAIR_REQUIRED");
}

async function applySubscriptionFact(
	fact: StripeSubscriptionFact,
	client: TransactionClient,
): Promise<void> {
	await lockStripeSubscriptionAndCustomer(fact.providerSubscriptionId, fact.customerId, client);
	const existing = await client.subscription.findUnique({
		where: {
			provider_providerSubscriptionId: {
				provider: "stripe",
				providerSubscriptionId: fact.providerSubscriptionId,
			},
		},
		include: { purchase: true },
	});
	if (!existing) {
		await createBoundSubscription(fact, client);
		return;
	}
	if (existing.provider !== "stripe") {
		throw new Error("STRIPE_SUBSCRIPTION_PROVIDER_CONFLICT");
	}
	if (
		!existing.purchase ||
		existing.purchase.type !== "SUBSCRIPTION" ||
		existing.purchase.subscriptionId !== fact.providerSubscriptionId
	) {
		throw new Error("STRIPE_SUBSCRIPTION_PURCHASE_BINDING_INVALID");
	}
	if (existing.purchase.customerId !== fact.customerId) {
		throw new Error("STRIPE_SUBSCRIPTION_CUSTOMER_CONFLICT");
	}
	if (!purchaseOwnerMatches(existing.purchase, existing.ownerType, existing.ownerId)) {
		throw new Error("STRIPE_SUBSCRIPTION_OWNER_CONFLICT");
	}
	if (
		fact.binding &&
		(fact.binding.ownerType !== existing.ownerType || fact.binding.ownerId !== existing.ownerId)
	) {
		throw new Error("STRIPE_SUBSCRIPTION_OWNER_CONFLICT");
	}
	await assertOwnerCustomerCompatibility(
		existing.ownerType,
		existing.ownerId,
		fact.customerId,
		client,
	);
	const newPlan = await client.billingPlan.findUnique({
		where: {
			provider_providerPriceId: { provider: "stripe", providerPriceId: fact.priceId },
		},
	});
	if (!newPlan) throw new Error("STRIPE_SUBSCRIPTION_PLAN_UNMAPPED");
	const allowExpiredRecovery =
		existing.status === "EXPIRED" && existing.graceEndsAt !== null && !existing.cancelAtPeriodEnd;
	if (
		fact.context.origin === "RECONCILIATION" &&
		(existing.status === "CANCELED" || existing.status === "EXPIRED") &&
		fact.status !== existing.status &&
		!allowExpiredRecovery &&
		fact.context.changeAt.getTime() >= (existing.lastProviderEventAt?.getTime() ?? 0)
	) {
		throw new Error("STRIPE_SUBSCRIPTION_TERMINAL_CONFLICT");
	}
	if (
		!shouldApplySubscriptionEvent({
			currentStatus: existing.status,
			lastEventCreatedAt: existing.lastProviderEventAt,
			lastEventId: existing.lastProviderEventId,
			incomingStatus: fact.status,
			incomingEventCreatedAt: fact.context.changeAt,
			incomingEventId: fact.context.changeId,
			allowExpiredRecovery,
		})
	) {
		return;
	}
	await client.subscription.update({
		where: { id: existing.id },
		data: {
			status: fact.status,
			cancelAtPeriodEnd: fact.cancelAtPeriodEnd || fact.status === "CANCELED",
			lastProviderEventAt: fact.context.changeAt,
			lastProviderEventId: fact.context.changeId,
			currentPeriodStart: fact.currentPeriodStart,
			currentPeriodEnd: fact.currentPeriodEnd,
			graceEndsAt: fact.status === "PAST_DUE" ? fact.currentPeriodEnd : null,
			scheduledPlanId: newPlan.id === existing.planId ? null : newPlan.id,
		},
	});
	await client.purchase.update({
		where: { id: existing.purchase.id },
		data: { status: purchaseStatus(fact.status) },
	});
	await persistOwnerCustomerMapping(existing.ownerType, existing.ownerId, fact.customerId, client);
}

async function createBoundSubscription(
	fact: StripeSubscriptionFact,
	client: TransactionClient,
): Promise<void> {
	const binding = fact.binding;
	if (!binding) throw new Error("STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS");
	const plan = await client.billingPlan.findUnique({ where: { id: binding.billingPlanId } });
	if (
		!plan ||
		plan.provider !== "stripe" ||
		plan.providerPriceId !== fact.priceId ||
		jsonString(plan.metadata, "planId") !== binding.planKey
	) {
		throw new Error("STRIPE_BILLING_PLAN_BINDING_INVALID");
	}
	await assertOwnerCustomerCompatibility(
		binding.ownerType,
		binding.ownerId,
		fact.customerId,
		client,
	);
	const existingPurchase = await client.purchase.findUnique({
		where: {
			provider_subscriptionId: {
				provider: "stripe",
				subscriptionId: fact.providerSubscriptionId,
			},
		},
	});
	const existingOwnerMatches = existingPurchase
		? binding.ownerType === "USER"
			? existingPurchase.userId === binding.ownerId && existingPurchase.organizationId === null
			: existingPurchase.organizationId === binding.ownerId && existingPurchase.userId === null
		: true;
	if (
		existingPurchase &&
		(existingPurchase.type !== "SUBSCRIPTION" ||
			existingPurchase.subscriptionId !== fact.providerSubscriptionId ||
			existingPurchase.customerId !== fact.customerId ||
			existingPurchase.priceId !== fact.priceId ||
			!existingOwnerMatches)
	) {
		throw new Error("STRIPE_PURCHASE_BINDING_INVALID");
	}
	const purchase = existingPurchase
		? await client.purchase.update({
				where: { id: existingPurchase.id },
				data: {
					organizationId: binding.ownerType === "ORGANIZATION" ? binding.ownerId : null,
					userId: binding.ownerType === "USER" ? binding.ownerId : null,
					status: purchaseStatus(fact.status),
				},
			})
		: await client.purchase.create({
				data: {
					provider: "stripe",
					organizationId: binding.ownerType === "ORGANIZATION" ? binding.ownerId : null,
					userId: binding.ownerType === "USER" ? binding.ownerId : null,
					type: "SUBSCRIPTION",
					customerId: fact.customerId,
					subscriptionId: fact.providerSubscriptionId,
					priceId: fact.priceId,
					status: purchaseStatus(fact.status),
				},
			});
	await client.subscription.create({
		data: {
			ownerType: binding.ownerType,
			ownerId: binding.ownerId,
			provider: "stripe",
			providerSubscriptionId: fact.providerSubscriptionId,
			planId: plan.id,
			purchaseId: purchase.id,
			status: fact.status,
			cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
			lastProviderEventAt: fact.context.changeAt,
			lastProviderEventId: fact.context.changeId,
			currentPeriodStart: fact.currentPeriodStart,
			currentPeriodEnd: fact.currentPeriodEnd,
			graceEndsAt: fact.status === "PAST_DUE" ? fact.currentPeriodEnd : null,
		},
	});
	await persistOwnerCustomerMapping(binding.ownerType, binding.ownerId, fact.customerId, client);
	await client.auditLog.create({
		data: {
			actorUserId: binding.submittedByUserId,
			action: "STRIPE_SUBSCRIPTION_BOUND",
			targetType: "SUBSCRIPTION",
			targetId: fact.providerSubscriptionId,
			metadata: {
				billingPlanId: binding.billingPlanId,
				planKey: binding.planKey,
				ownerType: binding.ownerType,
				ownerId: binding.ownerId,
			},
		},
	});
}

async function applyInvoicePaymentFailedFact(
	fact: StripeInvoicePaymentFailedFact,
	client: TransactionClient,
): Promise<void> {
	await lockStripeSubscriptionAndCustomer(fact.providerSubscriptionId, fact.customerId, client);
	const subscription = await exactlyOneSubscription(fact.providerSubscriptionId, client);
	if (
		!shouldApplySubscriptionEvent({
			currentStatus: subscription.status,
			lastEventCreatedAt: subscription.lastProviderEventAt,
			lastEventId: subscription.lastProviderEventId,
			incomingStatus: "PAST_DUE",
			incomingEventCreatedAt: fact.context.changeAt,
			incomingEventId: fact.context.changeId,
		})
	) {
		return;
	}
	await assertInvoiceSubscriptionCompatibility(subscription, fact.customerId, client);
	await client.subscription.update({
		where: { id: subscription.id },
		data: {
			status: "PAST_DUE",
			lastProviderEventAt: fact.context.changeAt,
			lastProviderEventId: fact.context.changeId,
			graceEndsAt: subscription.currentPeriodEnd,
		},
	});
	await client.purchase.update({
		where: { id: subscription.purchase!.id },
		data: { status: purchaseStatus("PAST_DUE") },
	});
}

async function lockStripeSubscriptionAndCustomer(
	providerSubscriptionId: string,
	customerId: string,
	client: TransactionClient,
): Promise<void> {
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(hashtextextended(${`stripe-subscription:${providerSubscriptionId}`}, 0))::text AS "locked"`;
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(hashtextextended(${`stripe-customer:${customerId}`}, 0))::text AS "locked"`;
}

async function assertInvoiceSubscriptionCompatibility(
	subscription: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		providerSubscriptionId: string;
		purchase: {
			id: string;
			type: "SUBSCRIPTION" | "ONE_TIME";
			subscriptionId: string | null;
			customerId: string;
			userId: string | null;
			organizationId: string | null;
		} | null;
	},
	customerId: string,
	client: TransactionClient,
): Promise<void> {
	if (
		!subscription.purchase ||
		subscription.purchase.type !== "SUBSCRIPTION" ||
		subscription.purchase.subscriptionId !== subscription.providerSubscriptionId
	) {
		throw new Error("STRIPE_SUBSCRIPTION_PURCHASE_BINDING_INVALID");
	}
	if (subscription.purchase.customerId !== customerId) {
		throw new Error("STRIPE_SUBSCRIPTION_CUSTOMER_CONFLICT");
	}
	if (!purchaseOwnerMatches(subscription.purchase, subscription.ownerType, subscription.ownerId)) {
		throw new Error("STRIPE_SUBSCRIPTION_OWNER_CONFLICT");
	}
	await assertOwnerCustomerCompatibility(
		subscription.ownerType,
		subscription.ownerId,
		customerId,
		client,
	);
}

function purchaseOwnerMatches(
	purchase: { userId: string | null; organizationId: string | null },
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
): boolean {
	return ownerType === "USER"
		? purchase.userId === ownerId && purchase.organizationId === null
		: purchase.organizationId === ownerId && purchase.userId === null;
}

async function assertOwnerCustomerCompatibility(
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	customerId: string,
	client: TransactionClient,
): Promise<void> {
	const [userOwner, organizationOwner, otherUser, otherOrganization] = await Promise.all([
		ownerType === "USER"
			? client.user.findUnique({ where: { id: ownerId }, select: { paymentsCustomerId: true } })
			: null,
		ownerType === "ORGANIZATION"
			? client.organization.findUnique({
					where: { id: ownerId },
					select: { paymentsCustomerId: true },
				})
			: null,
		client.user.findFirst({
			where: {
				paymentsCustomerId: customerId,
				...(ownerType === "USER" ? { id: { not: ownerId } } : {}),
			},
			select: { id: true },
		}),
		client.organization.findFirst({
			where: {
				paymentsCustomerId: customerId,
				...(ownerType === "ORGANIZATION" ? { id: { not: ownerId } } : {}),
			},
			select: { id: true },
		}),
	]);
	const owner = ownerType === "USER" ? userOwner : organizationOwner;
	if (!owner) throw new Error("STRIPE_SUBSCRIPTION_OWNER_INVALID");
	if (
		(owner.paymentsCustomerId !== null && owner.paymentsCustomerId !== customerId) ||
		otherUser ||
		otherOrganization
	) {
		throw new Error("STRIPE_CUSTOMER_OWNER_CONFLICT");
	}
}

async function persistOwnerCustomerMapping(
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	customerId: string,
	client: TransactionClient,
): Promise<void> {
	const result =
		ownerType === "USER"
			? await client.user.updateMany({
					where: {
						id: ownerId,
						OR: [{ paymentsCustomerId: null }, { paymentsCustomerId: customerId }],
					},
					data: { paymentsCustomerId: customerId },
				})
			: await client.organization.updateMany({
					where: {
						id: ownerId,
						OR: [{ paymentsCustomerId: null }, { paymentsCustomerId: customerId }],
					},
					data: { paymentsCustomerId: customerId },
				});
	if (result.count !== 1) throw new Error("STRIPE_CUSTOMER_OWNER_CONFLICT");
}

export async function grantDueBillingPeriods(
	input: { now?: Date; limit?: number },
	client: DatabaseClient,
): Promise<{ granted: number }> {
	const now = input.now ?? new Date();
	const candidates = await client.billingPeriod.findMany({
		where: {
			status: "PENDING",
			startsAt: { lte: now },
			endsAt: { gt: now },
			subscription: { status: "ACTIVE" },
		},
		select: { id: true },
		orderBy: [{ startsAt: "asc" }, { id: "asc" }],
		take: input.limit ?? 100,
	});
	let granted = 0;
	for (const candidate of candidates) {
		const created = await runSerializable(client, async (tx) => {
			const locked = await tx.$queryRaw<Array<{ id: string }>>`
				SELECT "id" FROM "billing_period" WHERE "id" = ${candidate.id} FOR UPDATE`;
			if (locked.length !== 1) return false;
			const period = await tx.billingPeriod.findUnique({
				where: { id: candidate.id },
				include: { subscription: true },
			});
			if (
				!period ||
				period.status !== "PENDING" ||
				period.startsAt > now ||
				period.endsAt <= now ||
				period.subscription.status !== "ACTIVE" ||
				!period.grantReferenceKey
			) {
				return false;
			}
			const netCredits = period.creditAmount - period.refundedCredits;
			if (netCredits <= 0n) {
				await tx.billingPeriod.update({
					where: { id: period.id },
					data: { status: "REFUNDED" },
				});
				return false;
			}
			const account = await ensureCreditAccount(
				period.subscription.ownerType,
				period.subscription.ownerId,
				tx,
			);
			const existing = await tx.creditLedgerEntry.findUnique({
				where: { referenceKey: period.grantReferenceKey },
			});
			await createCreditGrant(
				{
					accountId: account.id,
					amount: netCredits,
					referenceKey: period.grantReferenceKey,
					expiresAt: period.endsAt,
					metadata: {
						billingPeriodId: period.id,
						providerInvoiceId: period.providerInvoiceId,
						providerInvoicePaymentId: period.providerInvoicePaymentId,
					},
				},
				tx,
			);
			await tx.billingPeriod.update({
				where: { id: period.id },
				data: { status: "ACTIVE" },
			});
			return !existing;
		});
		if (created) granted += 1;
	}
	return { granted };
}

async function exactlyOneSubscription(providerSubscriptionId: string, client: TransactionClient) {
	const matches = await client.subscription.findMany({
		where: { provider: "stripe", providerSubscriptionId },
		include: { plan: true, purchase: true },
		take: 2,
	});
	if (matches.length === 0) throw new Error("STRIPE_SUBSCRIPTION_BINDING_PENDING");
	if (matches.length > 1) throw new Error("STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS");
	return matches[0]!;
}

async function ensureCreditAccount(
	ownerType: "USER" | "ORGANIZATION",
	ownerId: string,
	client: Pick<TransactionClient, "creditAccount">,
) {
	return client.creditAccount.upsert({
		where: { ownerType_ownerId: { ownerType, ownerId } },
		create: { ownerType, ownerId },
		update: {},
	});
}

function assertCompatibleBillingPeriod(
	period: {
		endsAt: Date;
		creditAmount: bigint;
		grantReferenceKey: string | null;
		providerInvoiceId: string | null;
		providerInvoicePaymentId: string | null;
		providerChargeId: string | null;
		providerPaymentIntentId: string | null;
		paidAmount: bigint;
	},
	fact: StripePaidInvoiceFact,
	expected: { endsAt: Date; creditAmount: bigint },
	grantReferenceKey: string,
) {
	if (
		period.endsAt.getTime() !== expected.endsAt.getTime() ||
		period.creditAmount !== expected.creditAmount ||
		(period.grantReferenceKey !== null && period.grantReferenceKey !== grantReferenceKey) ||
		(period.providerInvoiceId !== null && period.providerInvoiceId !== fact.providerInvoiceId) ||
		(period.providerInvoicePaymentId !== null &&
			period.providerInvoicePaymentId !== fact.providerInvoicePaymentId) ||
		(period.providerChargeId !== null && period.providerChargeId !== fact.providerChargeId) ||
		(period.providerPaymentIntentId !== null &&
			period.providerPaymentIntentId !== fact.providerPaymentIntentId) ||
		(period.paidAmount !== 0n && period.paidAmount !== fact.amountPaid)
	) {
		throw new Error("STRIPE_INVOICE_BINDING_AMBIGUOUS");
	}
}

function assertCompatibleRefund(
	refund: {
		providerChargeId: string;
		providerPaymentIntentId: string | null;
		amount: bigint;
		currency: string;
	},
	fact: StripeRefundFact,
) {
	if (
		refund.providerChargeId !== fact.providerChargeId ||
		refund.amount !== fact.amount ||
		refund.currency !== fact.currency ||
		(refund.providerPaymentIntentId !== null &&
			fact.providerPaymentIntentId !== null &&
			refund.providerPaymentIntentId !== fact.providerPaymentIntentId)
	) {
		throw new Error("STRIPE_REFUND_IDENTITY_CONFLICT");
	}
}

function shouldApplyRefundFact(
	refund: {
		status: "PENDING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED";
		lastProviderChangeAt: Date;
		lastProviderChangeId: string;
	},
	fact: StripeRefundFact,
): boolean {
	return shouldApplyRefundEvent({
		currentStatus: refund.status,
		lastEventCreatedAt: refund.lastProviderChangeAt,
		lastEventId: refund.lastProviderChangeId,
		incomingStatus: fact.status,
		incomingEventCreatedAt: fact.context.changeAt,
		incomingEventId: fact.context.changeId,
	});
}

function isTerminalRefundStatus(
	status: "PENDING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED",
): boolean {
	return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELED";
}

function assertOneInvoiceGroup(
	periods: Array<{
		subscriptionId: string;
		providerInvoiceId: string | null;
		providerInvoicePaymentId: string | null;
	}>,
) {
	const subscriptions = new Set(periods.map((period) => period.subscriptionId));
	const invoices = new Set(periods.map((period) => period.providerInvoiceId).filter(Boolean));
	const payments = new Set(
		periods.map((period) => period.providerInvoicePaymentId).filter(Boolean),
	);
	if (subscriptions.size !== 1 || invoices.size !== 1 || payments.size !== 1) {
		throw new Error("STRIPE_REFUND_BINDING_AMBIGUOUS");
	}
}

function jsonString(value: Prisma.JsonValue, key: string): string | undefined {
	return value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof value[key] === "string"
		? value[key]
		: undefined;
}

function readGrantCommandAmount(metadata: Prisma.JsonValue): bigint {
	const command =
		metadata && typeof metadata === "object" && !Array.isArray(metadata)
			? metadata.command
			: undefined;
	const amount =
		command && typeof command === "object" && !Array.isArray(command) && command.kind === "GRANT"
			? command.amount
			: undefined;
	if (typeof amount !== "string" || !/^[1-9]\d*$/.test(amount)) {
		throw new Error("STRIPE_INVOICE_BINDING_AMBIGUOUS");
	}
	return BigInt(amount);
}

function purchaseStatus(
	status: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED",
): string {
	return status.toLowerCase();
}
