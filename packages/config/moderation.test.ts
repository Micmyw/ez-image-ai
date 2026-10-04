import { describe, expect, it } from "vitest";

import {
	imageModerationProviderForEnvironment,
	moderationConfiguration,
	assertModerationConfiguration,
} from "./moderation";
const configured = {
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_TEXT_WAFFO_ENABLED: "true",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
};
const localProductionE2EEnvironment = {
	NODE_ENV: "production",
	E2E_USE_PRODUCTION_BUILD: "true",
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_RUN_ID: "media-e2e-123",
	DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_test",
	TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/media_e2e_test",
	NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
};
describe("Waffo and SeeAPI moderation configuration", () => {
	it("permits the fully guarded local production-build E2E test adapter", () => {
		expect(moderationConfiguration(localProductionE2EEnvironment)).toEqual({
			textWaffo: false,
			imageSeeapi: false,
		});
		expect(imageModerationProviderForEnvironment(localProductionE2EEnvironment)).toBe("test");
	});
	it.each(Object.keys(localProductionE2EEnvironment))(
		"rejects local production-build E2E when %s is missing",
		(key) => {
			const environment = { ...localProductionE2EEnvironment, [key]: undefined };
			expect(() => moderationConfiguration(environment)).toThrow();
			expect(() => imageModerationProviderForEnvironment(environment)).toThrow();
		},
	);
	it.each([
		{ E2E_USE_PRODUCTION_BUILD: "false" },
		{ E2E_TEST_MEDIA_ADAPTERS: "false" },
		{ MEDIA_PROVIDER_ADAPTER: "kie" },
		{ MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false" },
		{ E2E_RUN_ID: "invalid/run" },
		{ TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/other_test" },
		{
			DATABASE_URL: "postgresql://media:media@db.example.com/media_e2e_test",
			TEST_DATABASE_URL: "postgresql://media:media@db.example.com/media_e2e_test",
		},
		{
			DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/production",
			TEST_DATABASE_URL: "postgresql://media:media@127.0.0.1:55432/production",
		},
		{ NEXT_PUBLIC_SAAS_URL: "https://ezpic.ai" },
		{ NEXT_PUBLIC_SAAS_URL: "https://localhost:3000" },
		{ NEXT_PUBLIC_SAAS_URL: "http://localhost:3000/path" },
		{ NEXT_PUBLIC_SAAS_URL: "http://user:password@localhost:3000" },
		{ NEXT_PUBLIC_SAAS_URL: "http://localhost:3000/?query=1" },
		{ NEXT_PUBLIC_SAAS_URL: "http://localhost:3000/#fragment" },
	])("rejects production-build E2E with an invalid isolation condition: %j", (overrides) => {
		const environment = { ...localProductionE2EEnvironment, ...overrides };
		expect(() => moderationConfiguration(environment)).toThrow();
		expect(() => imageModerationProviderForEnvironment(environment)).toThrow();
	});
	it("selects only Waffo and SeeAPI without retired provider credentials", () => {
		expect(moderationConfiguration(configured)).toEqual({ textWaffo: true, imageSeeapi: true });
		expect(imageModerationProviderForEnvironment(configured)).toBe("seeapi");
		expect(() =>
			assertModerationConfiguration({
				...configured,
				SEEAPI_API_KEY: "fixture-seeapi",
				WAFFO_MERCHANT_ID: "fixture-merchant",
				WAFFO_PRIVATE_KEY: "fixture-private",
			}),
		).not.toThrow();
	});
	it("cannot reactivate retired detectors through stale switches", () => {
		expect(
			moderationConfiguration({
				...configured,
				MODERATION_TEXT_SIGHTENGINE_ENABLED: "true",
				MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
			}),
		).toEqual({ textWaffo: true, imageSeeapi: true });
	});
	it.each([undefined, "", "sightengine", "unknown"])(
		"rejects missing or unsupported selector %s",
		(selector) => {
			const environment = { ...configured, MEDIA_SAFETY_ADAPTER: selector };
			expect(() => moderationConfiguration(environment)).toThrow();
			expect(() => imageModerationProviderForEnvironment(environment)).toThrow();
		},
	);
	it.each(["development", "test"])("permits an explicit local test adapter in %s", (nodeEnv) => {
		expect(
			imageModerationProviderForEnvironment({
				NODE_ENV: nodeEnv,
				MEDIA_SAFETY_ADAPTER: "test",
				MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
			}),
		).toBe("test");
	});
	it.each([
		{ NODE_ENV: "production", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
		{ NODE_ENV: undefined, MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true" },
		{ NODE_ENV: "test", MEDIA_ALLOW_TEST_SAFETY_ADAPTER: undefined },
	])("rejects test adapters outside explicitly enabled local environments", (values) => {
		expect(() =>
			imageModerationProviderForEnvironment({ ...values, MEDIA_SAFETY_ADAPTER: "test" }),
		).toThrow();
	});
	it("rejects all-off or missing enabled credentials", () => {
		expect(() => assertModerationConfiguration(configured)).toThrow();
		expect(() =>
			assertModerationConfiguration({ ...configured, MODERATION_IMAGE_SEEAPI_ENABLED: "false" }),
		).toThrow();
		expect(() =>
			imageModerationProviderForEnvironment({
				...configured,
				MODERATION_IMAGE_SEEAPI_ENABLED: "false",
			}),
		).toThrow();
	});
	it.each(["MODERATION_TEXT_WAFFO_ENABLED", "MODERATION_IMAGE_SEEAPI_ENABLED"])(
		"rejects malformed %s",
		(key) => {
			expect(() => moderationConfiguration({ ...configured, [key]: "yes" })).toThrow();
		},
	);
});
