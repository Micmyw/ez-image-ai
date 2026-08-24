import type Stripe from "stripe";

export type StripeRefundStatus =
	| "PENDING"
	| "REQUIRES_ACTION"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELED";

export interface StripeFactContext {
	origin: "WEBHOOK" | "RECONCILIATION";
	changeAt: Date;
	changeId: string;
}

export interface StripeSubscriptionBinding {
	billingPlanId: string;
	planKey: string;
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	submittedByUserId: string;
}

export interface StripeSubscriptionFact {
	kind: "SUBSCRIPTION";
	providerSubscriptionId: string;
	customerId: string;
	status: "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
	cancelAtPeriodEnd: boolean;
	currentPeriodStart: Date;
	currentPeriodEnd: Date;
	priceId: string;
	binding: StripeSubscriptionBinding | null;
	context: StripeFactContext;
}

export interface StripeInvoicePaymentFact {
	providerInvoicePaymentId: string;
	providerChargeId: string;
	providerPaymentIntentId: string | null;
	amountPaid: bigint;
}

export interface StripePaidInvoiceFact {
	kind: "PAID_INVOICE";
	billingReason: "SUBSCRIPTION_CREATE" | "SUBSCRIPTION_CYCLE";
	providerInvoiceId: string;
	providerSubscriptionId: string;
	customerId: string;
	providerInvoicePaymentId: string;
	providerChargeId: string;
	providerPaymentIntentId: string | null;
	priceId: string;
	amountPaid: bigint;
	currency: string;
	periodStart: Date;
	periodEnd: Date;
	context: StripeFactContext;
}

export interface StripeInvoicePaymentFailedFact {
	kind: "INVOICE_PAYMENT_FAILED";
	providerInvoiceId: string;
	providerSubscriptionId: string;
	customerId: string;
	context: StripeFactContext;
}

export interface StripeRefundFact {
	kind: "REFUND";
	providerRefundId: string;
	providerChargeId: string;
	providerPaymentIntentId: string | null;
	amount: bigint;
	currency: string;
	status: StripeRefundStatus;
	providerCreatedAt: Date;
	context: StripeFactContext;
}

export type StripeBillingFact =
	| StripeSubscriptionFact
	| StripePaidInvoiceFact
	| StripeInvoicePaymentFailedFact
	| StripeRefundFact;

export function normalizeStripeSubscription(
	subscription: Stripe.Subscription,
	context: StripeFactContext,
): StripeSubscriptionFact {
	const items = subscription.items.data.filter((item) => !item.deleted);
	if (items.length !== 1) throw new Error("STRIPE_SUBSCRIPTION_ITEM_AMBIGUOUS");
	const item = items[0]!;
	const customerId = objectId(subscription.customer);
	if (!customerId) throw new Error("STRIPE_EVENT_MISSING_SUBSCRIPTION_CUSTOMER");
	if (!item.price?.id) throw new Error("STRIPE_EVENT_MISSING_SUBSCRIPTION_PRICE_ID");

	return {
		kind: "SUBSCRIPTION",
		providerSubscriptionId: requiredId(subscription.id, "subscription.id"),
		customerId,
		status: normalizeSubscriptionStatus(subscription.status),
		cancelAtPeriodEnd: subscription.cancel_at_period_end,
		currentPeriodStart: unixDate(
			item.current_period_start,
			"subscription_item.current_period_start",
		),
		currentPeriodEnd: unixDate(item.current_period_end, "subscription_item.current_period_end"),
		priceId: item.price.id,
		binding: normalizeSubscriptionBinding(subscription.metadata),
		context,
	};
}

export function normalizeStripeInvoicePayment(
	payment: Stripe.InvoicePayment,
): StripeInvoicePaymentFact {
	if (payment.status !== "paid" || payment.amount_paid === null) {
		throw new Error("STRIPE_INVOICE_PAYMENT_NOT_PAID");
	}
	const amountPaid = nonnegativeBigInt(payment.amount_paid, "invoice_payment.amount_paid");
	let providerChargeId: string | undefined;
	let providerPaymentIntentId: string | null = null;

	if (payment.payment.type === "charge") {
		providerChargeId = objectId(payment.payment.charge);
	} else if (payment.payment.type === "payment_intent") {
		providerPaymentIntentId = objectId(payment.payment.payment_intent) ?? null;
		const paymentIntent = payment.payment.payment_intent;
		if (paymentIntent && typeof paymentIntent === "object") {
			providerChargeId = objectId(paymentIntent.latest_charge);
		}
	} else {
		throw new Error("STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED");
	}
	if (!providerChargeId) throw new Error("STRIPE_INVOICE_PAYMENT_CHARGE_MISSING");

	return {
		providerInvoicePaymentId: requiredId(payment.id, "invoice_payment.id"),
		providerChargeId,
		providerPaymentIntentId,
		amountPaid,
	};
}

export function normalizeStripeInvoice(
	invoice: Stripe.Invoice,
	payments: readonly StripeInvoicePaymentFact[],
	context: StripeFactContext,
): StripePaidInvoiceFact {
	const providerSubscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
	if (!providerSubscriptionId) throw new Error("STRIPE_SUBSCRIPTION_ID_MISSING");
	const customerId = objectId(invoice.customer);
	if (!customerId) throw new Error("STRIPE_INVOICE_CUSTOMER_MISSING");
	if (invoice.lines.has_more) throw new Error("STRIPE_INVOICE_LINES_INCOMPLETE");
	const billingReason = normalizeInvoiceBillingReason(invoice.billing_reason);
	if (
		invoice.lines.data.some((line) => line.parent?.subscription_item_details?.proration === true)
	) {
		throw new Error("STRIPE_INVOICE_PRORATION_UNSUPPORTED");
	}
	if (invoice.lines.data.length !== 1) {
		throw new Error("STRIPE_INVOICE_SUBSCRIPTION_LINE_AMBIGUOUS");
	}
	const line = invoice.lines.data[0]!;
	const subscriptionDetails = line.parent?.subscription_item_details;
	if (line.parent?.type !== "subscription_item_details" || !subscriptionDetails) {
		throw new Error("STRIPE_INVOICE_SUBSCRIPTION_LINE_INVALID");
	}
	if (subscriptionDetails.proration !== false || !subscriptionDetails.subscription_item) {
		throw new Error("STRIPE_INVOICE_SUBSCRIPTION_LINE_INVALID");
	}
	if (objectId(subscriptionDetails.subscription) !== providerSubscriptionId) {
		throw new Error("STRIPE_INVOICE_SUBSCRIPTION_MISMATCH");
	}
	const priceId = objectId(line.pricing?.price_details?.price);
	if (!priceId) throw new Error("STRIPE_INVOICE_PLAN_AMBIGUOUS");
	const periodStart = unixDate(line.period?.start, "invoice_line.period_start");
	const periodEnd = unixDate(line.period?.end, "invoice_line.period_end");
	if (periodEnd.getTime() <= periodStart.getTime()) {
		throw new Error("STRIPE_INVOICE_SUBSCRIPTION_LINE_INVALID");
	}
	if (payments.length !== 1) throw new Error("STRIPE_INVOICE_PAYMENT_AMBIGUOUS");
	const payment = payments[0]!;
	const amountPaid = nonnegativeBigInt(invoice.amount_paid, "invoice.amount_paid");
	if (payment.amountPaid !== amountPaid) throw new Error("STRIPE_INVOICE_PAYMENT_AMOUNT_MISMATCH");

	return {
		kind: "PAID_INVOICE",
		billingReason,
		providerInvoiceId: requiredId(invoice.id, "invoice.id"),
		providerSubscriptionId,
		customerId,
		providerInvoicePaymentId: payment.providerInvoicePaymentId,
		providerChargeId: payment.providerChargeId,
		providerPaymentIntentId: payment.providerPaymentIntentId,
		priceId,
		amountPaid,
		currency: normalizeCurrency(invoice.currency),
		periodStart,
		periodEnd,
		context,
	};
}

function normalizeInvoiceBillingReason(
	reason: Stripe.Invoice.BillingReason | null,
): StripePaidInvoiceFact["billingReason"] {
	if (reason === "subscription_create") return "SUBSCRIPTION_CREATE";
	if (reason === "subscription_cycle") return "SUBSCRIPTION_CYCLE";
	throw new Error("STRIPE_INVOICE_BILLING_REASON_UNSUPPORTED");
}

export function normalizeStripeInvoicePaymentFailed(
	invoice: Stripe.Invoice,
	context: StripeFactContext,
): StripeInvoicePaymentFailedFact {
	const providerSubscriptionId = objectId(invoice.parent?.subscription_details?.subscription);
	if (!providerSubscriptionId) throw new Error("STRIPE_SUBSCRIPTION_ID_MISSING");
	const customerId = objectId(invoice.customer);
	if (!customerId) throw new Error("STRIPE_INVOICE_CUSTOMER_MISSING");
	return {
		kind: "INVOICE_PAYMENT_FAILED",
		providerInvoiceId: requiredId(invoice.id, "invoice.id"),
		providerSubscriptionId,
		customerId,
		context,
	};
}

export function normalizeStripeRefund(
	refund: Stripe.Refund,
	context: StripeFactContext,
): StripeRefundFact {
	const providerChargeId = objectId(refund.charge);
	if (!providerChargeId) throw new Error("STRIPE_REFUND_CHARGE_MISSING");
	return {
		kind: "REFUND",
		providerRefundId: requiredId(refund.id, "refund.id"),
		providerChargeId,
		providerPaymentIntentId: objectId(refund.payment_intent) ?? null,
		amount: nonnegativeBigInt(refund.amount, "refund.amount"),
		currency: normalizeCurrency(refund.currency),
		status: normalizeRefundStatus(refund.status),
		providerCreatedAt: unixDate(refund.created, "refund.created"),
		context,
	};
}

function normalizeSubscriptionBinding(metadata: Stripe.Metadata): StripeSubscriptionBinding | null {
	const billingPlanId = nonemptyString(metadata.billing_plan_id);
	const planKey = nonemptyString(metadata.plan_key);
	const ownerType = nonemptyString(metadata.owner_type);
	const ownerId = nonemptyString(metadata.owner_id);
	const submittedByUserId = nonemptyString(metadata.submitted_by_user_id);
	if (
		!billingPlanId ||
		!planKey ||
		(ownerType !== "USER" && ownerType !== "ORGANIZATION") ||
		!ownerId ||
		!submittedByUserId
	) {
		return null;
	}
	return { billingPlanId, planKey, ownerType, ownerId, submittedByUserId };
}

function normalizeSubscriptionStatus(status: Stripe.Subscription.Status) {
	if (status === "active" || status === "trialing") return "ACTIVE" as const;
	if (status === "past_due") return "PAST_DUE" as const;
	if (status === "canceled") return "CANCELED" as const;
	if (status === "unpaid" || status === "incomplete_expired") return "EXPIRED" as const;
	return "PENDING" as const;
}

function normalizeRefundStatus(status: string | null): StripeRefundStatus {
	switch (status) {
		case "pending":
			return "PENDING";
		case "requires_action":
			return "REQUIRES_ACTION";
		case "succeeded":
			return "SUCCEEDED";
		case "failed":
			return "FAILED";
		case "canceled":
			return "CANCELED";
		default:
			throw new Error("STRIPE_REFUND_STATUS_UNSUPPORTED");
	}
}

function objectId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
		return value.id || undefined;
	}
	return undefined;
}

function requiredId(value: unknown, field: string): string {
	const id = objectId(value);
	if (!id) throw new Error(`STRIPE_EVENT_MISSING_${field.toUpperCase().replace(/\./g, "_")}`);
	return id;
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonnegativeBigInt(value: number, field: string): bigint {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`STRIPE_EVENT_INVALID_${field.toUpperCase().replace(/\./g, "_")}`);
	}
	return BigInt(value);
}

function unixDate(value: unknown, field: string): Date {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`STRIPE_EVENT_INVALID_${field.toUpperCase().replace(/\./g, "_")}`);
	}
	return new Date(value * 1_000);
}

function normalizeCurrency(currency: string): string {
	if (!/^[a-zA-Z]{3}$/.test(currency)) throw new Error("STRIPE_EVENT_INVALID_CURRENCY");
	return currency.toUpperCase();
}
