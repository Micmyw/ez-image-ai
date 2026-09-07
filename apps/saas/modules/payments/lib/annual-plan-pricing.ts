export interface PlanPrice {
	interval: "month" | "year";
	amount: number;
	currency: string;
}

export interface AnnualBillingPrice {
	total: number;
	monthlyEquivalent: number;
	currency: string;
}

export interface AnnualPlanPricing extends AnnualBillingPrice {
	savings: number;
	savingsPercent: number;
}

export function calculateAnnualBillingPrice(
	prices: readonly PlanPrice[],
): AnnualBillingPrice | null {
	const monthly = prices.find((price) => price.interval === "month");
	const yearly = prices.find((price) => price.interval === "year");
	if (!monthly || !yearly || monthly.currency !== yearly.currency) return null;

	if (
		!Number.isFinite(monthly.amount) ||
		!Number.isFinite(yearly.amount) ||
		monthly.amount <= 0 ||
		yearly.amount <= 0
	) {
		return null;
	}

	return {
		total: yearly.amount,
		monthlyEquivalent: yearly.amount / 12,
		currency: yearly.currency,
	};
}

export function calculateAnnualPlanPricing(prices: readonly PlanPrice[]): AnnualPlanPricing | null {
	const monthly = prices.find((price) => price.interval === "month");
	const annualBilling = calculateAnnualBillingPrice(prices);
	if (!monthly || !annualBilling) return null;

	const twelveMonthlyPayments = monthly.amount * 12;
	const savings = twelveMonthlyPayments - annualBilling.total;
	if (!Number.isFinite(savings) || savings <= 0) return null;

	return {
		...annualBilling,
		savings,
		savingsPercent: Math.round((savings / twelveMonthlyPayments) * 100),
	};
}

export function hasCompleteAnnualBilling(planPrices: readonly (readonly PlanPrice[])[]): boolean {
	return (
		planPrices.length > 0 &&
		planPrices.every((prices) => calculateAnnualBillingPrice(prices) !== null)
	);
}
