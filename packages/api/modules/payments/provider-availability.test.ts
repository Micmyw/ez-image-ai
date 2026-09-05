import { DEFAULT_PRODUCT_CONFIG, getPlanEntitlement } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { isExactBillingPlanSnapshot, resolveProviderAvailability } from "./provider-availability";

interface BillingPlanDrift {
	version?: number;
	metadataVersion?: number;
	pricingVersion?: string;
}

const billingPlanDrifts: Array<[string, BillingPlanDrift]> = [
	["a mutated row version", { version: 2 }],
	["a mismatched metadata version", { metadataVersion: 2 }],
	["a stale pricing version", { pricingVersion: "2026-08-25.1" }],
];

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
					version: 1,
					name: "creator",
					creditsPerPeriod: BigInt(entitlement.monthlyCredits),
					priceMicros: BigInt(Math.round(monthly.amount * 1_000_000)),
					currency: monthly.currency,
					metadata: {
						planId: "creator",
						interval: "month",
						version: 1,
						pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
					},
				};
			}
			return {
				id: "stripe-drifted",
				provider,
				providerPriceId: "price_creator_monthly",
				active: true,
				version: 1,
				name: "creator",
				creditsPerPeriod: 999n,
				priceMicros: BigInt(Math.round(monthly.amount * 1_000_000)),
				currency: monthly.currency,
				metadata: {
					planId: "creator",
					interval: "month",
					version: 1,
					pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
				},
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

	it.each(billingPlanDrifts)("rejects %s even when price and credits match", (_label, drift) => {
		const entitlement = getPlanEntitlement("creator");
		const monthly = entitlement.prices.find((price) => price.interval === "month")!;
		const exact = {
			id: "paypal-current-plan",
			provider: "paypal",
			providerPriceId: "P-CREATOR-MONTHLY",
			active: true,
			version: drift.version ?? 1,
			name: "creator",
			creditsPerPeriod: BigInt(entitlement.monthlyCredits),
			priceMicros: BigInt(Math.round(monthly.amount * 1_000_000)),
			currency: monthly.currency,
			metadata: {
				planId: "creator",
				interval: "month",
				version: drift.metadataVersion ?? 1,
				pricingVersion: drift.pricingVersion ?? DEFAULT_PRODUCT_CONFIG.pricingVersion,
			},
		};

		expect(
			isExactBillingPlanSnapshot(exact, "paypal", exact.providerPriceId, {
				planId: "creator",
				interval: "month",
			}),
		).toBe(false);
	});
});
