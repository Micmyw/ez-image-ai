import { describe, expect, it } from "vitest";

import {
	imageModerationProviderForEnvironment,
	moderationConfiguration,
	assertModerationConfiguration,
} from "./moderation";
const configured = {
	MEDIA_SAFETY_ADAPTER: "configured",
	MODERATION_TEXT_WAFFO_ENABLED: "true",
	MODERATION_TEXT_SIGHTENGINE_ENABLED: "false",
	MODERATION_IMAGE_SEEAPI_ENABLED: "true",
	MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
};
describe("independent moderation switches", () => {
	it("selects Waffo and SeeAPI without requiring disabled Sightengine credentials", () => {
		expect(moderationConfiguration(configured)).toMatchObject({
			textWaffo: true,
			textSightengine: false,
			imageSeeapi: true,
			imageSightengine: false,
		});
		expect(imageModerationProviderForEnvironment(configured)).toBe("seeapi");
		expect(() =>
			assertModerationConfiguration({
				...configured,
				SEEAPI_API_KEY: "secret",
				WAFFO_ENVIRONMENT: "prod",
				WAFFO_MERCHANT_ID: "merchant",
				WAFFO_PRIVATE_KEY: "private",
			}),
		).not.toThrow();
	});
	it("changes evidence identity when a second image detector is enabled", () => {
		expect(
			imageModerationProviderForEnvironment({
				...configured,
				MODERATION_IMAGE_SIGHTENGINE_ENABLED: "true",
			}),
		).toBe("seeapi+sightengine");
	});
	it("rejects all-off or missing enabled credentials", () => {
		expect(() => assertModerationConfiguration(configured)).toThrow();
		expect(() =>
			assertModerationConfiguration({ ...configured, MODERATION_IMAGE_SEEAPI_ENABLED: "false" }),
		).toThrow();
	});
});
