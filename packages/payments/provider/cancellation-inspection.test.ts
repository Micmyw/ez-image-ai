import { describe, expect, it, vi } from "vitest";

import { inspectPayPalSubscriptionCancellation } from "./paypal/paypal";
import { inspectWaffoSubscriptionCancellation, type WaffoSdkBoundary } from "./waffo/waffo";

const input = {
	subscriptionId: "subscription-1",
	checkoutIntentId: "intent-1",
	priceId: "price-1",
};
const configuration = { baseUrl: "https://api-m.sandbox.paypal.com", accessToken: "test-token" };

describe("authoritative subscription cancellation inspection", () => {
	it.each([
		["CANCELLED", "DISABLED"],
		["EXPIRED", "DISABLED"],
		["ACTIVE", "RENEWING"],
		["SUSPENDED", "RENEWING"],
		["unrecognized", "UNKNOWN"],
	])("maps PayPal %s to %s", async (status, expected) => {
		const request = vi.fn().mockResolvedValue({
			status: 200,
			body: {
				id: input.subscriptionId,
				custom_id: input.checkoutIntentId,
				plan_id: input.priceId,
				status,
			},
		});
		expect(await inspectPayPalSubscriptionCancellation({ request }, configuration, input)).toBe(
			expected,
		);
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "GET",
				url: `${configuration.baseUrl}/v1/billing/subscriptions/subscription-1`,
			}),
		);
	});

	it.each([
		{ status: 404, body: null },
		{ status: 204, body: null },
		{
			status: 200,
			body: { id: "different", custom_id: "intent-1", plan_id: "price-1", status: "CANCELLED" },
		},
		{
			status: 200,
			body: {
				id: "subscription-1",
				custom_id: "other-owner",
				plan_id: "price-1",
				status: "CANCELLED",
			},
		},
		{
			status: 200,
			body: {
				id: "subscription-1",
				custom_id: "intent-1",
				plan_id: "other-plan",
				status: "CANCELLED",
			},
		},
	])(
		"does not infer PayPal cancellation from missing or mismatched evidence %#",
		async (response) => {
			expect(
				await inspectPayPalSubscriptionCancellation(
					{ request: vi.fn().mockResolvedValue(response) },
					configuration,
					input,
				),
			).toBe("UNKNOWN");
		},
	);

	it.each([
		["canceled", "DISABLED"],
		["closed", "DISABLED"],
		["canceling", "PENDING"],
		["active", "RENEWING"],
		["past_due", "RENEWING"],
		["unrecognized", "UNKNOWN"],
	])("maps Waffo %s to %s", async (status, expected) => {
		const query = vi.fn().mockResolvedValue({
			data: {
				subscriptionOrders: [
					{ id: input.subscriptionId, orderMerchantExternalId: input.checkoutIntentId, status },
				],
			},
		});
		expect(await inspectWaffoSubscriptionCancellation(waffo(query), "store-1", input)).toBe(
			expected,
		);
		expect(query).toHaveBeenCalledWith(
			expect.objectContaining({
				variables: { storeId: "store-1", externalId: input.checkoutIntentId },
			}),
		);
	});

	it.each([
		{},
		{ data: { subscriptionOrders: [] } },
		{ data: { subscriptionOrders: [null] } },
		{
			data: {
				subscriptionOrders: [
					{ id: "other", orderMerchantExternalId: "intent-1", status: "closed" },
				],
			},
		},
		{
			data: {
				subscriptionOrders: [
					{ id: "subscription-1", orderMerchantExternalId: "other", status: "closed" },
				],
			},
		},
		{
			data: {
				subscriptionOrders: [
					{ id: "subscription-1", orderMerchantExternalId: "intent-1", status: "closed" },
				],
			},
			warnings: ["partial response"],
		},
		{
			data: {
				subscriptionOrders: [
					{ id: "subscription-1", orderMerchantExternalId: "intent-1", status: "closed" },
				],
			},
			errors: ["failed"],
		},
	])(
		"does not infer Waffo cancellation from missing or mismatched evidence %#",
		async (response) => {
			expect(
				await inspectWaffoSubscriptionCancellation(
					waffo(vi.fn().mockResolvedValue(response)),
					"store-1",
					input,
				),
			).toBe("UNKNOWN");
		},
	);
});

function waffo(query: NonNullable<WaffoSdkBoundary["graphql"]>["query"]): WaffoSdkBoundary {
	return {
		graphql: { query },
		checkout: { authenticated: { create: vi.fn() } },
		orders: { cancelSubscription: vi.fn() },
		webhooks: { verify: vi.fn() },
	};
}
