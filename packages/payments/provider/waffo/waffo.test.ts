import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutLinkOptions } from "../../types";
import {
	cancelWaffoSubscription,
	createWaffoCheckoutLink,
	createWaffoWebhookVerifier,
	type WaffoSdkBoundary,
} from "./waffo";

const checkoutOptions: CreateCheckoutLinkOptions = {
	type: "subscription",
	priceId: "PROD_0123456789AbCdEfGhIjKl",
	currency: "USD",
	billingPlanId: "billing-plan-1",
	checkoutIntentId: "checkout-intent-1",
	idempotencyKey: "checkout-attempt-1",
	planKey: "creator",
	ownerType: "USER",
	ownerId: "user-1",
	submittedByUserId: "user-1",
	email: "owner@example.com",
	redirectUrl: "https://app.ezpic.test/checkout-return",
};

describe("Waffo Pancake SDK boundary", () => {
	it("routes cancellation through the merchant order boundary", async () => {
		const cancelSubscription = vi.fn().mockResolvedValue({
			orderId: "ORD_subscription",
			status: "canceling",
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription },
			webhooks: { verify: vi.fn() },
		};

		await expect(cancelWaffoSubscription(client, "ORD_subscription")).resolves.toBeUndefined();
		expect(cancelSubscription).toHaveBeenCalledWith({ orderId: "ORD_subscription" });
	});

	it("uses typed authenticated checkout with stable owner and intent correlation", async () => {
		const create = vi.fn().mockResolvedValue({
			sessionId: "session-1",
			checkoutUrl: "https://pancake.waffo.ai/checkout/session-1#token=jwt",
			expiresAt: "2026-08-31T01:00:00Z",
			token: "jwt",
			tokenExpiresAt: "2026-08-31T00:05:00Z",
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: { verify: vi.fn() },
		};

		await expect(createWaffoCheckoutLink(client, checkoutOptions)).resolves.toEqual({
			checkoutUrl: "https://pancake.waffo.ai/checkout/session-1#token=jwt",
			providerSessionId: "session-1",
			expiresAt: new Date("2026-08-31T01:00:00Z"),
		});
		expect(create).toHaveBeenCalledWith({
			productId: "PROD_0123456789AbCdEfGhIjKl",
			currency: "USD",
			buyerIdentity: "USER:user-1",
			buyerEmail: "owner@example.com",
			successUrl: "https://app.ezpic.test/checkout-return",
			orderMerchantExternalId: "checkout-intent-1",
			metadata: {
				billingPlanId: "billing-plan-1",
				planKey: "creator",
				ownerType: "USER",
				ownerId: "user-1",
			},
		});
	});

	it("passes the untouched body and Waffo signature to SDK verification", () => {
		const rawBody = '{"id":"delivery-1","eventType":"subscription.activated"}';
		const verify = vi.fn().mockReturnValue({
			id: "delivery-1",
			eventId: "event-1",
			eventType: "subscription.activated",
			timestamp: "2026-08-31T00:00:00Z",
			mode: "test",
			storeId: "store-1",
			storeName: "EzPic",
			data: { orderId: "order-1" },
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: { verify },
		};
		const verifier = createWaffoWebhookVerifier(client, "test");

		expect(verifier(rawBody, new Headers({ "x-waffo-signature": "signature-1" }))).toEqual({
			providerEventId: "delivery-1",
			normalizedTransactionId: "event-1",
			envelope: {
				id: "delivery-1",
				eventId: "event-1",
				eventType: "subscription.activated",
				timestamp: "2026-08-31T00:00:00Z",
				mode: "test",
				storeId: "store-1",
				storeName: "EzPic",
				data: { orderId: "order-1" },
			},
		});
		expect(verify).toHaveBeenCalledWith(rawBody, "signature-1", { environment: "test" });
	});
});
