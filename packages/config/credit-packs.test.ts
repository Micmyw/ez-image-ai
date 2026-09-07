import { describe, expect, it } from "vitest";

import * as clientConfig from "./client";
import * as sharedConfig from "./index";
import * as serverConfig from "./server";

type UnknownFunction = (...args: unknown[]) => unknown;

function exportedFunction(module: object, name: string): UnknownFunction {
	const value = Reflect.get(module, name);
	expect(value, `${name} export`).toBeTypeOf("function");
	return value as UnknownFunction;
}

describe("credit pack catalog", () => {
	it("publishes only the approved browser-safe commercial terms", () => {
		const publicPacks = Reflect.get(clientConfig, "PUBLIC_CREDIT_PACKS");

		expect(publicPacks).toEqual([
			{
				packKey: "credits-1500",
				baseCredits: 1_500,
				subscriberCredits: 1_800,
				subscriberBonusPercent: 20,
				price: { amount: 59, currency: "USD" },
				expiryMonths: 6,
			},
			{
				packKey: "credits-3000",
				baseCredits: 3_000,
				subscriberCredits: 3_600,
				subscriberBonusPercent: 20,
				price: { amount: 109, currency: "USD" },
				expiryMonths: 6,
			},
			{
				packKey: "credits-5000",
				baseCredits: 5_000,
				subscriberCredits: 6_000,
				subscriberBonusPercent: 20,
				price: { amount: 169, currency: "USD" },
				expiryMonths: 6,
			},
			{
				packKey: "credits-8000",
				baseCredits: 8_000,
				subscriberCredits: 9_600,
				subscriberBonusPercent: 20,
				price: { amount: 259, currency: "USD" },
				expiryMonths: 6,
			},
		]);
		expect(Reflect.get(sharedConfig, "PUBLIC_CREDIT_PACKS")).toEqual(publicPacks);
		expect(JSON.stringify(publicPacks)).not.toMatch(
			/provider|model|productId|cost|margin|catalogVersion|pricingVersion/i,
		);
	});

	it("freezes subscriber eligibility and the exact commercial terms in a server snapshot", () => {
		const createSnapshot = exportedFunction(serverConfig, "createCreditPackCheckoutSnapshot");
		const withoutBonus = createSnapshot("credits-1500", false);
		const withBonus = createSnapshot("credits-1500", true);

		expect(withoutBonus).toEqual({
			catalogVersion: "2026-09-06.1",
			pricingVersion: "2026-09-06.1",
			subscriberEligibilityVersion: "2026-09-06.1",
			packKey: "credits-1500",
			baseCredits: 1_500,
			bonusCredits: 0,
			totalCredits: 1_500,
			subscriberBonusEligible: false,
			subscriberBonusPercent: 20,
			priceMicros: 59_000_000,
			currency: "USD",
			expiryMonths: 6,
		});
		expect(withBonus).toMatchObject({
			baseCredits: 1_500,
			bonusCredits: 300,
			totalCredits: 1_800,
			subscriberBonusEligible: true,
		});
		expect(Object.isFrozen(withoutBonus)).toBe(true);
		expect(Object.isFrozen(withBonus)).toBe(true);
	});

	it("uses calendar-month expiry and clamps month-end dates", () => {
		const createSnapshot = exportedFunction(serverConfig, "createCreditPackCheckoutSnapshot");
		const calculateExpiry = exportedFunction(serverConfig, "calculateCreditPackExpiresAt");
		const snapshot = createSnapshot("credits-3000", true);

		expect(
			(calculateExpiry(new Date("2026-08-31T12:34:56.789Z"), snapshot) as Date).toISOString(),
		).toBe("2027-02-28T12:34:56.789Z");
		expect(
			(calculateExpiry(new Date("2027-08-31T12:34:56.789Z"), snapshot) as Date).toISOString(),
		).toBe("2028-02-29T12:34:56.789Z");
	});

	it("keeps the catalog cost quote and Provider-only margin estimates server-only", () => {
		expect(Reflect.has(clientConfig, "CREDIT_PACK_COST_QUOTE")).toBe(false);
		expect(Reflect.has(sharedConfig, "CREDIT_PACK_COST_QUOTE")).toBe(false);

		const quote = Reflect.get(serverConfig, "CREDIT_PACK_COST_QUOTE");
		const estimateMargin = exportedFunction(serverConfig, "estimateCreditPackProviderMargin");
		expect(quote).toEqual({
			usdMicrosPerCredit: 6_096,
			basis: "conservative-standard-full-use",
		});
		expect(estimateMargin("credits-1500", false)).toMatchObject({
			totalCredits: 1_500,
			estimatedCostMicros: 9_144_000,
			estimatedMarginBasisPoints: 8_450,
		});
		expect(estimateMargin("credits-8000", true)).toMatchObject({
			totalCredits: 9_600,
			estimatedCostMicros: 58_521_600,
			estimatedMarginBasisPoints: 7_740,
		});
	});
});
