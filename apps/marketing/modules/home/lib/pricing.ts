import { PLAN_ENTITLEMENTS } from "@repo/config/client";
import { config as paymentsConfig } from "@repo/payments/config";
import type { PaidPlan } from "@repo/payments/types";

export interface MarketingCheckoutAvailability {
	creator: Record<"month" | "year", boolean>;
	studio: Record<"month" | "year", boolean>;
}

export const unavailableMarketingCheckout: MarketingCheckoutAvailability = {
	creator: { month: false, year: false },
	studio: { month: false, year: false },
};

export function getMarketingCheckoutAvailability(): MarketingCheckoutAvailability {
	const isConfigured = (planId: "creator" | "studio", interval: "month" | "year") => {
		const plan = paymentsConfig.plans[planId];
		if (!plan || !("prices" in plan)) return false;
		const configuredPrice = (plan as PaidPlan).prices.find(
			(price) => price.type === "subscription" && price.interval === interval,
		);
		const entitlementPrice = PLAN_ENTITLEMENTS.find(({ id }) => id === planId)?.prices.find(
			(price) => price.interval === interval,
		);
		return Boolean(
			configuredPrice?.priceId &&
			entitlementPrice &&
			configuredPrice.amount === entitlementPrice.amount &&
			configuredPrice.currency === entitlementPrice.currency,
		);
	};

	return {
		creator: {
			month: isConfigured("creator", "month"),
			year: isConfigured("creator", "year"),
		},
		studio: {
			month: isConfigured("studio", "month"),
			year: isConfigured("studio", "year"),
		},
	};
}
