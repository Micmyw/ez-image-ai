import { describe, expect, it } from "vitest";

import { getPlanEntitlement, PLAN_ENTITLEMENTS, resolvePlanEntitlement } from "./plans";
import { DEFAULT_PRODUCT_CONFIG } from "./product";
import { getPublicConfig } from "./public";

describe("subscription plan catalog", () => {
	it("does not advertise an unfinished-job quota in account or public plans", () => {
		for (const plan of [...PLAN_ENTITLEMENTS, ...getPublicConfig().plans]) {
			expect(plan).not.toHaveProperty("maximumConcurrentJobs");
		}
	});
	it("publishes the approved paid tiers under stable internal plan IDs", () => {
		expect(DEFAULT_PRODUCT_CONFIG.planIds).toEqual(["free", "creator", "ultimate", "studio"]);
		expect(
			PLAN_ENTITLEMENTS.filter(({ id }) => id !== "free").map(({ id, monthlyCredits, prices }) => ({
				id,
				monthlyCredits,
				prices,
			})),
		).toEqual([
			{
				id: "creator",
				monthlyCredits: 700,
				prices: [
					{ interval: "month", amount: 19, currency: "USD" },
					{ interval: "year", amount: 114, currency: "USD" },
				],
			},
			{
				id: "ultimate",
				monthlyCredits: 1_800,
				prices: [
					{ interval: "month", amount: 49, currency: "USD" },
					{ interval: "year", amount: 294, currency: "USD" },
				],
			},
			{
				id: "studio",
				monthlyCredits: 3_000,
				prices: [
					{ interval: "month", amount: 79, currency: "USD" },
					{ interval: "year", amount: 474, currency: "USD" },
				],
			},
		]);
	});

	it("keeps recurring annual prices at half of twelve monthly payments", () => {
		for (const plan of PLAN_ENTITLEMENTS.filter(({ id }) => id !== "free")) {
			const monthly = plan.prices.find(({ interval }) => interval === "month");
			const yearly = plan.prices.find(({ interval }) => interval === "year");

			expect(monthly, `${plan.id} monthly price`).toBeDefined();
			expect(yearly, `${plan.id} yearly price`).toBeDefined();
			expect(yearly?.amount).toBe(monthly!.amount * 12 * 0.5);
			expect(Math.round((1 - yearly!.amount / (monthly!.amount * 12)) * 100)).toBe(50);
		}
	});

	it("resolves Ultimate from its stable ID and public plan name", () => {
		const getByString = getPlanEntitlement as unknown as (planId: string) => {
			id: string;
			monthlyCredits: number;
		};

		expect(getByString("ultimate")).toMatchObject({
			id: "ultimate",
			monthlyCredits: 1_800,
		});
		expect(resolvePlanEntitlement({ planId: "ultimate" }, undefined).id).toBe("ultimate");
		expect(resolvePlanEntitlement(undefined, "Ultimate").id).toBe("ultimate");
		expect(resolvePlanEntitlement(undefined, "Pro").id).toBe("creator");
		expect(resolvePlanEntitlement(undefined, "Max").id).toBe("studio");
	});
});
