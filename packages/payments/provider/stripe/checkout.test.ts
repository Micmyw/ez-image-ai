import { describe, expect, it, vi } from "vitest";

import { createStripeCheckoutLink } from "./checkout";

describe("Stripe checkout binding", () => {
	it("binds immutable internal plan and owner metadata to session and subscription", async () => {
		const create = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.test/session" });
		const result = await createStripeCheckoutLink(
			{
				checkout: { sessions: { create } },
			} as never,
			{
				type: "subscription",
				priceId: "price_creator_monthly",
				billingPlanId: "billing-plan-v1",
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
		};
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [{ price: "price_creator_monthly", quantity: 1 }],
				metadata: expectedMetadata,
				subscription_data: expect.objectContaining({ metadata: expectedMetadata }),
			}),
		);
	});
});
