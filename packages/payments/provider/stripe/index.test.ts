import { describe, expect, it } from "vitest";

import { createCheckoutLink, createStripeProvider } from "./index";

const checkoutOptions = {
	type: "subscription" as const,
	priceId: "price_creator_monthly",
	currency: "USD",
	billingPlanId: "billing-plan-v1",
	checkoutIntentId: "checkout-intent-v1",
	idempotencyKey: "checkout-operation-v1",
	planKey: "creator",
	ownerType: "USER" as const,
	ownerId: "user-1",
	submittedByUserId: "user-1",
};

describe("Stripe legacy runtime provider", () => {
	it("keeps lifecycle capabilities while rejecting every new checkout", async () => {
		const provider = createStripeProvider();

		expect(provider.capabilities).toEqual({
			checkout: false,
			portal: true,
			cancellation: true,
			seatUpdates: true,
			webhooks: true,
		});
		expect(provider.createPortal).toBeTypeOf("function");
		expect(provider.cancelSubscription).toBeTypeOf("function");
		await expect(provider.createCheckout(checkoutOptions)).rejects.toThrow(
			"STRIPE_CHECKOUT_DISABLED",
		);
	});

	it("rejects the legacy top-level checkout helper before loading Stripe credentials", async () => {
		await expect(createCheckoutLink(checkoutOptions)).rejects.toThrow("STRIPE_CHECKOUT_DISABLED");
	});
});
