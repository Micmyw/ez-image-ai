import { describe, expect, it, vi } from "vitest";

import type { CreateCheckoutLinkOptions } from "../../types";
import {
	createPayPalCheckoutLink,
	createPayPalWebhookVerifier,
	cancelPayPalSubscription,
	getPayPalAccessToken,
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
