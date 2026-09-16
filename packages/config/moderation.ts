type Environment = Record<string, string | undefined>;

/** Stable detector identities also bind cached approval evidence to enabled checks. */
export function moderationConfiguration(environment: Environment) {
	const legacy = environment.MEDIA_SAFETY_ADAPTER === "sightengine";
	const configured = environment.MEDIA_SAFETY_ADAPTER === "configured";
	function enabled(key: string, fallback: boolean) {
		if (!configured) return fallback;
		const value = environment[key];
		if (value !== undefined && value !== "true" && value !== "false")
			throw new Error(`Invalid moderation switch: ${key}`);
		return value === "true";
	}
	return {
		textWaffo: enabled(
			"MODERATION_TEXT_WAFFO_ENABLED",
			legacy && environment.WAFFO_ENVIRONMENT === "prod",
		),
		textSightengine: enabled("MODERATION_TEXT_SIGHTENGINE_ENABLED", legacy),
		imageSeeapi: enabled("MODERATION_IMAGE_SEEAPI_ENABLED", false),
		imageSightengine: enabled("MODERATION_IMAGE_SIGHTENGINE_ENABLED", legacy),
	};
}

export function imageModerationProviderForEnvironment(environment: Environment): string {
	if (environment.MEDIA_SAFETY_ADAPTER === "test" || !environment.MEDIA_SAFETY_ADAPTER)
		return "test";
	const config = moderationConfiguration(environment);
	return (
		[config.imageSeeapi ? "seeapi" : "", config.imageSightengine ? "sightengine" : ""]
			.filter(Boolean)
			.join("+") || "unconfigured"
	);
}

export function assertModerationConfiguration(environment: Environment): void {
	const config = moderationConfiguration(environment);
	if (!config.textWaffo && !config.textSightengine)
		throw new Error("At least one text moderation provider must be enabled");
	if (!config.imageSeeapi && !config.imageSightengine)
		throw new Error("At least one image moderation provider must be enabled");
	const required = [
		...(config.textWaffo ? ["WAFFO_MERCHANT_ID", "WAFFO_PRIVATE_KEY"] : []),
		...(config.textSightengine || config.imageSightengine
			? ["SIGHTENGINE_API_USER", "SIGHTENGINE_API_SECRET"]
			: []),
		...(config.imageSeeapi ? ["SEEAPI_API_KEY"] : []),
	];
	for (const key of required)
		if (!environment[key]?.trim()) throw new Error(`Enabled moderation provider requires ${key}`);
}

export const OUTPUT_MODERATION_BILLING_POLICY = "first-block-free-v1";
