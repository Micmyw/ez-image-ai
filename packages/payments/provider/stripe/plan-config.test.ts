import { afterEach, describe, expect, it, vi } from "vitest";

const PRICE_ENV_KEYS = [
	"PRICE_ID_CREATOR_MONTHLY",
	"PRICE_ID_CREATOR_YEARLY",
	"PRICE_ID_STUDIO_MONTHLY",
	"PRICE_ID_STUDIO_YEARLY",
] as const;

describe("EzPic Stripe plan configuration", () => {
	afterEach(() => {
		for (const key of PRICE_ENV_KEYS) delete process.env[key];
		vi.resetModules();
	});

	it("keeps checkout unavailable when a Price ID is missing or malformed", async () => {
		process.env.PRICE_ID_CREATOR_MONTHLY = "not-a-stripe-price";
		const { config } = await import("../../config");
		const creator = config.plans.creator;

		expect("prices" in creator && creator.prices).toEqual([
			expect.objectContaining({ interval: "month", amount: 19, priceId: undefined }),
			expect.objectContaining({ interval: "year", amount: 190, priceId: undefined }),
		]);
	});

	it("maps only environment-backed Stripe Price IDs onto the canonical prices", async () => {
		process.env.PRICE_ID_CREATOR_MONTHLY = "price_CreatorMonthly123";
		process.env.PRICE_ID_CREATOR_YEARLY = "price_CreatorYearly123";
		process.env.PRICE_ID_STUDIO_MONTHLY = "price_StudioMonthly123";
		process.env.PRICE_ID_STUDIO_YEARLY = "price_StudioYearly123";
		const { config } = await import("../../config");

		expect(config.plans).toMatchObject({
			creator: {
				prices: [
					{ interval: "month", amount: 19, priceId: "price_CreatorMonthly123" },
					{ interval: "year", amount: 190, priceId: "price_CreatorYearly123" },
				],
			},
			studio: {
				prices: [
					{ interval: "month", amount: 79, priceId: "price_StudioMonthly123" },
					{ interval: "year", amount: 790, priceId: "price_StudioYearly123" },
				],
			},
		});
	});
});
