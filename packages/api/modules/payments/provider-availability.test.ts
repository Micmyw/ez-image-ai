import { getPlanEntitlement } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { resolveProviderAvailability } from "./provider-availability";

describe("payment provider availability", () => {
	it("advertises only fully configured providers with an exact BillingPlan snapshot", async () => {
		const entitlement = getPlanEntitlement("creator");
		const monthly = entitlement.prices.find((price) => price.interval === "month")!;
		const findBillingPlan = vi.fn(async (provider: string) => {
			if (provider === "paypal") {
				return {
					id: "paypal-plan",
					provider: "paypal",
					providerPriceId: "P-CREATOR-MONTHLY",
					active: true,
					name: "creator",
					creditsPerPeriod: BigInt(entitlement.monthlyCredits),
					priceMicros: BigInt(Math.round(monthly.amount * 1_000_000)),
					currency: monthly.currency,
					metadata: { planId: "creator", interval: "month", version: 1 },
				};
			}
			return {
				id: "stripe-drifted",
				provider,
				providerPriceId: "price_creator_monthly",
				active: true,
				name: "creator",
				creditsPerPeriod: 999n,
				priceMicros: BigInt(Math.round(monthly.amount * 1_000_000)),
				currency: monthly.currency,
				metadata: { planId: "creator", interval: "month", version: 1 },
			};
		});

		await expect(
			resolveProviderAvailability(
				{ planId: "creator", interval: "month" },
				{
					isConfigured: (provider) => provider !== "waffo",
					getProviderPriceId: (provider) =>
						provider === "paypal" ? "P-CREATOR-MONTHLY" : "price_creator_monthly",
					findBillingPlan,
				},
			),
		).resolves.toEqual([
			{
				name: "paypal",
				capabilities: {
					checkout: true,
					portal: false,
					cancellation: true,
					seatUpdates: false,
					webhooks: true,
				},
			},
		]);
		expect(findBillingPlan).not.toHaveBeenCalledWith("waffo", expect.any(String));
	});

	it("fails availability closed when the server plan mapping is absent", async () => {
		const findBillingPlan = vi.fn();
		await expect(
			resolveProviderAvailability(
				{ planId: "studio", interval: "year" },
				{
					isConfigured: () => true,
					getProviderPriceId: () => null,
					findBillingPlan,
				},
			),
		).resolves.toEqual([]);
		expect(findBillingPlan).not.toHaveBeenCalled();
	});
});
