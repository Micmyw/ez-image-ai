import type { PaymentProviderName } from "../types";

export interface ProviderPaymentFact {
	providerPaymentId: string;
	amountMicros: bigint;
	currency: string;
	periodStart: Date;
	periodEnd: Date;
}

export interface ProviderBillingFact {
	provider: "paypal" | "waffo";
	providerEventId: string;
	providerSubscriptionId: string;
	checkoutIntentId: string | null;
	providerCustomerId: string | null;
	status: "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
	cancelAtPeriodEnd: boolean;
	occurredAt: Date;
	payment: ProviderPaymentFact | null;
}

export function normalizeProviderBillingEvent(
	provider: Extract<PaymentProviderName, "paypal" | "waffo">,
	value: unknown,
): ProviderBillingFact {
	return provider === "paypal" ? normalizePayPalEvent(value) : normalizeWaffoEvent(value);
}

function normalizeWaffoEvent(value: unknown): ProviderBillingFact {
	const envelope = requiredRecord(value, "WAFFO_EVENT_INVALID");
	const eventType = requiredString(envelope.eventType, "WAFFO_EVENT_TYPE_MISSING");
	if (eventType.startsWith("refund.")) {
		throw new Error("PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED");
	}
	const status = waffoStatus(eventType);
	const data = requiredRecord(envelope.data, "WAFFO_EVENT_DATA_MISSING");
	const providerEventId = requiredString(envelope.id, "WAFFO_EVENT_ID_MISSING");
	const providerSubscriptionId = requiredString(data.orderId, "WAFFO_SUBSCRIPTION_ID_MISSING");
	const occurredAt = requiredDate(envelope.timestamp, "WAFFO_EVENT_TIME_INVALID");
	const payment =
		eventType === "subscription.activated" || eventType === "subscription.payment_succeeded"
			? normalizeWaffoPayment(data)
			: null;
	return {
		provider: "waffo",
		providerEventId,
		providerSubscriptionId,
		checkoutIntentId: optionalString(data.orderMerchantExternalId),
		providerCustomerId: optionalString(data.merchantProvidedBuyerIdentity),
		status,
		cancelAtPeriodEnd: eventType === "subscription.canceling" || status === "CANCELED",
		occurredAt,
		payment,
	};
}

function normalizeWaffoPayment(data: Record<string, unknown>): ProviderPaymentFact {
	return {
		providerPaymentId: requiredString(data.paymentId, "WAFFO_PAYMENT_ID_MISSING"),
		amountMicros: decimalMicros(data.amount, "WAFFO_PAYMENT_AMOUNT_INVALID"),
		currency: currency(data.currency, "WAFFO_PAYMENT_CURRENCY_INVALID"),
		periodStart: requiredDate(data.currentPeriodStart, "WAFFO_PAYMENT_PERIOD_INVALID"),
		periodEnd: requiredPeriodEnd(
			data.currentPeriodStart,
			data.currentPeriodEnd,
			"WAFFO_PAYMENT_PERIOD_INVALID",
		),
	};
}

function waffoStatus(eventType: string): ProviderBillingFact["status"] {
	switch (eventType) {
		case "subscription.activated":
		case "subscription.payment_succeeded":
		case "subscription.uncanceled":
		case "subscription.canceling":
			return "ACTIVE";
		case "subscription.past_due":
			return "PAST_DUE";
		case "subscription.canceled":
			return "CANCELED";
		default:
			throw new Error("PAYMENT_PROVIDER_EVENT_UNSUPPORTED");
	}
}

function normalizePayPalEvent(value: unknown): ProviderBillingFact {
	const envelope = requiredRecord(value, "PAYPAL_EVENT_INVALID");
	const eventType = requiredString(envelope.event_type, "PAYPAL_EVENT_TYPE_MISSING");
	if (eventType.includes("REFUND") || eventType.includes("REVERSED")) {
		throw new Error("PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED");
	}
	const status = paypalStatus(eventType);
	const resource = requiredRecord(envelope.resource, "PAYPAL_EVENT_RESOURCE_MISSING");
	const subscriptionId =
		eventType === "PAYMENT.SALE.COMPLETED"
			? requiredString(resource.billing_agreement_id, "PAYPAL_SUBSCRIPTION_ID_MISSING")
			: requiredString(resource.id, "PAYPAL_SUBSCRIPTION_ID_MISSING");
	const subscriber = optionalRecord(resource.subscriber);
	return {
		provider: "paypal",
		providerEventId: requiredString(envelope.id, "PAYPAL_EVENT_ID_MISSING"),
		providerSubscriptionId: subscriptionId,
		checkoutIntentId: optionalString(resource.custom_id),
		providerCustomerId: optionalString(subscriber?.payer_id),
		status,
		cancelAtPeriodEnd: eventType === "BILLING.SUBSCRIPTION.CANCELLED" || status === "CANCELED",
		occurredAt: requiredDate(envelope.create_time, "PAYPAL_EVENT_TIME_INVALID"),
		payment:
			eventType === "PAYMENT.SALE.COMPLETED"
				? normalizePayPalSale(resource)
				: eventType === "BILLING.SUBSCRIPTION.ACTIVATED"
					? normalizePayPalActivationPayment(resource)
					: null,
	};
}

function paypalStatus(eventType: string): ProviderBillingFact["status"] {
	switch (eventType) {
		case "BILLING.SUBSCRIPTION.ACTIVATED":
		case "PAYMENT.SALE.COMPLETED":
			return "ACTIVE";
		case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
		case "BILLING.SUBSCRIPTION.SUSPENDED":
			return "PAST_DUE";
		case "BILLING.SUBSCRIPTION.CANCELLED":
			return "CANCELED";
		case "BILLING.SUBSCRIPTION.EXPIRED":
			return "EXPIRED";
		default:
			throw new Error("PAYMENT_PROVIDER_EVENT_UNSUPPORTED");
	}
}

function normalizePayPalSale(resource: Record<string, unknown>): ProviderPaymentFact {
	const amount = requiredRecord(resource.amount, "PAYPAL_PAYMENT_AMOUNT_INVALID");
	const billingPeriod = requiredRecord(resource.billing_period, "PAYPAL_PAYMENT_PERIOD_INVALID");
	return {
		providerPaymentId: requiredString(resource.id, "PAYPAL_PAYMENT_ID_MISSING"),
		amountMicros: decimalMicros(amount.total, "PAYPAL_PAYMENT_AMOUNT_INVALID"),
		currency: currency(amount.currency, "PAYPAL_PAYMENT_CURRENCY_INVALID"),
		periodStart: requiredDate(billingPeriod.start_time, "PAYPAL_PAYMENT_PERIOD_INVALID"),
		periodEnd: requiredPeriodEnd(
			billingPeriod.start_time,
			billingPeriod.end_time,
			"PAYPAL_PAYMENT_PERIOD_INVALID",
		),
	};
}

function normalizePayPalActivationPayment(
	resource: Record<string, unknown>,
): ProviderPaymentFact | null {
	const billingInfo = optionalRecord(resource.billing_info);
	const lastPayment = optionalRecord(billingInfo?.last_payment);
	const amount = optionalRecord(lastPayment?.amount);
	if (!lastPayment || !amount || !optionalString(lastPayment.id)) return null;
	return {
		providerPaymentId: requiredString(lastPayment.id, "PAYPAL_PAYMENT_ID_MISSING"),
		amountMicros: decimalMicros(amount.value, "PAYPAL_PAYMENT_AMOUNT_INVALID"),
		currency: currency(amount.currency_code, "PAYPAL_PAYMENT_CURRENCY_INVALID"),
		periodStart: requiredDate(lastPayment.time, "PAYPAL_PAYMENT_PERIOD_INVALID"),
		periodEnd: requiredPeriodEnd(
			lastPayment.time,
			billingInfo?.next_billing_time,
			"PAYPAL_PAYMENT_PERIOD_INVALID",
		),
	};
}

function decimalMicros(value: unknown, code: string): bigint {
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
		throw new Error(code);
	}
	const [whole, fraction = ""] = value.split(".");
	return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function currency(value: unknown, code: string): string {
	const result = requiredString(value, code).toUpperCase();
	if (!/^[A-Z]{3}$/.test(result)) throw new Error(code);
	return result;
}

function requiredPeriodEnd(start: unknown, end: unknown, code: string): Date {
	const startDate = requiredDate(start, code);
	const endDate = requiredDate(end, code);
	if (endDate <= startDate) throw new Error(code);
	return endDate;
}

function requiredDate(value: unknown, code: string): Date {
	if (typeof value !== "string") throw new Error(code);
	const result = new Date(value);
	if (Number.isNaN(result.getTime())) throw new Error(code);
	return result;
}

function requiredString(value: unknown, code: string): string {
	const result = optionalString(value);
	if (!result) throw new Error(code);
	return result;
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
	const result = optionalRecord(value);
	if (!result) throw new Error(code);
	return result;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
