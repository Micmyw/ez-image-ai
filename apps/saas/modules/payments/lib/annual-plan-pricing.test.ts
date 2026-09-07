import { describe, expect, it } from "vitest";

import {
	calculateAnnualBillingPrice,
	calculateAnnualPlanPricing,
	hasCompleteAnnualBilling,
} from "./annual-plan-pricing";

describe("annual plan pricing", () => {
	it("shows the real annual total and savings against twelve monthly payments", () => {
		expect(
			calculateAnnualPlanPricing([
				{ interval: "month", amount: 19, currency: "USD" },
				{ interval: "year", amount: 190, currency: "USD" },
			]),
		).toEqual({
			total: 190,
			monthlyEquivalent: 190 / 12,
			savings: 38,
			savingsPercent: 17,
			currency: "USD",
		});
		expect(
			calculateAnnualPlanPricing([
				{ interval: "month", amount: 79, currency: "USD" },
				{ interval: "year", amount: 790, currency: "USD" },
			]),
		).toEqual({
			total: 790,
			monthlyEquivalent: 790 / 12,
			savings: 158,
			savingsPercent: 17,
			currency: "USD",
		});
	});

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
			{ interval: "year" as const, amount: 190, currency: "USD" },
		];
		const studioMonthlyOnly = [{ interval: "month" as const, amount: 79, currency: "USD" }];

		expect(hasCompleteAnnualBilling([creatorPrices, studioMonthlyOnly])).toBe(false);
		expect(
			hasCompleteAnnualBilling([
				creatorPrices,
				[
					{ interval: "month", amount: 79, currency: "USD" },
					{ interval: "year", amount: 790, currency: "USD" },
				],
			]),
		).toBe(true);
		expect(hasCompleteAnnualBilling([])).toBe(false);
	});
});
