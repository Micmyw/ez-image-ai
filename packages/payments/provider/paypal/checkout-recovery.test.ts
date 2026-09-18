import { describe, expect, it, vi } from "vitest";

import {
	createPayPalCheckoutLink,
	recoverPayPalSubscriptionCheckout,
	activatePayPalSubscriptionCheckout,
} from "./paypal";

describe("PayPal merchant-controlled checkout", () => {
	it("treats authenticated 404 as unknown, never as closure", async () => {
		const request = vi
			.fn()
			.mockResolvedValue({ status: 404, body: { name: "RESOURCE_NOT_FOUND" } });
		expect(
			await recoverPayPalSubscriptionCheckout(
				{ request },
				{ baseUrl: "https://paypal.test", accessToken: "test" },
				{ checkoutIntentId: "i1", providerSessionId: "I-1", priceId: "P-1" },
			),
		).toMatchObject({ status: "UNKNOWN", reason: "RESOURCE_NOT_FOUND" });
	});
	it("requires matching custom id and plan before recognizing approval", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 200,
			body: { id: "I-1", custom_id: "other", plan_id: "P-1", status: "APPROVED" },
		});
		expect(
			await recoverPayPalSubscriptionCheckout(
				{ request },
				{ baseUrl: "https://paypal.test", accessToken: "test" },
				{ checkoutIntentId: "i1", providerSessionId: "I-1", priceId: "P-1" },
			),
		).toMatchObject({ status: "UNKNOWN" });
	});
	it("uses a stable activation request identity and never recreates the subscription", async () => {
		const request = vi.fn().mockResolvedValue({ status: 204 });
		await activatePayPalSubscriptionCheckout(
			{ request },
			{ baseUrl: "https://paypal.test", accessToken: "test" },
			{
				checkoutIntentId: "i1",
				providerSessionId: "I-1",
				priceId: "P-1",
				expiresAt: null,
				now: new Date(),
				cancelRequested: false,
				sessionExpiryVerified: true,
			},
		);
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "POST",
				url: "https://paypal.test/v1/billing/subscriptions/I-1/activate",
				headers: expect.objectContaining({ "PayPal-Request-Id": "activate:i1" }),
			}),
		);
	});
	it("does not let PayPal activate a replaceable checkout after buyer approval", async () => {
		const request = vi.fn().mockResolvedValue({
			status: 201,
			body: {
				id: "I-MANUAL",
				status: "APPROVAL_PENDING",
				links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/approve" }],
			},
		});
		await createPayPalCheckoutLink(
			{ request },
			{ baseUrl: "https://api-m.sandbox.paypal.com", accessToken: "test" },
			{
				type: "subscription",
				priceId: "P-1",
				currency: "USD",
				billingPlanId: "plan-1",
				checkoutIntentId: "intent-1",
				idempotencyKey: "attempt-1",
				planKey: "creator",
				ownerType: "USER",
				ownerId: "owner-1",
				submittedByUserId: "owner-1",
				subscriptionActivationMode: "MERCHANT",
				redirectUrl: "https://example.test/return?checkoutIntentId=intent-1",
				cancelUrl: "https://example.test/return?checkoutIntentId=intent-1&canceled=1",
			} as never,
		);
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					application_context: expect.objectContaining({
						user_action: "CONTINUE",
						cancel_url: "https://example.test/return?checkoutIntentId=intent-1&canceled=1",
					}),
				}),
			}),
		);
	});
});
