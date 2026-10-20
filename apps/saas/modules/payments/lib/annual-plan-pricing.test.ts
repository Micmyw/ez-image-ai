import { getPlanEntitlement } from "@repo/config/client";
import { describe, expect, it } from "vitest";

import {
	calculateAnnualBillingPrice,
	calculateAnnualPlanPricing,
	hasCompleteAnnualBilling,
} from "./annual-plan-pricing";

describe("annual plan pricing", () => {
	it.each([
		{ planId: "creator" as const, total: 114, monthlyEquivalent: 9.5 },
		{ planId: "ultimate" as const, total: 294, monthlyEquivalent: 24.5 },
		{ planId: "studio" as const, total: 474, monthlyEquivalent: 39.5 },
	])(
		"shows $planId annual total and 50 percent savings against twelve monthly payments",
		(plan) => {
			expect(calculateAnnualPlanPricing(getPlanEntitlement(plan.planId).prices)).toEqual({
				total: plan.total,
				monthlyEquivalent: plan.monthlyEquivalent,
				savings: plan.total,
				savingsPercent: 50,
				currency: "USD",
			});
		},
	);

	it("omits an annual summary when either billing cadence is unavailable", () => {
		expect(calculateAnnualPlanPricing([])).toBeNull();
		expect(
			calculateAnnualPlanPricing([{ interval: "month", amount: 19, currency: "USD" }]),
		).toBeNull();
	});

	it("recognizes annual billing separately from a positive discount", () => {
		const prices = [
			{ interval: "month" as const, amount: 19, currency: "USD" },
			{ interval: "year" as const, amount: 228, currency: "USD" },
		];

		expect(calculateAnnualBillingPrice(prices)).toEqual({
			total: 228,
			monthlyEquivalent: 19,
			currency: "USD",
		});
		expect(calculateAnnualPlanPricing(prices)).toBeNull();
	});

	it("requires annual billing for every billable plan before showing a shared cadence", () => {
		const creatorPrices = [
			{ interval: "month" as const, amount: 19, currency: "USD" },
			{ interval: "year" as const, amount: 114, currency: "USD" },
		];
		const studioMonthlyOnly = [{ interval: "month" as const, amount: 79, currency: "USD" }];

		expect(hasCompleteAnnualBilling([creatorPrices, studioMonthlyOnly])).toBe(false);
		expect(
			hasCompleteAnnualBilling([
				creatorPrices,
				[
					{ interval: "month", amount: 79, currency: "USD" },
					{ interval: "year", amount: 474, currency: "USD" },
				],
			]),
		).toBe(true);
		expect(hasCompleteAnnualBilling([])).toBe(false);
	});
});
