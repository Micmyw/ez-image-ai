import { DEFAULT_PRODUCT_CONFIG, getPlanEntitlement } from "@repo/config";
import { createCreditPackCheckoutSnapshot } from "@repo/config/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.stubEnv("BILLING_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

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
	it.each(["subscription", "credit-pack"])(
		"awaits merchant readiness for %s and opens Waffo after approval",
		async (kind) => {
			let approved = false;
			const isCheckoutAvailable = vi.fn(
				async (provider: string) => provider === "paypal" || approved,
			);
			const pack = createCreditPackCheckoutSnapshot("credits-1500", false);
			const findBillingPlan = vi.fn(async (provider: string, providerPriceId: string) => ({
				id: `${provider}-plan`,
				provider,
				providerPriceId,
				active: true,
				version: 1,
				productKind: kind === "subscription" ? ("PLAN" as const) : ("CREDIT_PACK" as const),
				name: kind === "subscription" ? "creator" : "credits-1500",
				creditsPerPeriod: kind === "subscription" ? 700n : BigInt(pack.baseCredits),
				priceMicros: kind === "subscription" ? 19_000_000n : BigInt(pack.priceMicros),
				currency: "USD",
				metadata:
					kind === "subscription"
						? {
								planId: "creator",
								interval: "month",
								version: 1,
								pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
							}
						: {
								version: 1,
								productKind: "CREDIT_PACK",
								packKey: "credits-1500",
								catalogVersion: pack.catalogVersion,
								pricingVersion: pack.pricingVersion,
								expiryMonths: pack.expiryMonths,
							},
			}));
			const resolve = () =>
				kind === "subscription"
					? resolveProviderAvailability(
							{ planId: "creator", interval: "month" },
							{ isCheckoutAvailable, getProviderPriceId: () => "product", findBillingPlan },
						)
					: resolveCreditPackProviderAvailability(
							{ packKey: "credits-1500" },
							{ isCheckoutAvailable, getProviderProductId: () => "product", findBillingPlan },
						);
			expect((await resolve()).map((provider) => provider.name)).toEqual(["paypal"]);
			approved = true;
			expect((await resolve()).map((provider) => provider.name)).toEqual(["paypal", "waffo"]);
		},
	);

	it("rejects an unmarked or sandbox plan snapshot when collecting live money", () => {
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		const plan = {
			id: "plan",
			provider: "paypal",
			providerPriceId: "P-CREATOR-MONTHLY",
			productKind: "PLAN" as const,
			active: true,
			version: 1,
			name: "creator",
			creditsPerPeriod: 700n,
			priceMicros: 19000000n,
			currency: "USD",
			metadata: {
				planId: "creator",
				interval: "month",
				version: 1,
				pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
			},
		};
		expect(
			isExactBillingPlanSnapshot(plan, "paypal", plan.providerPriceId, {
				planId: "creator",
				interval: "month",
			}),
		).toBe(false);
		expect(
			isExactBillingPlanSnapshot(
				{ ...plan, metadata: { ...plan.metadata, providerEnvironment: "sandbox" } },
				"paypal",
				plan.providerPriceId,
				{ planId: "creator", interval: "month" },
			),
		).toBe(false);
		expect(
			isExactBillingPlanSnapshot(
				{ ...plan, metadata: { ...plan.metadata, providerEnvironment: "live" } },
				"paypal",
				plan.providerPriceId,
				{ planId: "creator", interval: "month" },
			),
		).toBe(true);
	});
	it("hides both subscription and pack payment methods while collection is disabled", async () => {
		vi.stubEnv("BILLING_ENABLED", "false");
		const findBillingPlan = vi.fn();
		expect(
			await resolveProviderAvailability(
				{ planId: "creator", interval: "month" },
				{ isCheckoutAvailable: () => true, getProviderPriceId: () => "P-PLAN", findBillingPlan },
			),
		).toEqual([]);
		expect(
			await resolveCreditPackProviderAvailability(
				{ packKey: "credits-1500" },
				{
					isCheckoutAvailable: () => true,
					getProviderProductId: () => "PROD-PACK",
					findBillingPlan,
				},
			),
		).toEqual([]);
		expect(findBillingPlan).not.toHaveBeenCalled();
	});
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
					isCheckoutAvailable: (provider) => provider !== "waffo",
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
					isCheckoutAvailable: () => true,
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
				pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
				...(drift.pricingVersion ? { billingPricingVersion: drift.pricingVersion } : {}),
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
					isCheckoutAvailable: () => true,
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
