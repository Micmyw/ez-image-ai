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
describe("Waffo and SeeAPI moderation configuration", () => {
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
