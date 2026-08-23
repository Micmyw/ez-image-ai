import type { PaymentsConfig } from "./types";

export const config: PaymentsConfig = {
	billingAttachedTo: "user",
	requireActiveSubscription: false,
	plans: {
		creator: {
			recommended: true,
			prices: [
				{
					type: "subscription",
					priceId: process.env.PRICE_ID_CREATOR_MONTHLY as string,
					interval: "month",
					amount: 19,
					currency: "USD",
					monthlyCredits: 1_000,
					maximumConcurrentJobs: 3,
					maximumStorageBytes: 100 * 1024 * 1024,
				},
				{
					type: "subscription",
					priceId: process.env.PRICE_ID_CREATOR_YEARLY as string,
					interval: "year",
					amount: 190,
					currency: "USD",
					monthlyCredits: 1_000,
					maximumConcurrentJobs: 3,
					maximumStorageBytes: 100 * 1024 * 1024,
				},
			],
		},
		studio: {
			prices: [
				{
					type: "subscription",
					interval: "month",
					priceId: process.env.PRICE_ID_STUDIO_MONTHLY as string,
					amount: 79,
					currency: "USD",
					monthlyCredits: 5_000,
					maximumConcurrentJobs: 10,
					maximumStorageBytes: 250 * 1024 * 1024,
				},
				{
					type: "subscription",
					interval: "year",
					priceId: process.env.PRICE_ID_STUDIO_YEARLY as string,
					amount: 790,
					currency: "USD",
					monthlyCredits: 5_000,
					maximumConcurrentJobs: 10,
					maximumStorageBytes: 250 * 1024 * 1024,
				},
			],
		},
		enterprise: {
			isEnterprise: true,
		},
	},
};
