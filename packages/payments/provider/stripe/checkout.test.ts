import { describe, expect, it, vi } from "vitest";

import { createStripeCheckout, createStripeCheckoutLink } from "./checkout";

describe("Stripe checkout binding", () => {
	it("returns the provider session identity required to bind a checkout intent", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "cs_checkout_intent",
			url: "https://checkout.stripe.test/session",
			expires_at: 1_788_134_400,
		});

		await expect(
			createStripeCheckout({ checkout: { sessions: { create } } } as never, {
				type: "subscription",
				priceId: "price_creator_monthly",
				currency: "USD",
				billingPlanId: "billing-plan-v1",
				checkoutIntentId: "checkout-intent-v1",
				idempotencyKey: "checkout-operation-v1",
				planKey: "creator",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
			}),
		).resolves.toEqual({
			checkoutUrl: "https://checkout.stripe.test/session",
			providerSessionId: "cs_checkout_intent",
			expiresAt: new Date("2026-08-31T00:00:00.000Z"),
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ checkout_intent_id: "checkout-intent-v1" }),
			}),
			{ idempotencyKey: "checkout-operation-v1" },
		);
	});

	it("binds immutable internal plan and owner metadata to session and subscription", async () => {
		const create = vi.fn().mockResolvedValue({
			id: "cs_checkout",
			url: "https://checkout.stripe.test/session",
			expires_at: null,
		});
		const result = await createStripeCheckoutLink(
			{
				checkout: { sessions: { create } },
			} as never,
			{
				type: "subscription",
				priceId: "price_creator_monthly",
				currency: "USD",
				billingPlanId: "billing-plan-v1",
				checkoutIntentId: "checkout-intent-v1",
				idempotencyKey: "checkout-operation-v1",
				planKey: "creator",
				ownerType: "USER",
				ownerId: "user-1",
				submittedByUserId: "user-1",
				email: "user@example.com",
				redirectUrl: "https://app.example.com/return",
			},
		);

		expect(result).toBe("https://checkout.stripe.test/session");
		const expectedMetadata = {
			billing_plan_id: "billing-plan-v1",
			plan_key: "creator",
			owner_type: "USER",
			owner_id: "user-1",
			submitted_by_user_id: "user-1",
			checkout_intent_id: "checkout-intent-v1",
		};
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [{ price: "price_creator_monthly", quantity: 1 }],
				metadata: expectedMetadata,
				subscription_data: expect.objectContaining({ metadata: expectedMetadata }),
			}),
			{ idempotencyKey: "checkout-operation-v1" },
		);
	});
});
