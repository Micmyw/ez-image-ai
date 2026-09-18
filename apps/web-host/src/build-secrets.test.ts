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
	it("can add a server-only image scanner credential without rewriting the secret bundle", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
					SEEAPI_API_KEY: "test-key-12345678",
				}),
			),
		).toEqual({ PRIVATE_KEY: "unchanged", SEEAPI_API_KEY: "test-key-12345678" });
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
