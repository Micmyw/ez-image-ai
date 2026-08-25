import { getPlanEntitlement } from "@repo/config";

import type { PaymentsConfig } from "./types";

const STRIPE_PRICE_ID = /^price_[A-Za-z0-9]+$/;
const PRICE_ENVIRONMENT_KEYS = {
	creator: {
		month: "PRICE_ID_CREATOR_MONTHLY",
		year: "PRICE_ID_CREATOR_YEARLY",
	},
	studio: {
		month: "PRICE_ID_STUDIO_MONTHLY",
		year: "PRICE_ID_STUDIO_YEARLY",
	},
} as const;

function stripePriceId(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	return candidate && STRIPE_PRICE_ID.test(candidate) ? candidate : undefined;
}

function subscriptionPrices(planId: "creator" | "studio") {
	const entitlement = getPlanEntitlement(planId);
	return entitlement.prices.map((price) => ({
		type: "subscription" as const,
		...price,
		priceId: stripePriceId(process.env[PRICE_ENVIRONMENT_KEYS[planId][price.interval]]),
	}));
}

export const config: PaymentsConfig = {
	billingAttachedTo: "user",
	requireActiveSubscription: false,
	plans: {
		creator: {
			recommended: true,
			prices: subscriptionPrices("creator"),
		},
		studio: {
			prices: subscriptionPrices("studio"),
		},
	},
};
