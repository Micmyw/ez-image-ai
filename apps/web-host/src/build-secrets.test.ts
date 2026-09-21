import { parseEnv } from "node:util";

import { describe, expect, it } from "vitest";

import {
	packCloudflareBuildEnvironment,
	readCloudflareBuildEnvironment,
	withoutCloudflareBuildSecrets,
} from "./build-secrets";

const unpackValues = (variables: ReturnType<typeof packCloudflareBuildEnvironment>) =>
	Object.fromEntries(Object.entries(variables).map(([key, item]) => [key, item.value]));

describe("Cloudflare build secret transport", () => {
	it("updates the public brand without replacing unrelated production configuration", () => {
		const source = "PRIVATE_KEY=unchanged\nNEXT_PUBLIC_SITE_NAME=EzPic\nBILLING_ENABLED=true\n";
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					...unpackValues(packCloudflareBuildEnvironment(source)),
					NEXT_PUBLIC_SITE_NAME: "EzImageAI",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			NEXT_PUBLIC_SITE_NAME: "EzImageAI",
			BILLING_ENABLED: "true",
		});
	});
	it.each(["", "EzImageAI\nPRIVATE_KEY=changed", '"EzImageAI"', "x".repeat(101)])(
		"rejects an invalid public brand override: %s",
		(brand) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
					NEXT_PUBLIC_SITE_NAME: brand,
				}),
			).toThrow("CLOUDFLARE_PUBLIC_BRAND_OVERRIDE_INVALID");
		},
	);
	it("supports an explicit paired unlimited override and preserves unrelated production secrets", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV:
						"PRIVATE_KEY=unchanged\nGUEST_RISK_BUDGET_MICROS=200000\nGUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: "unlimited",
					GUEST_HARD_BUDGET_MICROS: "unlimited",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			GUEST_RISK_BUDGET_MICROS: "unlimited",
			GUEST_HARD_BUDGET_MICROS: "unlimited",
		});
	});
	it("rejects a partial unlimited build override", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV:
					"GUEST_RISK_BUDGET_MICROS=200000\nGUEST_HARD_BUDGET_MICROS=200000\n",
				GUEST_HARD_BUDGET_MICROS: "unlimited",
			}),
		).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
	});
	it("updates the guest risk budget within the existing hard cap without changing other secrets", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV:
						"PRIVATE_KEY=unchanged\nGUEST_RISK_BUDGET_MICROS=40000\nGUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: "200000",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			GUEST_RISK_BUDGET_MICROS: "200000",
			GUEST_HARD_BUDGET_MICROS: "200000",
		});
	});
	it.each(["0", "-1", "200001", "unlimited", "200000\nPRIVATE_KEY=changed"])(
		"rejects invalid or excessive guest budget overrides: %s",
		(budget) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "GUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: budget,
					GUEST_HARD_BUDGET_MICROS: "999999999",
				}),
			).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
		},
	);
	it("requires an existing hard cap before accepting a guest budget override", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
				GUEST_RISK_BUDGET_MICROS: "200000",
			}),
		).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
	});
	it("overrides only the three daily guest limits without rewriting production secrets", () => {
		const limits = {
			GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_IP_MAX_PER_10_MINUTES: "2",
		};
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\nGUEST_IP_MAX_PER_10_MINUTES=1\n",
					...limits,
				}),
			),
		).toEqual({ PRIVATE_KEY: "unchanged", ...limits });
	});
	it("rejects partial or excessive daily guest overrides", () => {
		for (const limits of [
			{ GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2" },
			{
				GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "3",
				GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
				GUEST_IP_MAX_PER_10_MINUTES: "2",
			},
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
					...limits,
				}),
			).toThrow("CLOUDFLARE_GUEST_QUOTA_OVERRIDES_INVALID");
		}
	});
	it.each(["test", "sightengine"])(
		"ignores an ambient %s adapter unless configured moderation overrides are requested",
		(adapter) => {
			const source = "MEDIA_SAFETY_ADAPTER=sightengine\nPRIVATE_KEY=unchanged\n";
			expect(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: source,
					MEDIA_SAFETY_ADAPTER: adapter,
				}),
			).toBe(source);
		},
	);
	it("can add a server-only image scanner credential without rewriting the secret bundle", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
					SEEAPI_API_KEY: "x".repeat(16),
				}),
			),
		).toEqual({ PRIVATE_KEY: "unchanged", SEEAPI_API_KEY: "x".repeat(16) });
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
				SEEAPI_API_KEY: "key\nOTHER=value",
			}),
		).toThrow("CLOUDFLARE_SEEAPI_KEY_INVALID");
	});
	it("refuses partial switches or disabling every detector", () => {
		for (const overrides of [
			{ MEDIA_SAFETY_ADAPTER: "configured" },
			{
				MEDIA_SAFETY_ADAPTER: "configured",
				MODERATION_TEXT_WAFFO_ENABLED: "false",
				MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
				MODERATION_IMAGE_SEEAPI_ENABLED: "true",
				MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
			},
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
					...overrides,
				}),
			).toThrow("CLOUDFLARE_MODERATION_OVERRIDES_INVALID");
		}
	});
	it("applies explicit moderation switches without replacing unrelated production secrets", () => {
		const source = "MEDIA_SAFETY_ADAPTER=sightengine\nPRIVATE_KEY=unchanged\n";
		const switches = {
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
		};
		expect(
			parseEnv(readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source, ...switches })),
		).toEqual({ PRIVATE_KEY: "unchanged", ...switches });
	});
	it("keeps existing short dotenv secrets compatible", () => {
		const source = "NEXT_PUBLIC_SAAS_URL=https://ezimageai.com\nPRIVATE_KEY=example\n";
		const variables = packCloudflareBuildEnvironment(source);
		expect(Object.keys(variables)).toEqual(["CLOUDFLARE_PRODUCTION_ENV"]);
		expect(readCloudflareBuildEnvironment(unpackValues(variables))).toBe(source);
		expect(() => readCloudflareBuildEnvironment({})).toThrow("CLOUDFLARE_BUILD_SECRET_REQUIRED");
	});

	it("fits long Unicode dotenv content within Cloudflare's per-variable limit", () => {
		const source = `PRIVATE_VALUE="${"中文🌄\\nquoted text ".repeat(1000)}"\n`;
		const variables = packCloudflareBuildEnvironment(source);
		expect(Object.keys(variables).length).toBeGreaterThan(2);
		for (const variable of Object.values(variables)) {
			expect(variable.is_secret).toBe(true);
			expect(variable.value.length).toBeLessThanOrEqual(5000);
			expect(Buffer.from(variable.value, "utf8").toString("utf8")).toBe(variable.value);
		}
		expect(readCloudflareBuildEnvironment(unpackValues(variables))).toBe(source);
	});

	it("rejects incomplete or mixed secrets before use without echoing their values", () => {
		const environment = unpackValues(packCloudflareBuildEnvironment("sensitive".repeat(1000)));
		const missing = { ...environment };
		delete missing.CLOUDFLARE_PRODUCTION_ENV_PART_2;
		expect(() => readCloudflareBuildEnvironment(missing)).toThrow(
			"CLOUDFLARE_BUILD_SECRET_PART_INVALID: 2",
		);
		expect(() =>
			readCloudflareBuildEnvironment({
				...environment,
				CLOUDFLARE_PRODUCTION_ENV_PART_2: "private-replacement",
			}),
		).toThrow("CLOUDFLARE_BUILD_SECRET_CHECKSUM_MISMATCH");
	});

	it("bounds manifests and refuses oversized inputs", () => {
		for (const source of ["parts:0:bad", `parts:17:${"a".repeat(64)}`, "parts:2:bad"]) {
			expect(() => readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source })).toThrow(
				"CLOUDFLARE_BUILD_SECRET_MANIFEST_INVALID",
			);
		}
		expect(() => packCloudflareBuildEnvironment("a".repeat(72001))).toThrow(
			"CLOUDFLARE_BUILD_SECRET_TOO_LARGE",
		);
	});

	it("removes every secret part from subprocess environments while preserving deployment auth", () => {
		const environment = {
			...unpackValues(packCloudflareBuildEnvironment("private-data".repeat(1000))),
			CLOUDFLARE_PRODUCTION_ENV_PART_16: "stale-part",
			CLOUDFLARE_API_TOKEN: "deployment-token",
			SEEAPI_API_KEY: "private-image-scanner-key",
			PATH: "tools",
		};
		expect(withoutCloudflareBuildSecrets(environment)).toEqual({
			CLOUDFLARE_API_TOKEN: "deployment-token",
			PATH: "tools",
		});
		expect(environment.CLOUDFLARE_PRODUCTION_ENV_PART_16).toBe("stale-part");
	});
});
