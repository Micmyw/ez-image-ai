import { describe, expect, it, vi } from "vitest";

import { createStripeCheckout, createStripeCheckoutLink } from "./checkout";

describe("Stripe checkout binding", () => {
	it.each([createStripeCheckout, createStripeCheckoutLink])(
		"fails closed without calling the Stripe checkout API",
		async (createCheckout) => {
			const create = vi.fn();
			await expect(
				createCheckout({ checkout: { sessions: { create } } } as never, {
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
			).rejects.toThrow("STRIPE_CHECKOUT_DISABLED");
			expect(create).not.toHaveBeenCalled();
		},
	);
});
