import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutLinkOptions } from "../../types";
import {
	capturePayPalCheckoutOrder,
	createPayPalCheckoutLink,
	createPayPalWebhookVerifier,
	cancelPayPalSubscription,
	getPayPalAccessToken,
	recoverPayPalCheckout,
	type PayPalHttpBoundary,
} from "./paypal";

const checkoutOptions: CreateCheckoutLinkOptions = {
	type: "subscription",
	priceId: "P-CREATOR-MONTHLY",
	currency: "USD",
	billingPlanId: "billing-plan-1",
	checkoutIntentId: "checkout-intent-1",
	idempotencyKey: "checkout-attempt-1",
	planKey: "creator",
	ownerType: "USER",
	ownerId: "user-1",
	submittedByUserId: "user-1",
	redirectUrl: "https://app.ezpic.test/checkout-return",
};

const creditPackCheckoutOptions: CreateCheckoutLinkOptions = {
	type: "one-time",
	priceId: "PROD-CREDITS-1500",
	currency: "USD",
	amountMicros: 59_000_000n,
	description: "EzPic 1,500 Credits",
	billingPlanId: "billing-plan-pack-1",
	checkoutIntentId: "checkout-intent-pack-1",
	idempotencyKey: "checkout-pack-attempt-1",
	planKey: "credits-1500",
	ownerType: "USER",
	ownerId: "user-1",
	submittedByUserId: "user-1",
	redirectUrl: "https://app.ezpic.test/credit-pack-checkout-return?intentId=checkout-intent-pack-1",
};

describe("PayPal REST boundary", () => {
	it("exchanges server credentials for a short-lived OAuth token", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 200,
			body: { access_token: "access-token", expires_in: 28_800 },
		});

		await expect(
			getPayPalAccessToken(
				{ request },
				{
					baseUrl: "https://api-m.sandbox.paypal.com",
					clientId: "client-id",
					clientSecret: "client-secret",
				},
			),
		).resolves.toBe("access-token");
		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v1/oauth2/token",
			headers: {
				Authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: "grant_type=client_credentials",
		});
	});

	it("cancels the selected PayPal subscription through the authenticated REST route", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 204,
			body: null,
		});

		await expect(
			cancelPayPalSubscription(
				{ request },
				{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
				"I-SUBSCRIPTION",
			),
		).resolves.toBeUndefined();
		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-SUBSCRIPTION/cancel",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
			},
			body: { reason: "Customer requested cancellation." },
		});
	});

	it("creates an approval link with a server-owned plan and checkout correlation", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 201,
			body: {
				id: "I-SUBSCRIPTION",
				links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve" }],
			},
		});

		const result = await createPayPalCheckoutLink(
			{ request },
			{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
			checkoutOptions,
		);

		expect(result).toEqual({
			checkoutUrl: "https://www.sandbox.paypal.com/approve",
			providerSessionId: "I-SUBSCRIPTION",
			expiresAt: null,
		});
		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v1/billing/subscriptions",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
				"PayPal-Request-Id": "checkout-attempt-1",
				Prefer: "return=representation",
			},
			body: {
				plan_id: "P-CREATOR-MONTHLY",
				custom_id: "checkout-intent-1",
				application_context: {
					return_url: "https://app.ezpic.test/checkout-return",
					cancel_url: "https://app.ezpic.test/checkout-return",
					user_action: "SUBSCRIBE_NOW",
				},
			},
		});
	});

	it("creates a one-time Orders v2 approval with server-owned amount and pack correlation", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 201,
			body: {
				id: "ORDER-1",
				create_time: "2026-09-06T01:02:03.000Z",
				links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/approve-order" }],
			},
		});

		await expect(
			createPayPalCheckoutLink(
				{ request },
				{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
				creditPackCheckoutOptions,
			),
		).resolves.toEqual({
			checkoutUrl: "https://www.sandbox.paypal.com/approve-order",
			providerSessionId: "ORDER-1",
			expiresAt: new Date("2026-09-06T04:02:03.000Z"),
		});
		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v2/checkout/orders",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
				"PayPal-Request-Id": "checkout-pack-attempt-1",
				Prefer: "return=representation",
			},
			body: {
				intent: "CAPTURE",
				purchase_units: [
					{
						reference_id: "credits-1500",
						custom_id: "checkout-intent-pack-1",
						description: "EzPic 1,500 Credits",
						amount: {
							currency_code: "USD",
							value: "59.00",
							breakdown: {
								item_total: { currency_code: "USD", value: "59.00" },
							},
						},
						items: [
							{
								name: "EzPic 1,500 Credits",
								sku: "PROD-CREDITS-1500",
								quantity: "1",
								unit_amount: { currency_code: "USD", value: "59.00" },
							},
						],
					},
				],
				payment_source: {
					paypal: {
						experience_context: {
							user_action: "PAY_NOW",
							payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
							shipping_preference: "NO_SHIPPING",
							return_url:
								"https://app.ezpic.test/credit-pack-checkout-return?intentId=checkout-intent-pack-1",
							cancel_url:
								"https://app.ezpic.test/credit-pack-checkout-return?intentId=checkout-intent-pack-1",
						},
					},
				},
			},
		});
	});

	it("recovers an uncertain checkout through the original PayPal idempotency key", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 200,
			body: {
				id: "ORDER-RECOVERED",
				create_time: "2026-09-06T01:02:03.000Z",
				links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/recovered" }],
			},
		});

		await expect(
			recoverPayPalCheckout(
				{ request },
				{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
				{
					...creditPackCheckoutOptions,
					providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
					now: new Date("2026-09-06T02:00:00.000Z"),
				},
			),
		).resolves.toEqual({
			status: "FOUND",
			providerOrderId: "ORDER-RECOVERED",
			checkout: {
				checkoutUrl: "https://www.sandbox.paypal.com/recovered",
				providerSessionId: "ORDER-RECOVERED",
				expiresAt: new Date("2026-09-06T04:02:03.000Z"),
			},
		});
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"PayPal-Request-Id": "checkout-pack-attempt-1",
				}),
			}),
		);
	});

	it("does not replay a PayPal create after the conservative idempotency window", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>();

		await expect(
			recoverPayPalCheckout(
				{ request },
				{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
				{
					...creditPackCheckoutOptions,
					providerCreatingAt: new Date("2026-09-06T01:00:00.000Z"),
					now: new Date("2026-09-06T06:00:00.001Z"),
				},
			),
		).resolves.toEqual({ status: "UNKNOWN" });
		expect(request).not.toHaveBeenCalled();
	});

	it("captures an approved order and emits a payment event with distinct order and capture IDs", async () => {
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 201,
			body: {
				id: "ORDER-1",
				status: "COMPLETED",
				payer: { payer_id: "PAYER-1" },
				purchase_units: [
					{
						custom_id: "checkout-intent-pack-1",
						payments: {
							captures: [
								{
									id: "CAPTURE-1",
									status: "COMPLETED",
									final_capture: true,
									create_time: "2026-09-06T01:02:03Z",
									amount: { currency_code: "USD", value: "59.00" },
								},
							],
						},
					},
				],
			},
		});

		const event = await capturePayPalCheckoutOrder(
			{ request },
			{ accessToken: "access-token", baseUrl: "https://api-m.sandbox.paypal.com" },
			{ providerOrderId: "ORDER-1", idempotencyKey: "capture-checkout-intent-pack-1" },
		);

		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
				"PayPal-Request-Id": "capture-checkout-intent-pack-1",
				Prefer: "return=representation",
			},
			body: {},
		});
		expect(event).toMatchObject({
			providerEventId: "capture-response:CAPTURE-1",
			normalizedTransactionId: "CAPTURE-1",
			envelope: {
				event_type: "PAYMENT.CAPTURE.COMPLETED",
				resource: {
					id: "CAPTURE-1",
					custom_id: "checkout-intent-pack-1",
					payer_id: "PAYER-1",
					supplementary_data: { related_ids: { order_id: "ORDER-1" } },
				},
			},
		});
	});

	it("verifies the exact raw event through PayPal before returning it", async () => {
		const rawBody =
			'{"id":"WH-1","event_type":"PAYMENT.SALE.COMPLETED","resource":{"id":"SALE-1","billing_agreement_id":"I-SUBSCRIPTION"}}';
		const request = vi.fn<PayPalHttpBoundary["request"]>().mockResolvedValue({
			status: 200,
			body: { verification_status: "SUCCESS" },
		});
		const verifier = createPayPalWebhookVerifier(
			{ request },
			{
				accessToken: "access-token",
				baseUrl: "https://api-m.sandbox.paypal.com",
				webhookId: "WH-CONFIGURED",
			},
		);
		const headers = new Headers({
			"paypal-auth-algo": "SHA256withRSA",
			"paypal-cert-url": "https://api-m.paypal.com/cert.pem",
			"paypal-transmission-id": "transmission-1",
			"paypal-transmission-sig": "signature-1",
			"paypal-transmission-time": "2026-08-31T00:00:00Z",
		});

		await expect(verifier(rawBody, headers)).resolves.toEqual({
			providerEventId: "WH-1",
			normalizedTransactionId: "SALE-1",
			providerSubscriptionId: "I-SUBSCRIPTION",
			envelope: {
				id: "WH-1",
				event_type: "PAYMENT.SALE.COMPLETED",
				resource: { id: "SALE-1", billing_agreement_id: "I-SUBSCRIPTION" },
			},
		});
		expect(request).toHaveBeenCalledWith({
			method: "POST",
			url: "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
			headers: {
				Authorization: "Bearer access-token",
				"Content-Type": "application/json",
			},
			body: {
				auth_algo: "SHA256withRSA",
				cert_url: "https://api-m.paypal.com/cert.pem",
				transmission_id: "transmission-1",
				transmission_sig: "signature-1",
				transmission_time: "2026-08-31T00:00:00Z",
				webhook_id: "WH-CONFIGURED",
				webhook_event: {
					id: "WH-1",
					event_type: "PAYMENT.SALE.COMPLETED",
					resource: { id: "SALE-1", billing_agreement_id: "I-SUBSCRIPTION" },
				},
			},
		});
	});
});
