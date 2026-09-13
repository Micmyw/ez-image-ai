import { describe, expect, it } from "vitest";

import { createPurchasesHelper, type ResolvedPurchase } from "./helper";

describe("createPurchasesHelper", () => {
	it("exposes every manageable subscription and selects the server's effective subscription", () => {
		const base = {
			type: "SUBSCRIPTION",
			productKind: "PLAN",
			status: "active",
			planPrice: { type: "subscription", interval: "month", amount: 19, currency: "USD" },
		};
		const purchases = [
			{
				...base,
				id: "waffo-old",
				provider: "waffo",
				planId: "ultimate",
				isEffectiveSubscription: false,
			},
			{
				...base,
				id: "paypal-current",
				provider: "paypal",
				planId: "studio",
				isEffectiveSubscription: true,
			},
			{
				...base,
				id: "paypal-old",
				provider: "paypal",
				planId: "creator",
				isEffectiveSubscription: false,
			},
		] as ResolvedPurchase[];
		const result = createPurchasesHelper(purchases);
		expect(result.activePlan).toMatchObject({ purchaseId: "paypal-current", id: "studio" });
		expect(result.activeSubscriptions.map((plan) => plan.purchaseId)).toEqual([
			"paypal-current",
			"waffo-old",
			"paypal-old",
		]);
		expect(result.hasBlockingSubscription).toBe(true);
	});

	it("keeps overdue subscriptions manageable without granting effective access", () => {
		const result = createPurchasesHelper([
			{
				id: "overdue",
				type: "SUBSCRIPTION",
				productKind: "PLAN",
				status: "past_due",
				provider: "paypal",
				planId: "creator",
				isEffectiveSubscription: false,
				planPrice: { type: "subscription", interval: "month", amount: 19, currency: "USD" },
			} as ResolvedPurchase,
		]);
		expect(result.activePlan?.id).toBe("free");
		expect(result.activeSubscriptions).toHaveLength(1);
		expect(result.hasBlockingSubscription).toBe(true);
	});
	it("retains access until period end while exposing scheduled cancellation", () => {
		const purchase = {
			id: "purchase-canceling",
			organizationId: null,
			userId: "user-1",
			type: "SUBSCRIPTION",
			productKind: "PLAN",
			provider: "waffo",
			customerId: "payer-1",
			subscriptionId: "subscription-1",
			priceId: "price-ultimate",
			status: "active",
			planId: "ultimate",
			planPrice: { type: "subscription", interval: "month", amount: 49, currency: "USD" },
			subscription: {
				cancelAtPeriodEnd: true,
				currentPeriodEnd: new Date("2026-10-12T00:00:00Z"),
			},
		} as ResolvedPurchase;
		const result = createPurchasesHelper([purchase]);
		expect(result.hasSubscription("ultimate")).toBe(true);
		expect(result.activePlan).toMatchObject({
			id: "ultimate",
			status: "active",
			subscription: {
				cancelAtPeriodEnd: true,
				currentPeriodEnd: new Date("2026-10-12T00:00:00Z"),
			},
		});
	});
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
