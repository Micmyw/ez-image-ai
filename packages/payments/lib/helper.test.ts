import { describe, expect, it } from "vitest";

import { createPurchasesHelper, type ResolvedPurchase } from "./helper";

describe("createPurchasesHelper", () => {
	it("does not grant plan entitlement from a credit-pack purchase", () => {
		const creditPackPurchase = {
			id: "purchase-credit-pack",
			organizationId: null,
			userId: "user-1",
			type: "ONE_TIME",
			productKind: "CREDIT_PACK",
			provider: "paypal",
			customerId: "payer-1",
			subscriptionId: null,
			priceId: "PROD-CREDITS-1500",
			status: "completed",
			planId: "creator",
			planPrice: {
				type: "subscription",
				interval: "month",
				amount: 19,
				currency: "USD",
			},
		} as unknown as ResolvedPurchase;

		const purchases = createPurchasesHelper([creditPackPurchase]);

		expect(purchases.activePlan).toMatchObject({ id: "free", status: "active" });
		expect(purchases.hasPurchase("creator")).toBe(false);
	});
});
