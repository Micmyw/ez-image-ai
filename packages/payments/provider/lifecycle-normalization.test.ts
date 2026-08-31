import { describe, expect, it } from "vitest";

import { normalizeProviderBillingEvent } from "./lifecycle-normalization";

describe("PayPal and Waffo lifecycle normalization", () => {
	it("normalizes a correlated Waffo activation payment without trusting product metadata", () => {
		expect(
			normalizeProviderBillingEvent("waffo", {
				id: "delivery-1",
				eventId: "business-event-1",
				eventType: "subscription.activated",
				timestamp: "2026-08-31T00:00:00Z",
				mode: "test",
				data: {
					orderId: "ORD-SUBSCRIPTION",
					merchantProvidedBuyerIdentity: "USER:user-1",
					orderMerchantExternalId: "checkout-intent-1",
					currency: "USD",
					amount: "19.00",
					paymentId: "PAYMENT-1",
					currentPeriodStart: "2026-08-31T00:00:00Z",
					currentPeriodEnd: "2026-09-30T00:00:00Z",
				},
			}),
		).toEqual({
			provider: "waffo",
			providerEventId: "delivery-1",
			providerSubscriptionId: "ORD-SUBSCRIPTION",
			checkoutIntentId: "checkout-intent-1",
			providerCustomerId: "USER:user-1",
			status: "ACTIVE",
			cancelAtPeriodEnd: false,
			occurredAt: new Date("2026-08-31T00:00:00Z"),
			payment: {
				providerPaymentId: "PAYMENT-1",
				amountMicros: 19_000_000n,
				currency: "USD",
				periodStart: new Date("2026-08-31T00:00:00Z"),
				periodEnd: new Date("2026-09-30T00:00:00Z"),
			},
		});
	});

	it("normalizes a PayPal cancellation as a status-only lifecycle fact", () => {
		expect(
			normalizeProviderBillingEvent("paypal", {
				id: "WH-PAYPAL-1",
				event_type: "BILLING.SUBSCRIPTION.CANCELLED",
				create_time: "2026-08-31T00:00:00Z",
				resource: {
					id: "I-SUBSCRIPTION",
					custom_id: "checkout-intent-1",
					subscriber: { payer_id: "PAYER-1" },
				},
			}),
		).toMatchObject({
			provider: "paypal",
			providerEventId: "WH-PAYPAL-1",
			providerSubscriptionId: "I-SUBSCRIPTION",
			status: "CANCELED",
			cancelAtPeriodEnd: true,
			payment: null,
		});
	});

	it.each([
		["paypal", { id: "WH-REFUND", event_type: "PAYMENT.SALE.REFUNDED" }],
		["waffo", { id: "delivery-refund", eventType: "refund.succeeded" }],
	] as const)("routes %s refunds to review instead of credits", (provider, envelope) => {
		expect(() => normalizeProviderBillingEvent(provider, envelope)).toThrow(
			"PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED",
		);
	});

	it("rejects unsupported events instead of silently treating them as paid", () => {
		expect(() =>
			normalizeProviderBillingEvent("paypal", {
				id: "WH-UNKNOWN",
				event_type: "CATALOG.PRODUCT.CREATED",
			}),
		).toThrow("PAYMENT_PROVIDER_EVENT_UNSUPPORTED");
	});
});
