import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutLinkOptions } from "../../types";
import { createConfiguredWaffoWebhookVerifier } from "./index";
import {
	cancelWaffoSubscription,
	createWaffoCheckoutLink,
	createWaffoWebhookVerifier,
	recoverWaffoCheckout,
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

const creditPackCheckoutOptions: CreateCheckoutLinkOptions = {
	...checkoutOptions,
	type: "one-time",
	priceId: "PROD_0123456789QrStUvWxYzAb",
	billingPlanId: "billing-plan-pack-1",
	checkoutIntentId: "checkout-intent-pack-1",
	idempotencyKey: "checkout-pack-attempt-1",
	planKey: "credits-1500",
	amountMicros: 59_000_000n,
	description: "EzPic 1,500 Credits",
	redirectUrl: "https://app.ezpic.test/credit-pack-checkout-return?intentId=checkout-intent-pack-1",
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
			expiresAt: new Date("2026-08-31T00:05:00Z"),
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

	it("uses the same authenticated checkout boundary for a server-owned one-time product", async () => {
		const create = vi.fn().mockResolvedValue({
			sessionId: "session-pack-1",
			checkoutUrl: "https://pancake.waffo.ai/checkout/session-pack-1#token=jwt",
			expiresAt: "2026-09-06T02:00:00Z",
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: { verify: vi.fn() },
		};

		await expect(createWaffoCheckoutLink(client, creditPackCheckoutOptions)).resolves.toEqual({
			checkoutUrl: "https://pancake.waffo.ai/checkout/session-pack-1#token=jwt",
			providerSessionId: "session-pack-1",
			expiresAt: new Date("2026-09-06T02:00:00Z"),
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				productId: "PROD_0123456789QrStUvWxYzAb",
				orderMerchantExternalId: "checkout-intent-pack-1",
				metadata: expect.objectContaining({
					checkoutKind: "CREDIT_PACK",
					packKey: "credits-1500",
				}),
			}),
		);
	});

	it("finds the unique Waffo order by the checkout intent external id", async () => {
		const query = vi.fn().mockResolvedValue({
			data: {
				onetimeOrders: [
					{
						id: "ORD_pack_1",
						status: "completed",
						orderMerchantExternalId: "checkout-intent-pack-1",
					},
				],
			},
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			graphql: { query },
			webhooks: { verify: vi.fn() },
		};

		await expect(
			recoverWaffoCheckout(client, "STO_ezpic", {
				...creditPackCheckoutOptions,
				providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
				now: new Date("2026-09-06T02:00:00.000Z"),
			}),
		).resolves.toEqual({ status: "FOUND_UNRESUMABLE", providerOrderId: "ORD_pack_1" });
		expect(query).toHaveBeenCalledWith({
			query: expect.stringContaining("onetimeOrders"),
			variables: {
				storeId: "STO_ezpic",
				externalId: "checkout-intent-pack-1",
			},
		});
	});

	it("authoritatively reports no Waffo order only after the original session expired", async () => {
		const query = vi.fn().mockResolvedValue({ data: { subscriptionOrders: [] } });
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			graphql: { query },
			webhooks: { verify: vi.fn() },
		};

		await expect(
			recoverWaffoCheckout(client, "STO_ezpic", {
				...checkoutOptions,
				providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
				now: new Date("2026-09-07T01:00:00.000Z"),
			}),
		).resolves.toEqual({ status: "NOT_FOUND" });
	});

	it("keeps an empty Waffo result unknown while the lost checkout session may remain active", async () => {
		const query = vi.fn().mockResolvedValue({ data: { onetimeOrders: [] } });
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			graphql: { query },
			webhooks: { verify: vi.fn() },
		};

		await expect(
			recoverWaffoCheckout(client, "STO_ezpic", {
				...creditPackCheckoutOptions,
				providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
				now: new Date("2026-09-06T01:44:59.999Z"),
			}),
		).resolves.toEqual({ status: "UNKNOWN" });
	});

	it.each([
		["GraphQL errors", { data: { onetimeOrders: [] }, errors: [{ message: "unavailable" }] }],
		[
			"ambiguous matches",
			{
				data: {
					onetimeOrders: [
						{
							id: "ORD_1",
							status: "pending",
							orderMerchantExternalId: "checkout-intent-pack-1",
						},
						{
							id: "ORD_2",
							status: "completed",
							orderMerchantExternalId: "checkout-intent-pack-1",
						},
					],
				},
			},
		],
	] as const)("fails closed for %s during Waffo recovery", async (_label, result) => {
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			graphql: { query: vi.fn().mockResolvedValue(result) },
			webhooks: { verify: vi.fn() },
		};

		await expect(
			recoverWaffoCheckout(client, "STO_ezpic", {
				...creditPackCheckoutOptions,
				providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
				now: new Date("2026-09-06T02:00:00.000Z"),
			}),
		).resolves.toEqual({ status: "UNKNOWN" });
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
		const verifier = createWaffoWebhookVerifier(client, "test", "store-1");

		expect(verifier(rawBody, new Headers({ "x-waffo-signature": "signature-1" }))).toEqual({
			providerEventId: "delivery-1",
			normalizedTransactionId: "event-1",
			providerSubscriptionId: "order-1",
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

	it.each([
		["mode", { mode: "prod", storeId: "store-1" }, "WAFFO_WEBHOOK_MODE_MISMATCH"],
		["store", { mode: "test", storeId: "store-2" }, "WAFFO_WEBHOOK_STORE_MISMATCH"],
		["padded mode", { mode: " test ", storeId: "store-1" }, "WAFFO_WEBHOOK_MODE_MISMATCH"],
		["padded store", { mode: "test", storeId: " store-1 " }, "WAFFO_WEBHOOK_STORE_MISMATCH"],
		["missing mode", { storeId: "store-1" }, "WAFFO_WEBHOOK_MODE_MISMATCH"],
		["missing store", { mode: "test" }, "WAFFO_WEBHOOK_STORE_MISMATCH"],
	] as const)("rejects a signed event with a mismatched %s binding", (_case, scope, error) => {
		const verify = vi.fn().mockReturnValue({
			id: "delivery-foreign",
			eventId: "event-foreign",
			eventType: "subscription.activated",
			timestamp: "2026-08-31T00:00:00Z",
			...scope,
			data: { orderId: "order-foreign" },
		});
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: { verify },
		};
		const verifier = createWaffoWebhookVerifier(client, "test", "store-1");

		expect(() =>
			verifier('{"id":"delivery-foreign"}', new Headers({ "x-waffo-signature": "signed" })),
		).toThrow(error);
	});

	it("binds the configured webhook verifier to the server-owned store", () => {
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: {
				verify: vi.fn().mockReturnValue({
					id: "delivery-foreign-store",
					eventType: "order.completed",
					mode: "test",
					storeId: "store-2",
					data: { orderId: "order-foreign" },
				}),
			},
		};
		const verifier = createConfiguredWaffoWebhookVerifier(
			{ WAFFO_ENVIRONMENT: "test", WAFFO_STORE_ID: "store-1" },
			client,
		);

		expect(() =>
			verifier('{"id":"delivery-foreign-store"}', new Headers({ "x-waffo-signature": "signed" })),
		).toThrow("WAFFO_WEBHOOK_STORE_MISMATCH");
	});

	it("fails configured webhook verification closed without a store id", () => {
		const client: WaffoSdkBoundary = {
			checkout: { authenticated: { create: vi.fn() } },
			orders: { cancelSubscription: vi.fn() },
			webhooks: { verify: vi.fn() },
		};

		expect(() =>
			createConfiguredWaffoWebhookVerifier({ WAFFO_ENVIRONMENT: "test" }, client),
		).toThrow("WAFFO_CONFIGURATION_INCOMPLETE");
	});
});
