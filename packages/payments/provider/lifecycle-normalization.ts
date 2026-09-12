import type { PaymentProviderName } from "../types";
import { getWaffoEventId } from "./waffo/event-id";

export interface ProviderPaymentFact {
	providerPaymentId: string;
	amountMicros: bigint;
	currency: string;
	periodStart: Date | null;
	periodEnd: Date | null;
}

export interface ProviderBillingPeriodFact {
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
	currentPeriod: ProviderBillingPeriodFact | null;
	payment: ProviderPaymentFact | null;
}

export interface CreditPackPaymentFact {
	provider: "paypal" | "waffo";
	providerEventId: string;
	checkoutIntentId: string | null;
	providerOrderId: string;
	providerPaymentId: string;
	providerCustomerId: string | null;
	amountMicros: bigint;
	currency: string;
	occurredAt: Date;
}

export interface CreditPackRefundFact {
	provider: "paypal";
	providerEventId: string;
	providerRefundId: string;
	providerPaymentId: string;
	amountMicros: bigint;
	currency: string;
	occurredAt: Date;
}

export type NormalizedProviderPaymentEvent =
	| { kind: "SUBSCRIPTION"; fact: ProviderBillingFact }
	| { kind: "CREDIT_PACK_PAID"; fact: CreditPackPaymentFact }
	| { kind: "CREDIT_PACK_REFUNDED"; fact: CreditPackRefundFact };

export function normalizeProviderPaymentEvent(
	provider: Extract<PaymentProviderName, "paypal" | "waffo">,
	value: unknown,
): NormalizedProviderPaymentEvent {
	const envelope = requiredRecord(value, `${provider.toUpperCase()}_EVENT_INVALID`);
	if (provider === "waffo") {
		const eventType = requiredString(envelope.eventType, "WAFFO_EVENT_TYPE_MISSING");
		if (eventType === "order.completed") {
			return { kind: "CREDIT_PACK_PAID", fact: normalizeWaffoCreditPackPayment(envelope) };
		}
		if (eventType.startsWith("refund.")) {
			throw new Error("PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED");
		}
		return { kind: "SUBSCRIPTION", fact: normalizeWaffoEvent(envelope) };
	}

	const eventType = requiredString(envelope.event_type, "PAYPAL_EVENT_TYPE_MISSING");
	if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
		return { kind: "CREDIT_PACK_PAID", fact: normalizePayPalCreditPackPayment(envelope) };
	}
	if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
		return { kind: "CREDIT_PACK_REFUNDED", fact: normalizePayPalCreditPackRefund(envelope) };
	}
	return { kind: "SUBSCRIPTION", fact: normalizePayPalEvent(envelope) };
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
	const providerEventId = getWaffoEventId(envelope);
	const providerSubscriptionId = requiredString(data.orderId, "WAFFO_SUBSCRIPTION_ID_MISSING");
	const occurredAt = requiredDate(envelope.timestamp, "WAFFO_EVENT_TIME_INVALID");
	const payment =
		eventType === "subscription.payment_succeeded" ? normalizeWaffoPayment(data) : null;
	const currentPeriod = optionalPeriod(
		data.currentPeriodStart,
		data.currentPeriodEnd,
		"WAFFO_PAYMENT_PERIOD_INVALID",
	);
	return {
		provider: "waffo",
		providerEventId,
		providerSubscriptionId,
		checkoutIntentId: optionalString(data.orderMerchantExternalId),
		providerCustomerId: optionalString(data.merchantProvidedBuyerIdentity),
		status,
		cancelAtPeriodEnd: eventType === "subscription.canceling" || status === "CANCELED",
		occurredAt,
		currentPeriod,
		payment,
	};
}

function normalizeWaffoPayment(data: Record<string, unknown>): ProviderPaymentFact {
	const period = optionalPeriod(
		data.currentPeriodStart,
		data.currentPeriodEnd,
		"WAFFO_PAYMENT_PERIOD_INVALID",
	);
	return {
		providerPaymentId: requiredString(data.paymentId, "WAFFO_PAYMENT_ID_MISSING"),
		amountMicros: decimalMicros(data.amount, "WAFFO_PAYMENT_AMOUNT_INVALID"),
		currency: currency(data.currency, "WAFFO_PAYMENT_CURRENCY_INVALID"),
		periodStart: period?.periodStart ?? null,
		periodEnd: period?.periodEnd ?? null,
	};
}

function normalizeWaffoCreditPackPayment(envelope: Record<string, unknown>): CreditPackPaymentFact {
	const data = requiredRecord(envelope.data, "WAFFO_EVENT_DATA_MISSING");
	const nestedPayment = optionalRecord(data.payment);
	const paymentStatus = requiredString(
		data.paymentStatus ?? nestedPayment?.paymentStatus,
		"WAFFO_PAYMENT_STATUS_INVALID",
	);
	if (paymentStatus.toLowerCase() !== "succeeded") {
		throw new Error("WAFFO_PAYMENT_STATUS_INVALID");
	}
	return {
		provider: "waffo",
		providerEventId: getWaffoEventId(envelope),
		checkoutIntentId: optionalString(data.orderMerchantExternalId),
		providerOrderId: requiredString(data.orderId, "WAFFO_ORDER_ID_MISSING"),
		providerPaymentId: requiredString(
			data.paymentId ?? nestedPayment?.paymentId,
			"WAFFO_PAYMENT_ID_MISSING",
		),
		providerCustomerId: optionalString(data.merchantProvidedBuyerIdentity),
		amountMicros: decimalMicros(data.amount, "WAFFO_PAYMENT_AMOUNT_INVALID"),
		currency: currency(data.currency, "WAFFO_PAYMENT_CURRENCY_INVALID"),
		occurredAt: requiredDate(envelope.timestamp, "WAFFO_EVENT_TIME_INVALID"),
	};
}

function waffoStatus(eventType: string): ProviderBillingFact["status"] {
	switch (eventType) {
		case "subscription.activated":
		case "subscription.renewed":
		case "subscription.recovered":
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
	const billingInfo = optionalRecord(resource.billing_info);
	return {
		provider: "paypal",
		providerEventId: requiredString(envelope.id, "PAYPAL_EVENT_ID_MISSING"),
		providerSubscriptionId: subscriptionId,
		checkoutIntentId: optionalString(resource.custom_id),
		providerCustomerId: optionalString(subscriber?.payer_id),
		status,
		cancelAtPeriodEnd: eventType === "BILLING.SUBSCRIPTION.CANCELLED" || status === "CANCELED",
		occurredAt: requiredDate(
			eventType.startsWith("BILLING.SUBSCRIPTION.")
				? envelope.create_time
				: (resource.create_time ?? envelope.create_time),
			"PAYPAL_EVENT_TIME_INVALID",
		),
		currentPeriod:
			eventType === "BILLING.SUBSCRIPTION.ACTIVATED"
				? normalizePayPalActivationPeriod(billingInfo)
				: null,
		payment: eventType === "PAYMENT.SALE.COMPLETED" ? normalizePayPalSale(resource) : null,
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
	const billingPeriod = optionalRecord(resource.billing_period);
	return {
		providerPaymentId: requiredString(resource.id, "PAYPAL_PAYMENT_ID_MISSING"),
		amountMicros: decimalMicros(amount.total, "PAYPAL_PAYMENT_AMOUNT_INVALID"),
		currency: currency(amount.currency, "PAYPAL_PAYMENT_CURRENCY_INVALID"),
		periodStart: billingPeriod
			? requiredDate(billingPeriod.start_time, "PAYPAL_PAYMENT_PERIOD_INVALID")
			: null,
		periodEnd: billingPeriod
			? requiredPeriodEnd(
					billingPeriod.start_time,
					billingPeriod.end_time,
					"PAYPAL_PAYMENT_PERIOD_INVALID",
				)
			: null,
	};
}

function normalizePayPalCreditPackPayment(
	envelope: Record<string, unknown>,
): CreditPackPaymentFact {
	const resource = requiredRecord(envelope.resource, "PAYPAL_EVENT_RESOURCE_MISSING");
	if (requiredString(resource.status, "PAYPAL_CAPTURE_STATUS_MISSING") !== "COMPLETED") {
		throw new Error("PAYPAL_CAPTURE_STATUS_INVALID");
	}
	if (resource.final_capture !== true) throw new Error("PAYPAL_CAPTURE_FINALITY_INVALID");
	const amount = requiredRecord(resource.amount, "PAYPAL_PAYMENT_AMOUNT_INVALID");
	const supplementaryData = requiredRecord(resource.supplementary_data, "PAYPAL_ORDER_ID_MISSING");
	const relatedIds = requiredRecord(supplementaryData.related_ids, "PAYPAL_ORDER_ID_MISSING");
	return {
		provider: "paypal",
		providerEventId: requiredString(envelope.id, "PAYPAL_WEBHOOK_EVENT_ID_MISSING"),
		checkoutIntentId: optionalString(resource.custom_id),
		providerOrderId: requiredString(relatedIds.order_id, "PAYPAL_ORDER_ID_MISSING"),
		providerPaymentId: requiredString(resource.id, "PAYPAL_PAYMENT_ID_MISSING"),
		providerCustomerId: optionalString(resource.payer_id),
		amountMicros: decimalMicros(amount.value, "PAYPAL_PAYMENT_AMOUNT_INVALID"),
		currency: currency(amount.currency_code, "PAYPAL_PAYMENT_CURRENCY_INVALID"),
		occurredAt: requiredDate(
			resource.create_time ?? envelope.create_time,
			"PAYPAL_EVENT_TIME_INVALID",
		),
	};
}

function normalizePayPalCreditPackRefund(envelope: Record<string, unknown>): CreditPackRefundFact {
	const resource = requiredRecord(envelope.resource, "PAYPAL_EVENT_RESOURCE_MISSING");
	if (requiredString(resource.status, "PAYPAL_REFUND_STATUS_MISSING") !== "COMPLETED") {
		throw new Error("PAYPAL_REFUND_STATUS_INVALID");
	}
	const amount = requiredRecord(resource.amount, "PAYPAL_REFUND_AMOUNT_INVALID");
	return {
		provider: "paypal",
		providerEventId: requiredString(envelope.id, "PAYPAL_WEBHOOK_EVENT_ID_MISSING"),
		providerRefundId: requiredString(resource.id, "PAYPAL_REFUND_ID_MISSING"),
		providerPaymentId: payPalCaptureIdFromRefund(resource),
		amountMicros: decimalMicros(amount.value, "PAYPAL_REFUND_AMOUNT_INVALID"),
		currency: currency(amount.currency_code, "PAYPAL_REFUND_CURRENCY_INVALID"),
		occurredAt: requiredDate(
			resource.create_time ?? envelope.create_time,
			"PAYPAL_EVENT_TIME_INVALID",
		),
	};
}

function payPalCaptureIdFromRefund(resource: Record<string, unknown>): string {
	const links = Array.isArray(resource.links) ? resource.links.map(optionalRecord) : [];
	const upLink = links.find((link) => optionalString(link?.rel) === "up");
	const href = optionalString(upLink?.href);
	if (!href) throw new Error("PAYPAL_REFUND_CAPTURE_ID_MISSING");
	let pathname: string;
	try {
		pathname = new URL(href).pathname;
	} catch {
		throw new Error("PAYPAL_REFUND_CAPTURE_ID_MISSING");
	}
	const match = /^\/v2\/payments\/captures\/([^/]+)$/.exec(pathname);
	if (!match?.[1]) throw new Error("PAYPAL_REFUND_CAPTURE_ID_MISSING");
	return decodeURIComponent(match[1]);
}

function normalizePayPalActivationPeriod(
	billingInfo: Record<string, unknown> | null,
): ProviderBillingPeriodFact | null {
	const lastPayment = optionalRecord(billingInfo?.last_payment);
	return optionalPeriod(
		lastPayment?.time,
		billingInfo?.next_billing_time,
		"PAYPAL_PAYMENT_PERIOD_INVALID",
	);
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

function optionalPeriod(
	start: unknown,
	end: unknown,
	code: string,
): ProviderBillingPeriodFact | null {
	if (start === undefined && end === undefined) return null;
	return {
		periodStart: requiredDate(start, code),
		periodEnd: requiredPeriodEnd(start, end, code),
	};
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
