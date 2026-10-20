import { parseEnv } from "node:util";

import { describe, expect, it } from "vitest";

import { readCloudflareBuildEnvironment, withoutCloudflareBuildSecrets } from "./build-secrets";

const bindings = {
	PAYPAL_PLAN_ID_CREATOR_YEARLY: "P-ANNUAL50CREATOR20261020",
	PAYPAL_PLAN_ID_ULTIMATE_YEARLY: "P-ANNUAL50ULTIMATE20261020",
	PAYPAL_PLAN_ID_STUDIO_YEARLY: "P-ANNUAL50STUDIO20261020",
	WAFFO_PRODUCT_ID_CREATOR_YEARLY: `PROD_${"a".repeat(22)}`,
	WAFFO_PRODUCT_ID_ULTIMATE_YEARLY: `PROD_${"b".repeat(22)}`,
	WAFFO_PRODUCT_ID_STUDIO_YEARLY: `PROD_${"c".repeat(22)}`,
};
const source = [
	"# preserve source and unrelated private values",
	"PAYPAL_ENVIRONMENT=live",
	"WAFFO_ENVIRONMENT=prod",
	"PRIVATE_VALUE='fixture # 中文'",
	"PAYPAL_PLAN_ID_CREATOR_MONTHLY=P-EXISTINGMONTHLY",
	"WAFFO_PRODUCT_ID_CREATOR_MONTHLY=PROD_existingmonthlyfixture",
	...Object.keys(bindings).map((key) => `${key}=old-${key}`),
].join("\n");

describe("annual provider binding rollout", () => {
	it("replaces all six annual mappings while preserving monthly mappings and every other value", () => {
		const result = readCloudflareBuildEnvironment({
			CLOUDFLARE_PRODUCTION_ENV: source,
			ANNUAL_PLAN_BINDINGS: JSON.stringify(bindings),
		});
		const parsed = parseEnv(result);
		expect(parsed).toMatchObject(bindings);
		for (const [key, value] of Object.entries(parseEnv(source))) {
			if (!(key in bindings)) expect(parsed[key]).toBe(value);
		}
		expect(result.startsWith(source)).toBe(true);
		expect(Object.keys(parsed).sort()).toEqual(Object.keys(parseEnv(source)).sort());
	});

	it("preserves the exact source without the dedicated override", () => {
		expect(readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source })).toBe(source);
	});

	it.each([
		{},
		{ ...bindings, WAFFO_PRODUCT_ID_CREATOR_YEARLY: undefined },
		{ ...bindings, PAYPAL_CLIENT_SECRET: "fixture-never-print" },
		{ ...bindings, WAFFO_PRODUCT_ID_CREATOR_YEARLY: "PROD_bad\nBILLING_ENABLED=false" },
		{ ...bindings, PAYPAL_PLAN_ID_CREATOR_YEARLY: "wrong-provider-id" },
		{ ...bindings, WAFFO_PRODUCT_ID_STUDIO_YEARLY: bindings.WAFFO_PRODUCT_ID_CREATOR_YEARLY },
		{ ...bindings, PAYPAL_PLAN_ID_STUDIO_YEARLY: bindings.PAYPAL_PLAN_ID_CREATOR_YEARLY },
		[],
		null,
	])(
		"rejects incomplete, extraneous or invalid bindings without exposing their contents",
		(input) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: source,
					ANNUAL_PLAN_BINDINGS: JSON.stringify(input),
				}),
			).toThrow(/^CLOUDFLARE_ANNUAL_PLAN_BINDINGS_INVALID$/);
		},
	);

	it("rejects sandbox sources instead of applying production IDs", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source.replace(
					"WAFFO_ENVIRONMENT=prod",
					"WAFFO_ENVIRONMENT=test",
				),
				ANNUAL_PLAN_BINDINGS: JSON.stringify(bindings),
			}),
		).toThrow(/^CLOUDFLARE_ANNUAL_PLAN_BINDINGS_INVALID$/);
	});

	it("keeps the private build control out of child build environments", () => {
		expect(
			withoutCloudflareBuildSecrets({
				ANNUAL_PLAN_BINDINGS: JSON.stringify(bindings),
				NEXT_PUBLIC_SITE_NAME: "EzPic",
			}),
		).toEqual({ NEXT_PUBLIC_SITE_NAME: "EzPic" });
	});
});
