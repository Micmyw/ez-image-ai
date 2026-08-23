import {
	claimPaymentEvent,
	createCreditGrant,
	failPaymentEvent,
	refundCreditGrant,
	runSerializable,
	type Prisma,
} from "@repo/database";
import { logger } from "@repo/logs";

import {
	calculateProportionalCreditRefund,
	createAnnualBillingPeriods,
	shouldApplySubscriptionEvent,
} from "./events";

interface StripeEnvelope {
	id: string;
	type: string;
	created: number;
	data: { object: Record<string, unknown> };
}

interface ProcessResult {
	outcome: "PROCESSED" | "SKIPPED" | "FAILED";
	grantsCreated: number;
}

type DatabaseClient = Parameters<typeof claimPaymentEvent>[1];
type TransactionClient = Prisma.TransactionClient;

class PaymentEventFenceError extends Error {}

export async function processStripePaymentEvent(
	input: { paymentEventId: string },
	client: DatabaseClient,
): Promise<ProcessResult> {
	const claim = await claimPaymentEvent(input.paymentEventId, client);
	if (!claim) return { outcome: "SKIPPED", grantsCreated: 0 };
	return processClaimedStripePaymentEvent(
		{ paymentEventId: claim.event.id, processingToken: claim.token },
		client,
	);
}

export async function processClaimedStripePaymentEvent(
	input: { paymentEventId: string; processingToken: string; now?: Date },
	client: DatabaseClient,
): Promise<ProcessResult> {
	const now = input.now ?? new Date();
	try {
		const grantsCreated = await runSerializable(client, async (tx) => {
			const rows = await tx.$queryRaw<
				Array<{
					id: string;
					status: string;
					processingToken: string | null;
					processingLeasedUntil: Date | null;
					envelope: Prisma.JsonValue;
				}>
			>`SELECT "id", "status", "processingToken", "processingLeasedUntil", "envelope"
				  FROM "payment_event" WHERE "id" = ${input.paymentEventId} FOR UPDATE`;
			const event = rows[0];
			if (
				!event ||
				event.status !== "PROCESSING" ||
				event.processingToken !== input.processingToken ||
				!event.processingLeasedUntil ||
				event.processingLeasedUntil <= now
			) {
				throw new PaymentEventFenceError();
			}
			const processed = await processEnvelope(parseEnvelope(event.envelope), tx);
			const completed = await tx.paymentEvent.updateMany({
				where: {
					id: input.paymentEventId,
					status: "PROCESSING",
					processingToken: input.processingToken,
					processingLeasedUntil: { gt: now },
				},
				data: {
					status: "PROCESSED",
					processedAt: now,
					processingToken: null,
					processingLeasedUntil: null,
				},
			});
			if (completed.count !== 1) throw new PaymentEventFenceError();
			return processed;
		});
		return { outcome: "PROCESSED", grantsCreated };
	} catch (error) {
		if (error instanceof PaymentEventFenceError) {
			return { outcome: "SKIPPED", grantsCreated: 0 };
		}
		const reason = error instanceof Error ? error.message : "PAYMENT_EVENT_FAILED";
		await failPaymentEvent(input.paymentEventId, input.processingToken, reason, client);
		logger.error({ paymentEventId: input.paymentEventId, reason }, "Stripe payment event failed");
		return { outcome: "FAILED", grantsCreated: 0 };
	}
}

async function processEnvelope(
	envelope: StripeEnvelope,
	client: TransactionClient,
): Promise<number> {
	switch (envelope.type) {
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted":
			await synchronizeSubscription(envelope, client);
			return 0;
		case "invoice.paid":
			return processPaidInvoice(envelope, client);
		case "invoice.payment_failed":
			await synchronizeInvoiceFailure(envelope, client);
			return 0;
		case "refund.created":
		case "charge.refund.updated":
			await processRefund(envelope, client);
			return 0;
		default:
			return 0;
	}
}

async function processPaidInvoice(
	envelope: StripeEnvelope,
	client: TransactionClient,
): Promise<number> {
	const invoice = envelope.data.object;
	const providerSubscriptionId = stringId(invoice.subscription);
	const invoiceId = requiredString(invoice.id, "invoice.id");
	const subscription = await exactlyOneSubscription(providerSubscriptionId, client);
	const invoicePriceId =
		priceIdFromInvoice(invoice) ??
		(subscription.scheduledPlanId ? undefined : subscription.plan.providerPriceId);
	const invoicePlan = invoicePriceId
		? await client.billingPlan.findUnique({
				where: {
					provider_providerPriceId: { provider: "stripe", providerPriceId: invoicePriceId },
				},
			})
		: null;
	if (!invoicePlan?.active) throw new Error("STRIPE_INVOICE_PLAN_UNMAPPED");
	if (subscription.scheduledPlanId && subscription.scheduledPlanId !== invoicePlan.id) {
		throw new Error("STRIPE_SCHEDULED_PLAN_MISMATCH");
	}
	if (!subscription.scheduledPlanId && invoicePlan.id !== subscription.planId) {
		throw new Error("STRIPE_UNSCHEDULED_PLAN_CHANGE");
	}
	if (subscription.scheduledPlanId) {
		await client.subscription.update({
			where: { id: subscription.id },
			data: { planId: invoicePlan.id, scheduledPlanId: null },
		});
	}
	const interval = jsonString(invoicePlan.metadata, "interval") ?? "month";
	const startsAt = unixDate(invoice.period_start, "invoice.period_start");
	const invoiceEnd = unixDate(invoice.period_end, "invoice.period_end");
	const chargeId = stringId(invoice.charge);
	const paidAmount = integerBigInt(invoice.amount_paid, "invoice.amount_paid");
	const periods =
		interval === "year"
			? createAnnualBillingPeriods({
					startsAt,
					creditsPerPeriod: invoicePlan.creditsPerPeriod,
				})
			: [
					{
						startsAt,
						endsAt: invoiceEnd,
						creditAmount: invoicePlan.creditsPerPeriod,
					},
				];

	let firstPeriodId: string | null = null;
	for (const [index, period] of periods.entries()) {
		const grantReferenceKey = `stripe-invoice:${invoiceId}:period:${index}:grant`;
		const created = await client.billingPeriod.upsert({
			where: {
				subscriptionId_startsAt: { subscriptionId: subscription.id, startsAt: period.startsAt },
			},
			create: {
				subscriptionId: subscription.id,
				startsAt: period.startsAt,
				endsAt: period.endsAt,
				status: index === 0 ? "ACTIVE" : "PENDING",
				creditAmount: period.creditAmount,
				grantReferenceKey,
				providerInvoiceId: invoiceId,
				providerChargeId: chargeId,
				paidAmount,
			},
			update: {},
		});
		firstPeriodId ??= created.id;
	}

	const firstPeriod = await client.billingPeriod.findUniqueOrThrow({
		where: { id: firstPeriodId! },
	});
	const account = await ensureCreditAccount(subscription.ownerType, subscription.ownerId, client);
	const existingGrant = await client.creditLedgerEntry.findUnique({
		where: { referenceKey: firstPeriod.grantReferenceKey! },
	});
	await createCreditGrant(
		{
			accountId: account.id,
			amount: firstPeriod.creditAmount,
			referenceKey: firstPeriod.grantReferenceKey!,
			expiresAt: firstPeriod.endsAt,
			metadata: { providerInvoiceId: invoiceId, billingPeriodId: firstPeriod.id },
		},
		client,
	);
	return existingGrant ? 0 : 1;
}

async function processRefund(envelope: StripeEnvelope, client: TransactionClient): Promise<void> {
	const refund = envelope.data.object;
	const refundId = requiredString(refund.id, "refund.id");
	const chargeId = stringId(refund.charge) ?? requiredString(refund.id, "charge.id");
	const requestedAmount = integerBigInt(refund.amount ?? refund.amount_refunded, "refund.amount");
	const rows = await client.$queryRaw<Array<{ id: string }>>`
			SELECT "id" FROM "billing_period"
			WHERE "providerChargeId" = ${chargeId}
			ORDER BY "startsAt" ASC FOR UPDATE`;
	if (rows.length === 0) throw new Error("STRIPE_REFUND_BINDING_AMBIGUOUS");
	const periods = await client.billingPeriod.findMany({
		where: { id: { in: rows.map((row) => row.id) } },
		include: { subscription: true },
		orderBy: { startsAt: "asc" },
	});
	const invoicePaidAmount = periods[0]!.paidAmount;
	const creditsTotal = periods.reduce((sum, period) => sum + period.creditAmount, 0n);
	const creditsAlreadyRefunded = periods.reduce((sum, period) => sum + period.refundedCredits, 0n);
	const providerAmountAlreadyRefunded = periods.reduce(
		(sum, period) => sum + period.refundedAmount,
		0n,
	);
	const remainingPaid = invoicePaidAmount - providerAmountAlreadyRefunded;
	const appliedAmount = requestedAmount < remainingPaid ? requestedAmount : remainingPaid;
	if (appliedAmount <= 0n) return;
	const cumulativeRefundedCredits = calculateProportionalCreditRefund({
		invoicePaidAmount,
		invoiceCredits: creditsTotal,
		refundAmount: providerAmountAlreadyRefunded + appliedAmount,
		creditsAlreadyRefunded: 0n,
	});
	let credits = cumulativeRefundedCredits - creditsAlreadyRefunded;
	if (credits < 0n) credits = 0n;
	const account = await ensureCreditAccount(
		periods[0]!.subscription.ownerType,
		periods[0]!.subscription.ownerId,
		client,
	);
	for (const period of periods) {
		if (credits <= 0n) break;
		const refundable = period.creditAmount - period.refundedCredits;
		const allocated = refundable < credits ? refundable : credits;
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
					referenceKey: `stripe-refund:${refundId}:${period.id}`,
					metadata: { providerRefundId: refundId, providerChargeId: chargeId },
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
		credits -= allocated;
	}
	// The first period is the canonical invoice financial snapshot; update even when no credits remain.
	await client.billingPeriod.update({
		where: { id: periods[0]!.id },
		data: { refundedAmount: { increment: appliedAmount } },
	});
}

async function synchronizeSubscription(
	envelope: StripeEnvelope,
	client: TransactionClient,
): Promise<void> {
	const object = envelope.data.object;
	const providerSubscriptionId = requiredString(object.id, "subscription.id");
	const eventAt = new Date(envelope.created * 1_000);
	const existing = await client.subscription.findUnique({
		where: { providerSubscriptionId },
		include: { purchase: true },
	});
	if (!existing) {
		if (envelope.type !== "customer.subscription.created") {
			throw new Error("STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS");
		}
		await createBoundSubscription(envelope, client);
		return;
	}
	const rawStatus = stringValue(object.status) ?? "canceled";
	const currentStatus = stripeStatus(rawStatus);
	if (
		!shouldApplySubscriptionEvent({
			currentStatus: existing.status,
			lastEventCreatedAt: existing.lastProviderEventAt,
			lastEventId: existing.lastProviderEventId,
			incomingStatus: currentStatus,
			incomingEventCreatedAt: eventAt,
			incomingEventId: envelope.id,
		})
	)
		return;
	const priceId = priceIdFromSubscription(object);
	const newPlan = priceId
		? await client.billingPlan.findUnique({
				where: { provider_providerPriceId: { provider: "stripe", providerPriceId: priceId } },
			})
		: null;
	const isDeleted = envelope.type === "customer.subscription.deleted";
	const currentPeriodStart = optionalUnixDate(object.current_period_start);
	const currentPeriodEnd = optionalUnixDate(object.current_period_end);
	const graceEndsAt =
		currentStatus === "PAST_DUE"
			? (optionalUnixDate(object.grace_ends_at) ?? currentPeriodEnd)
			: null;
	await client.subscription.update({
		where: { id: existing.id },
		data: {
			status: isDeleted ? "CANCELED" : currentStatus,
			cancelAtPeriodEnd: Boolean(object.cancel_at_period_end) || isDeleted,
			lastProviderEventAt: eventAt,
			lastProviderEventId: envelope.id,
			currentPeriodStart,
			currentPeriodEnd,
			graceEndsAt,
			...(newPlan ? { scheduledPlanId: newPlan.id === existing.planId ? null : newPlan.id } : {}),
		},
	});
	if (existing.purchaseId) {
		await client.purchase.update({
			where: { id: existing.purchaseId },
			data: { status: isDeleted ? "canceled" : rawStatus },
		});
	}
}

async function createBoundSubscription(
	envelope: StripeEnvelope,
	client: TransactionClient,
): Promise<void> {
	const object = envelope.data.object;
	const metadata = recordValue(object.metadata);
	const billingPlanId = requiredString(metadata.billing_plan_id, "metadata.billing_plan_id");
	const planKey = requiredString(metadata.plan_key, "metadata.plan_key");
	const ownerType = requiredString(metadata.owner_type, "metadata.owner_type");
	const ownerId = requiredString(metadata.owner_id, "metadata.owner_id");
	const submittedByUserId = requiredString(
		metadata.submitted_by_user_id,
		"metadata.submitted_by_user_id",
	);
	if (ownerType !== "USER" && ownerType !== "ORGANIZATION") {
		throw new Error("STRIPE_OWNER_TYPE_INVALID");
	}
	const priceId = requiredString(priceIdFromSubscription(object), "subscription.price_id");
	const plan = await client.billingPlan.findUnique({ where: { id: billingPlanId } });
	if (
		!plan?.active ||
		plan.provider !== "stripe" ||
		plan.providerPriceId !== priceId ||
		jsonString(plan.metadata, "planId") !== planKey
	) {
		throw new Error("STRIPE_BILLING_PLAN_BINDING_INVALID");
	}
	const providerSubscriptionId = requiredString(object.id, "subscription.id");
	const customerId = requiredString(object.customer, "subscription.customer");
	await client.$queryRaw<Array<{ locked: string }>>`
		SELECT pg_advisory_xact_lock(hashtextextended(${providerSubscriptionId}, 0))::text AS "locked"`;
	const racedSubscription = await client.subscription.findUnique({
		where: { providerSubscriptionId },
	});
	if (racedSubscription) return;
	const existingPurchase = await client.purchase.findUnique({
		where: { subscriptionId: providerSubscriptionId },
	});
	if (
		existingPurchase &&
		(existingPurchase.customerId !== customerId ||
			existingPurchase.priceId !== priceId ||
			(ownerType === "USER" &&
				existingPurchase.userId !== null &&
				existingPurchase.userId !== ownerId) ||
			(ownerType === "ORGANIZATION" &&
				existingPurchase.organizationId !== null &&
				existingPurchase.organizationId !== ownerId))
	) {
		throw new Error("STRIPE_PURCHASE_BINDING_INVALID");
	}
	const purchase = existingPurchase
		? await client.purchase.update({
				where: { id: existingPurchase.id },
				data: {
					organizationId: ownerType === "ORGANIZATION" ? ownerId : null,
					userId: ownerType === "USER" ? ownerId : null,
					status: stringValue(object.status) ?? "incomplete",
				},
			})
		: await client.purchase.create({
				data: {
					organizationId: ownerType === "ORGANIZATION" ? ownerId : null,
					userId: ownerType === "USER" ? ownerId : null,
					type: "SUBSCRIPTION",
					customerId,
					subscriptionId: providerSubscriptionId,
					priceId,
					status: stringValue(object.status) ?? "incomplete",
				},
			});
	await client.subscription.create({
		data: {
			ownerType,
			ownerId,
			provider: "stripe",
			providerSubscriptionId,
			planId: plan.id,
			purchaseId: purchase.id,
			status: stripeStatus(stringValue(object.status) ?? "incomplete"),
			cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
			lastProviderEventAt: new Date(envelope.created * 1_000),
			lastProviderEventId: envelope.id,
			currentPeriodStart: optionalUnixDate(object.current_period_start),
			currentPeriodEnd: optionalUnixDate(object.current_period_end),
			graceEndsAt:
				stripeStatus(stringValue(object.status) ?? "incomplete") === "PAST_DUE"
					? (optionalUnixDate(object.grace_ends_at) ?? optionalUnixDate(object.current_period_end))
					: null,
		},
	});
	if (ownerType === "USER") {
		await client.user.updateMany({
			where: { id: ownerId },
			data: { paymentsCustomerId: customerId },
		});
	} else {
		await client.organization.updateMany({
			where: { id: ownerId },
			data: { paymentsCustomerId: customerId },
		});
	}
	await client.auditLog.create({
		data: {
			actorUserId: submittedByUserId,
			action: "STRIPE_SUBSCRIPTION_BOUND",
			targetType: "SUBSCRIPTION",
			targetId: providerSubscriptionId,
			metadata: { billingPlanId, planKey, ownerType, ownerId },
		},
	});
}

async function synchronizeInvoiceFailure(
	envelope: StripeEnvelope,
	client: TransactionClient,
): Promise<void> {
	const providerSubscriptionId = stringId(envelope.data.object.subscription);
	const subscription = await exactlyOneSubscription(providerSubscriptionId, client);
	const eventAt = new Date(envelope.created * 1_000);
	if (
		!shouldApplySubscriptionEvent({
			currentStatus: subscription.status,
			lastEventCreatedAt: subscription.lastProviderEventAt,
			lastEventId: subscription.lastProviderEventId,
			incomingStatus: "PAST_DUE",
			incomingEventCreatedAt: eventAt,
			incomingEventId: envelope.id,
		})
	)
		return;
	await client.subscription.update({
		where: { id: subscription.id },
		data: {
			status: "PAST_DUE",
			lastProviderEventAt: eventAt,
			lastProviderEventId: envelope.id,
			graceEndsAt:
				optionalUnixDate(envelope.data.object.grace_ends_at) ?? subscription.currentPeriodEnd,
		},
	});
}

export async function grantDueBillingPeriods(
	input: { now?: Date; limit?: number },
	client: TransactionClient,
): Promise<{ granted: number }> {
	const now = input.now ?? new Date();
	const periods = await client.billingPeriod.findMany({
		where: {
			status: "PENDING",
			startsAt: { lte: now },
			subscription: { status: "ACTIVE" },
		},
		include: { subscription: true },
		orderBy: { startsAt: "asc" },
		take: input.limit ?? 100,
	});
	let granted = 0;
	for (const period of periods) {
		if (!period.grantReferenceKey || period.endsAt <= now) continue;
		const account = await ensureCreditAccount(
			period.subscription.ownerType,
			period.subscription.ownerId,
			client,
		);
		const existing = await client.creditLedgerEntry.findUnique({
			where: { referenceKey: period.grantReferenceKey },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: period.creditAmount,
				referenceKey: period.grantReferenceKey,
				expiresAt: period.endsAt,
				metadata: { billingPeriodId: period.id, providerInvoiceId: period.providerInvoiceId },
			},
			client,
		);
		await client.billingPeriod.update({ where: { id: period.id }, data: { status: "ACTIVE" } });
		if (!existing) granted += 1;
	}
	return { granted };
}

async function exactlyOneSubscription(
	providerSubscriptionId: string | undefined,
	client: TransactionClient,
) {
	if (!providerSubscriptionId) throw new Error("STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS");
	const matches = await client.subscription.findMany({
		where: { provider: "stripe", providerSubscriptionId },
		include: { plan: true },
		take: 2,
	});
	if (matches.length !== 1) {
		await client.auditLog.create({
			data: {
				action: "PAYMENT_BINDING_DIAGNOSTIC",
				targetType: "STRIPE_SUBSCRIPTION",
				targetId: providerSubscriptionId,
				metadata: { matchCount: matches.length, replayable: true, pageAdmin: true },
			},
		});
		throw new Error("STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS");
	}
	return matches[0];
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

function parseEnvelope(value: Prisma.JsonValue): StripeEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("STRIPE_EVENT_INVALID");
	}
	return value as unknown as StripeEnvelope;
}

function requiredString(value: unknown, name: string): string {
	const id = stringId(value);
	if (!id) throw new Error(`STRIPE_EVENT_MISSING_${name.toUpperCase().replace(/\./g, "_")}`);
	return id;
}

function stringId(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
		return value.id;
	}
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function integerBigInt(value: unknown, name: string): bigint {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`STRIPE_EVENT_INVALID_${name.toUpperCase().replace(/\./g, "_")}`);
	}
	return BigInt(value);
}

function unixDate(value: unknown, name: string): Date {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new Error(`STRIPE_EVENT_INVALID_${name.toUpperCase().replace(/\./g, "_")}`);
	}
	return new Date(value * 1_000);
}

function optionalUnixDate(value: unknown): Date | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? new Date(value * 1_000) : null;
}

function jsonString(value: Prisma.JsonValue, key: string): string | undefined {
	return value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof value[key] === "string"
		? value[key]
		: undefined;
}

function priceIdFromSubscription(object: Record<string, unknown>): string | undefined {
	const items = object.items;
	if (!items || typeof items !== "object" || !("data" in items) || !Array.isArray(items.data)) {
		return undefined;
	}
	const first = items.data[0];
	return first && typeof first === "object" && "price" in first ? stringId(first.price) : undefined;
}

function priceIdFromInvoice(object: Record<string, unknown>): string | undefined {
	const lines = object.lines;
	if (!lines || typeof lines !== "object" || !("data" in lines) || !Array.isArray(lines.data)) {
		return undefined;
	}
	const first = lines.data[0];
	return first && typeof first === "object" && "price" in first ? stringId(first.price) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function stripeStatus(status: string) {
	if (status === "active" || status === "trialing") return "ACTIVE" as const;
	if (status === "past_due") return "PAST_DUE" as const;
	if (status === "canceled") return "CANCELED" as const;
	if (status === "unpaid" || status === "incomplete_expired") return "EXPIRED" as const;
	return "PENDING" as const;
}
