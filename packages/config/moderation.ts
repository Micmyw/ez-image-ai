import { isLocalProductionBuildE2EEnvironment } from "./guest-media";

type Environment = Record<string, string | undefined>;

/** Stable detector identities bind cached approval evidence to enabled checks. */
export function moderationConfiguration(environment: Environment) {
	if (environment.MEDIA_SAFETY_ADAPTER === "test") {
		assertTestModerationConfiguration(environment);
		return { textWaffo: false, imageSeeapi: false };
	}
	if (environment.MEDIA_SAFETY_ADAPTER !== "configured")
		throw new Error("MODERATION_CONFIGURATION_ERROR");
	function enabled(key: string) {
		const value = environment[key];
		if (value !== undefined && value !== "true" && value !== "false")
			throw new Error(`Invalid moderation switch: ${key}`);
		return value === "true";
	}
	return {
		textWaffo: enabled("MODERATION_TEXT_WAFFO_ENABLED"),
		imageSeeapi: enabled("MODERATION_IMAGE_SEEAPI_ENABLED"),
	};
}

/** Test evidence is valid only with explicit local environment and adapter opt-ins. */
export function assertTestModerationConfiguration(environment: Environment): void {
	if (
		environment.MEDIA_SAFETY_ADAPTER !== "test" ||
		environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER !== "true"
	)
		throw new Error("TEST_SAFETY_ADAPTER_DISABLED");
	if (
		environment.NODE_ENV !== "test" &&
		environment.NODE_ENV !== "development" &&
		!isLocalProductionBuildE2EEnvironment(environment)
	)
		throw new Error(
			"The test safety adapter is forbidden outside explicit local environments, including production",
		);
}

export function imageModerationProviderForEnvironment(environment: Environment): string {
	if (environment.MEDIA_SAFETY_ADAPTER === "test") {
		assertTestModerationConfiguration(environment);
		return "test";
	}
	if (!moderationConfiguration(environment).imageSeeapi)
		throw new Error("IMAGE_MODERATION_CONFIGURATION_ERROR");
	return "seeapi";
}

export function assertModerationConfiguration(environment: Environment): void {
	const config = moderationConfiguration(environment);
	if (!config.textWaffo) throw new Error("Waffo text moderation must be enabled");
	if (!config.imageSeeapi) throw new Error("SeeAPI image moderation must be enabled");
	for (const key of ["WAFFO_MERCHANT_ID", "WAFFO_PRIVATE_KEY", "SEEAPI_API_KEY"])
		if (!environment[key]?.trim()) throw new Error(`Enabled moderation provider requires ${key}`);
}

export const OUTPUT_MODERATION_BILLING_POLICY = "first-block-free-v1";
