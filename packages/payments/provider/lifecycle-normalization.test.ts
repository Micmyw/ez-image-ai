import { describe, expect, it } from "vitest";

import {
	normalizeProviderBillingEvent,
	normalizeProviderPaymentEvent,
} from "./lifecycle-normalization";

describe("PayPal and Waffo lifecycle normalization", () => {
	it("normalizes the official Waffo activation shape without inventing a payment", () => {
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
			currentPeriod: {
				periodStart: new Date("2026-08-31T00:00:00Z"),
				periodEnd: new Date("2026-09-30T00:00:00Z"),
			},
			payment: null,
		});
	});

	it("normalizes a Waffo payment success as the credit-bearing fact", () => {
		expect(
			normalizeProviderBillingEvent("waffo", {
				id: "delivery-2",
				eventId: "business-event-2",
				eventType: "subscription.payment_succeeded",
				timestamp: "2026-09-30T00:00:00Z",
				mode: "test",
				data: {
					orderId: "ORD-SUBSCRIPTION",
					merchantProvidedBuyerIdentity: "USER:user-1",
					orderMerchantExternalId: "checkout-intent-1",
					currency: "USD",
					amount: "19.00",
					paymentId: "PAYMENT-1",
					currentPeriodStart: "2026-09-30T00:00:00Z",
					currentPeriodEnd: "2026-10-31T00:00:00Z",
				},
			}),
		).toMatchObject({
			provider: "waffo",
			providerEventId: "delivery-2",
			providerSubscriptionId: "ORD-SUBSCRIPTION",
			payment: {
				providerPaymentId: "PAYMENT-1",
				amountMicros: 19_000_000n,
				currency: "USD",
				periodStart: new Date("2026-09-30T00:00:00Z"),
				periodEnd: new Date("2026-10-31T00:00:00Z"),
			},
		});
	});

	it("normalizes an official PayPal sale without non-contract billing period or custom fields", () => {
		expect(
			normalizeProviderBillingEvent("paypal", {
				id: "WH-PAYPAL-SALE-1",
				event_type: "PAYMENT.SALE.COMPLETED",
				create_time: "2026-09-30T00:00:00Z",
				resource: {
					id: "PAYPAL-SALE-1",
					billing_agreement_id: "I-SUBSCRIPTION",
					amount: { total: "19.00", currency: "USD" },
				},
			}),
		).toEqual({
			provider: "paypal",
			providerEventId: "WH-PAYPAL-SALE-1",
			providerSubscriptionId: "I-SUBSCRIPTION",
			checkoutIntentId: null,
			providerCustomerId: null,
			status: "ACTIVE",
			cancelAtPeriodEnd: false,
			occurredAt: new Date("2026-09-30T00:00:00Z"),
			currentPeriod: null,
			payment: {
				providerPaymentId: "PAYPAL-SALE-1",
				amountMicros: 19_000_000n,
				currency: "USD",
				periodStart: null,
				periodEnd: null,
			},
		});
	});

	it("normalizes official PayPal activation timing without inventing a payment identity", () => {
		expect(
			normalizeProviderBillingEvent("paypal", {
				id: "WH-PAYPAL-ACTIVATION-1",
				event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
				create_time: "2026-01-31T00:01:00Z",
				resource: {
					id: "I-SUBSCRIPTION",
					custom_id: "checkout-intent-1",
					subscriber: { payer_id: "PAYER-1" },
					billing_info: {
						last_payment: {
							time: "2026-01-31T00:00:00Z",
							amount: { value: "19.00", currency_code: "USD" },
						},
						next_billing_time: "2026-02-28T00:00:00Z",
					},
				},
			}),
		).toMatchObject({
			currentPeriod: {
				periodStart: new Date("2026-01-31T00:00:00Z"),
				periodEnd: new Date("2026-02-28T00:00:00Z"),
			},
			payment: null,
		});
	});

	it.each([
		["BILLING.SUBSCRIPTION.ACTIVATED", "ACTIVE"],
		["BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAST_DUE"],
		["BILLING.SUBSCRIPTION.SUSPENDED", "PAST_DUE"],
		["BILLING.SUBSCRIPTION.CANCELLED", "CANCELED"],
		["BILLING.SUBSCRIPTION.EXPIRED", "EXPIRED"],
	] as const)(
		"anchors %s to the lifecycle event time rather than the subscription creation time",
		(eventType, status) => {
			const normalized = normalizeProviderBillingEvent("paypal", {
				id: `WH-${eventType}`,
				event_type: eventType,
				create_time: "2026-09-07T10:00:00Z",
				resource: {
					id: "I-SUBSCRIPTION",
					create_time: "2026-01-31T00:00:00Z",
				},
			});

			expect(normalized.status).toBe(status);
			expect(normalized.occurredAt).toEqual(new Date("2026-09-07T10:00:00Z"));
		},
	);

	it("rejects a PayPal subscription lifecycle event without its event time", () => {
		expect(() =>
			normalizeProviderBillingEvent("paypal", {
				id: "WH-PAYPAL-CANCELLED-WITHOUT-EVENT-TIME",
				event_type: "BILLING.SUBSCRIPTION.CANCELLED",
				resource: {
					id: "I-SUBSCRIPTION",
					create_time: "2026-01-31T00:00:00Z",
				},
			}),
		).toThrow("PAYPAL_EVENT_TIME_INVALID");
	});

	it("anchors a PayPal sale to the transaction time rather than delayed webhook delivery", () => {
		const normalized = normalizeProviderBillingEvent("paypal", {
			id: "WH-PAYPAL-SALE-DELAYED",
			event_type: "PAYMENT.SALE.COMPLETED",
			create_time: "2026-09-07T10:00:00Z",
			resource: {
				id: "PAYPAL-SALE-DELAYED",
				billing_agreement_id: "I-SUBSCRIPTION",
				create_time: "2026-09-06T01:02:03Z",
				amount: { total: "19.00", currency: "USD" },
			},
		});

		expect(normalized.occurredAt).toEqual(new Date("2026-09-06T01:02:03Z"));
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

	it("normalizes Waffo one-time completion with the checkout, order, and payment identities", () => {
		expect(
			normalizeProviderPaymentEvent("waffo", {
				id: "delivery-pack-1",
				eventId: "business-event-1",
				eventType: "order.completed",
				timestamp: "2026-09-06T01:02:03Z",
				data: {
					orderId: "ORDER-1",
					orderMerchantExternalId: "checkout-intent-pack-1",
					merchantProvidedBuyerIdentity: "USER:user-1",
					amount: "59.00",
					currency: "USD",
					paymentId: "PAYMENT-1",
					paymentStatus: "succeeded",
				},
			}),
		).toEqual({
			kind: "CREDIT_PACK_PAID",
			fact: {
				provider: "waffo",
				providerEventId: "delivery-pack-1",
				checkoutIntentId: "checkout-intent-pack-1",
				providerOrderId: "ORDER-1",
				providerPaymentId: "PAYMENT-1",
				providerCustomerId: "USER:user-1",
				amountMicros: 59_000_000n,
				currency: "USD",
				occurredAt: new Date("2026-09-06T01:02:03Z"),
			},
		});
	});

	it("rejects a Waffo order completion without an explicit succeeded payment", () => {
		expect(() =>
			normalizeProviderPaymentEvent("waffo", {
				id: "delivery-pack-missing-payment-status",
				eventType: "order.completed",
				timestamp: "2026-09-06T01:02:03Z",
				data: {
					orderId: "ORDER-1",
					orderMerchantExternalId: "checkout-intent-pack-1",
					merchantProvidedBuyerIdentity: "USER:user-1",
					amount: "59.00",
					currency: "USD",
					paymentId: "PAYMENT-1",
				},
			}),
		).toThrow("WAFFO_PAYMENT_STATUS_INVALID");
	});

	it("normalizes PayPal capture completion without confusing the order and capture IDs", () => {
		expect(
			normalizeProviderPaymentEvent("paypal", {
				id: "WH-CAPTURE-1",
				event_type: "PAYMENT.CAPTURE.COMPLETED",
				create_time: "2026-09-06T01:02:03Z",
				resource: {
					id: "CAPTURE-1",
					status: "COMPLETED",
					final_capture: true,
					custom_id: "checkout-intent-pack-1",
					payer_id: "PAYER-1",
					amount: { currency_code: "USD", value: "59.00" },
					supplementary_data: { related_ids: { order_id: "ORDER-1" } },
				},
			}),
		).toEqual({
			kind: "CREDIT_PACK_PAID",
			fact: {
				provider: "paypal",
				providerEventId: "WH-CAPTURE-1",
				checkoutIntentId: "checkout-intent-pack-1",
				providerOrderId: "ORDER-1",
				providerPaymentId: "CAPTURE-1",
				providerCustomerId: "PAYER-1",
				amountMicros: 59_000_000n,
				currency: "USD",
				occurredAt: new Date("2026-09-06T01:02:03Z"),
			},
		});
	});

	it("anchors PayPal credit expiry to the capture time rather than webhook delivery time", () => {
		const normalized = normalizeProviderPaymentEvent("paypal", {
			id: "WH-CAPTURE-DELAYED",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			create_time: "2026-09-07T10:00:00Z",
			resource: {
				id: "CAPTURE-DELAYED",
				status: "COMPLETED",
				final_capture: true,
				create_time: "2026-09-06T01:02:03Z",
				custom_id: "checkout-intent-pack-1",
				amount: { currency_code: "USD", value: "59.00" },
				supplementary_data: { related_ids: { order_id: "ORDER-1" } },
			},
		});

		expect(normalized.fact.occurredAt).toEqual(new Date("2026-09-06T01:02:03Z"));
	});

	it("normalizes a completed PayPal refund only when it carries an original capture identity", () => {
		expect(
			normalizeProviderPaymentEvent("paypal", {
				id: "WH-REFUND-1",
				event_type: "PAYMENT.CAPTURE.REFUNDED",
				create_time: "2026-09-07T01:02:03Z",
				resource: {
					id: "REFUND-1",
					status: "COMPLETED",
					amount: { currency_code: "USD", value: "29.50" },
					links: [
						{
							rel: "up",
							href: "https://api-m.paypal.com/v2/payments/captures/CAPTURE-1",
							method: "GET",
						},
					],
				},
			}),
		).toEqual({
			kind: "CREDIT_PACK_REFUNDED",
			fact: {
				provider: "paypal",
				providerEventId: "WH-REFUND-1",
				providerRefundId: "REFUND-1",
				providerPaymentId: "CAPTURE-1",
				amountMicros: 29_500_000n,
				currency: "USD",
				occurredAt: new Date("2026-09-07T01:02:03Z"),
			},
		});
	});

	it("anchors a PayPal refund to the provider resource time rather than delayed webhook delivery", () => {
		const normalized = normalizeProviderPaymentEvent("paypal", {
			id: "WH-REFUND-DELAYED",
			event_type: "PAYMENT.CAPTURE.REFUNDED",
			create_time: "2026-09-08T10:00:00Z",
			resource: {
				id: "REFUND-DELAYED",
				status: "COMPLETED",
				create_time: "2026-09-07T01:02:03Z",
				amount: { currency_code: "USD", value: "0.01" },
				links: [
					{
						rel: "up",
						href: "https://api-m.paypal.com/v2/payments/captures/CAPTURE-DELAYED",
						method: "GET",
					},
				],
			},
		});

		expect(normalized.fact.occurredAt).toEqual(new Date("2026-09-07T01:02:03Z"));
	});

	it("keeps Waffo refunds in review because its webhook omits authoritative refund identity and amount semantics", () => {
		expect(() =>
			normalizeProviderPaymentEvent("waffo", {
				id: "delivery-refund",
				eventId: "business-event-refund",
				eventType: "refund.succeeded",
				timestamp: "2026-09-07T01:02:03Z",
				data: {
					orderId: "ORDER-1",
					orderMerchantExternalId: "checkout-intent-pack-1",
					amount: "59.00",
					currency: "USD",
					refundStatus: "succeeded",
				},
			}),
		).toThrow("PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED");
	});
});
