import { DEFAULT_PRODUCT_CONFIG, getPlanEntitlement } from "@repo/config";
import { createCreditPackCheckoutSnapshot } from "@repo/config/server";
import { describe, expect, it, vi } from "vitest";

import {
	isExactBillingPlanSnapshot,
	isExactCreditPackBillingPlanSnapshot,
	resolveCreditPackProviderAvailability,
	resolveProviderAvailability,
} from "./provider-availability";

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
					productKind: "PLAN" as const,
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
				productKind: "PLAN" as const,
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
		expect(findBillingPlan).not.toHaveBeenCalledWith("stripe", expect.any(String));
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
			productKind: "PLAN" as const,
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

	it("advertises credit packs through PayPal and Waffo only when the exact product snapshot exists", async () => {
		const snapshot = createCreditPackCheckoutSnapshot("credits-1500", false);
		const findBillingPlan = vi.fn(async (provider: string, providerProductId: string) => ({
			id: `${provider}-pack-plan`,
			provider,
			providerPriceId: providerProductId,
			productKind: "CREDIT_PACK" as const,
			active: provider === "paypal",
			version: 1,
			name: snapshot.packKey,
			creditsPerPeriod: BigInt(snapshot.baseCredits),
			priceMicros: BigInt(snapshot.priceMicros),
			currency: snapshot.currency,
			metadata: {
				productKind: "CREDIT_PACK",
				packKey: snapshot.packKey,
				catalogVersion: snapshot.catalogVersion,
				pricingVersion: snapshot.pricingVersion,
				version: 1,
				expiryMonths: snapshot.expiryMonths,
			},
		}));

		await expect(
			resolveCreditPackProviderAvailability(
				{ packKey: "credits-1500" },
				{
					isConfigured: () => true,
					getProviderProductId: (provider) =>
						provider === "paypal" ? "PROD-CREDITS-1500" : "PROD_0123456789QrStUvWxYzAb",
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
		expect(findBillingPlan).toHaveBeenCalledTimes(2);
		expect(findBillingPlan).not.toHaveBeenCalledWith("stripe", expect.any(String));
	});

	it("rejects a plan-shaped BillingPlan from credit-pack checkout", () => {
		const snapshot = createCreditPackCheckoutSnapshot("credits-3000", false);
		expect(
			isExactCreditPackBillingPlanSnapshot(
				{
					id: "wrong-kind",
					provider: "paypal",
					providerPriceId: "PROD-CREDITS-3000",
					productKind: "PLAN",
					active: true,
					version: 1,
					name: snapshot.packKey,
					creditsPerPeriod: BigInt(snapshot.baseCredits),
					priceMicros: BigInt(snapshot.priceMicros),
					currency: snapshot.currency,
					metadata: {
						productKind: "CREDIT_PACK",
						packKey: snapshot.packKey,
						catalogVersion: snapshot.catalogVersion,
						pricingVersion: snapshot.pricingVersion,
						version: 1,
						expiryMonths: snapshot.expiryMonths,
					},
				},
				"paypal",
				"PROD-CREDITS-3000",
				{ packKey: "credits-3000" },
			),
		).toBe(false);
	});
});
