import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { readVideoV1Config } from "@repo/config/video-v1";

import { mediaProviderKeySchema, parseMediaEnabledProviders } from "../../../packages/config/env";

type CapacityEvidence =
	| { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" }
	| { code: "PROVIDER_CAPACITY_PREFLIGHT_RETIRED" };

/** Keep runtime transport validation without requiring or certifying the retired capacity.
 * No provider quota or credentials are verified by this preflight. */
export function verifyProviderDispatchCapacity(
	environment: Record<string, string | undefined>,
): CapacityEvidence {
	if (environment.NODE_ENV !== "production" || environment.MEDIA_GENERATION_ENABLED !== "true")
		return { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" };
	try {
		const expanded = expandVideoRuntimeEnvironment(environment);
		const adapter = expanded.MEDIA_PROVIDER_ADAPTER;
		const imageProviders = parseMediaEnabledProviders({
			MEDIA_ENABLED_PROVIDERS: expanded.MEDIA_ENABLED_PROVIDERS,
			MEDIA_PROVIDER_ADAPTER:
				expanded.MEDIA_ENABLED_PROVIDERS !== undefined
					? undefined
					: adapter === undefined || adapter === "mock"
						? adapter
						: mediaProviderKeySchema.parse(adapter),
		});
		if (!imageProviders.includes("kie") && !readVideoV1Config(expanded).enabled)
			return { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" };
	} catch {
		// The policy or provider-list parser must never echo private configuration.
		throw new Error("KIE_PROVIDER_CAPACITY_CONFIGURATION_INVALID");
	}
	return { code: "PROVIDER_CAPACITY_PREFLIGHT_RETIRED" };
}
