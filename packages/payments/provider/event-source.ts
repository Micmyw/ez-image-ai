import type { VerifiedPaymentEvent } from "./webhook";

export interface ProviderEventWindow {
	since: Date;
	until: Date;
	cursor: string | null;
	limit: number;
}
export interface ProviderEventPage {
	events: VerifiedPaymentEvent[];
	nextCursor: string | null;
}
export const SUPPORTED_PAYPAL_BILLING_EVENTS = new Set([
	"PAYMENT.SALE.COMPLETED",
	"PAYMENT.SALE.REFUNDED",
	"PAYMENT.SALE.REVERSED",
	"PAYMENT.CAPTURE.COMPLETED",
	"PAYMENT.CAPTURE.REFUNDED",
	"PAYMENT.CAPTURE.REVERSED",
	"BILLING.SUBSCRIPTION.ACTIVATED",
	"BILLING.SUBSCRIPTION.PAYMENT.FAILED",
	"BILLING.SUBSCRIPTION.SUSPENDED",
	"BILLING.SUBSCRIPTION.CANCELLED",
	"BILLING.SUBSCRIPTION.EXPIRED",
]);
export const SUPPORTED_WAFFO_BILLING_EVENTS = new Set([
	"order.completed",
	"subscription.activated",
	"subscription.payment_succeeded",
	"subscription.renewed",
	"subscription.recovered",
	"subscription.canceling",
	"subscription.uncanceled",
	"subscription.canceled",
	"subscription.past_due",
	"refund.succeeded",
	"refund.failed",
]);
export function eventRecord(value: unknown, error: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
	return value as Record<string, unknown>;
}
