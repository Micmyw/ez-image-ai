import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPlanIdByProviderPriceId, getProviderPriceIdByPlanId } from "./provider-price-ids";

const PROVIDER_ENV_KEYS = [
	"PRICE_ID_CREATOR_MONTHLY",
	"PAYPAL_PLAN_ID_CREATOR_MONTHLY",
	"PAYPAL_PLAN_ID_CREATOR_YEARLY",
	"WAFFO_PRODUCT_ID_CREATOR_MONTHLY",
	"WAFFO_PRODUCT_ID_CREATOR_YEARLY",
] as const;

describe("provider-scoped price mappings", () => {
	const originalValues = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of PROVIDER_ENV_KEYS) {
			originalValues.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROVIDER_ENV_KEYS) {
			const value = originalValues.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("keeps identical provider identifiers isolated by provider", () => {
		process.env.PRICE_ID_CREATOR_MONTHLY = "price_same123";
		process.env.WAFFO_PRODUCT_ID_CREATOR_MONTHLY = "PROD_same123";

		expect(
			getProviderPriceIdByPlanId("stripe", "creator", {
				type: "subscription",
				interval: "month",
			}),
		).toBe("price_same123");
		expect(
			getProviderPriceIdByPlanId("waffo", "creator", {
				type: "subscription",
				interval: "month",
			}),
		).toBe("PROD_same123");
		expect(getPlanIdByProviderPriceId("stripe", "PROD_same123")).toBeNull();
		expect(getPlanIdByProviderPriceId("waffo", "PROD_same123")).toBe("creator");
	});

	it("fails closed for malformed provider identifiers and absent annual Waffo metadata", () => {
		process.env.PAYPAL_PLAN_ID_CREATOR_MONTHLY = "not-a-paypal-plan";
		process.env.WAFFO_PRODUCT_ID_CREATOR_MONTHLY = "not-a-waffo-product";

		expect(
			getProviderPriceIdByPlanId("paypal", "creator", {
				type: "subscription",
				interval: "month",
			}),
		).toBeNull();
		expect(
			getProviderPriceIdByPlanId("waffo", "creator", {
				type: "subscription",
				interval: "month",
			}),
		).toBeNull();
		expect(
			getProviderPriceIdByPlanId("waffo", "creator", {
				type: "subscription",
				interval: "year",
			}),
		).toBeNull();
	});
});
