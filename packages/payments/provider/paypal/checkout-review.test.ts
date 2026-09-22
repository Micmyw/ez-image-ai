import type { RecoverableCheckout } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

import * as paypal from "./index";

const environment = {
	PAYPAL_ENVIRONMENT: "live",
	PAYPAL_CLIENT_ID: "client",
	PAYPAL_CLIENT_SECRET: "secret",
	PAYPAL_WEBHOOK_ID: "hook",
};
function intent(): RecoverableCheckout {
	return {
		id: "order-1",
		provider: "paypal",
		productKind: "PLAN",
		status: "PROVIDER_PENDING",
		ownerType: "USER",
		ownerId: "user-1",
		submittedByUserId: "user-1",
		planKey: "studio",
		interval: "month",
		providerSessionId: "I-1",
		providerOrderId: null,
		providerCheckoutUrl:
			"https://www.paypal.com/webapps/billing/subscriptions?ba_token=approval-token",
		expiresAt: null,
		billingPlan: { providerPriceId: "P-original", metadata: { providerEnvironment: "live" } },
		checkoutRecovery: {
			version: 1,
			mode: "LEGACY",
			status: "REVIEW",
			sequence: 3,
			failures: 3,
			reason: "RESOURCE_NOT_FOUND",
		},
	};
}
function boundary(
	subscription = {
		status: 404,
		body: { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] },
	},
) {
	return {
		request: vi
			.fn()
			.mockResolvedValueOnce({ status: 200, body: { access_token: "test-token" } })
			.mockResolvedValueOnce(subscription)
			.mockResolvedValueOnce({ status: 200, body: { id: "P-original", status: "ACTIVE" } }),
	};
}
describe("fresh PayPal evidence for reviewed legacy checkout closure", () => {
	it("authenticates and checks the original subscription and plan in the original environment", async () => {
		const http = boundary();
		const result = await paypal.inspectPayPalCheckoutReview(intent(), environment, http);
		expect(result).toMatchObject({
			status: "UNKNOWN",
			reason: "RESOURCE_NOT_FOUND",
			environment: "live",
			priceId: "P-original",
			providerSessionId: "I-1",
		});
		expect(http.request.mock.calls.map(([input]) => input.url)).toEqual([
			"https://api-m.paypal.com/v1/oauth2/token",
			"https://api-m.paypal.com/v1/billing/subscriptions/I-1",
			"https://api-m.paypal.com/v1/billing/plans/P-original",
		]);
		expect(result.scope).toMatch(/^paypal:/);
	});
	it.each(["environment", "host", "metadata", "scope"])(
		"rejects mismatching %s provenance before any request",
		async (field) => {
			const checkout = intent();
			if (field === "host") checkout.providerCheckoutUrl = "https://www.sandbox.paypal.com/approve";
			if (field === "metadata") checkout.billingPlan.metadata = {};
			if (field === "scope")
				checkout.checkoutRecovery = {
					...(checkout.checkoutRecovery as object),
					scope: "other-account",
				};
			const http = boundary();
			await expect(
				paypal.inspectPayPalCheckoutReview(
					checkout,
					field === "environment" ? { ...environment, PAYPAL_ENVIRONMENT: "sandbox" } : environment,
					http,
				),
			).rejects.toThrow("CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED");
			expect(http.request).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ status: 401, body: { name: "AUTHENTICATION_FAILURE" } },
		{ status: 404, body: null },
		{ status: 200, body: { id: "I-1", status: "APPROVED" } },
	])(
		"rejects anything other than the authenticated missing-resource response: $status",
		async (response) => {
			const http = boundary(response as never);
			await expect(paypal.inspectPayPalCheckoutReview(intent(), environment, http)).rejects.toThrow(
				"CHECKOUT_REVIEW_PROVIDER_UNCONFIRMED",
			);
		},
	);
	it("rejects inaccessible or mismatched original plans", async () => {
		for (const response of [
			{ status: 404, body: {} },
			{ status: 200, body: { id: "P-other", status: "ACTIVE" } },
		]) {
			const http = boundary();
			http.request
				.mockReset()
				.mockResolvedValueOnce({ status: 200, body: { access_token: "token" } })
				.mockResolvedValueOnce({
					status: 404,
					body: { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] },
				})
				.mockResolvedValueOnce(response);
			await expect(paypal.inspectPayPalCheckoutReview(intent(), environment, http)).rejects.toThrow(
				"CHECKOUT_REVIEW_PROVENANCE_UNCONFIRMED",
			);
		}
	});
});
