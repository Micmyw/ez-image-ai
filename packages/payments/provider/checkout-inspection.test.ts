import { describe, expect, it, vi } from "vitest";

import { inspectPayPalSubscriptionCheckout } from "./paypal/paypal";
import { inspectWaffoSubscriptionCheckout } from "./waffo/waffo";

describe("checkout closure with delayed payment delivery", () => {
	it("does not discard a canceled PayPal subscription that already received money", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 200,
			body: {
				id: "I-1",
				custom_id: "intent",
				plan_id: "P-1",
				status: "CANCELLED",
				billing_info: { last_payment: { amount: { value: "19.00", currency_code: "USD" } } },
			},
		});
		expect(
			await inspectPayPalSubscriptionCheckout(
				{ request },
				{ baseUrl: "https://api-m.paypal.com", accessToken: "test" },
				{ checkoutIntentId: "intent", providerSessionId: "I-1", priceId: "P-1" },
			),
		).toBe("PAID");
	});
	it("does not discard a canceled Waffo order whose payment notification is delayed", async () => {
		const query = vi.fn().mockResolvedValue({
			data: {
				subscriptionOrders: [
					{
						id: "ORD-1",
						status: "canceled",
						orderMerchantExternalId: "intent",
						activateAt: "2026-09-01",
						payments: [{ status: "succeeded" }],
					},
				],
			},
		});
		expect(
			await inspectWaffoSubscriptionCheckout({ graphql: { query } } as never, "store", {
				checkoutIntentId: "intent",
				expiresAt: null,
				now: new Date(),
			}),
		).toBe("PAID");
	});
	it("can close a Waffo order only when its history confirms it never became payable", async () => {
		const query = vi.fn().mockResolvedValue({
			data: {
				subscriptionOrders: [
					{
						id: "ORD-1",
						status: "closed",
						orderMerchantExternalId: "intent",
						activateAt: null,
						currentPeriodStart: null,
						payments: [],
					},
				],
			},
		});
		expect(
			await inspectWaffoSubscriptionCheckout({ graphql: { query } } as never, "store", {
				checkoutIntentId: "intent",
				expiresAt: null,
				now: new Date(),
			}),
		).toBe("CLOSED");
	});
});
