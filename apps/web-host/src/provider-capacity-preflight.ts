import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { readVideoV1Config } from "@repo/config/video-v1";

import { parseMediaEnabledProviders } from "../../../packages/config/env";
import { configuredSharedKieCapacity } from "../../../packages/database/prisma/queries/media/shared-provider-capacity";

type CapacityEvidence =
	| { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" }
	| { code: "KIE_PROVIDER_CAPACITY_PREFLIGHT_OK"; capacity: number };

/** Pure check of the same authoritative policy used at the paid-send fence.
 * This verifies configuration only, never credentials or provider quota. */
export function verifyProviderDispatchCapacity(
	environment: Record<string, string | undefined>,
): CapacityEvidence {
	if (environment.NODE_ENV !== "production" || environment.MEDIA_GENERATION_ENABLED !== "true")
		return { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" };
	let capacity: number | null;
	try {
		const expanded = expandVideoRuntimeEnvironment(environment);
		const imageProviders = parseMediaEnabledProviders(expanded);
		if (!imageProviders.includes("kie") && !readVideoV1Config(expanded).enabled)
			return { code: "PROVIDER_CAPACITY_PREFLIGHT_INACTIVE" };
		capacity = configuredSharedKieCapacity(expanded);
	} catch {
		// The policy or provider-list parser must never echo private configuration.
		throw new Error("KIE_PROVIDER_CAPACITY_CONFIGURATION_INVALID");
	}
	if (capacity === null) throw new Error("KIE_PROVIDER_CAPACITY_REQUIRED");
	return { code: "KIE_PROVIDER_CAPACITY_PREFLIGHT_OK", capacity };
}
