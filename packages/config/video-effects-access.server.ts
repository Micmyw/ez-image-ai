import { canAccessVideoV1, readVideoV1Config, type VideoV1Environment } from "./video-v1";

export type VideoEffectAccessScope = "internal" | "authenticated";

/** Only this template's server setting can widen its audience; malformed values stay closed. */
export function readVideoEffectAccessScope(
	environment: VideoV1Environment,
): VideoEffectAccessScope | null {
	const scope = environment.HOTEL_LOBBY_DUO_ACCESS ?? "internal";
	return scope === "internal" || scope === "authenticated" ? scope : null;
}

export function canAccessVideoEffect(
	environment: VideoV1Environment,
	user: { id: string; role?: string | null; isAnonymous?: boolean | null } | null | undefined,
): boolean {
	const config = readVideoV1Config(environment);
	if (
		!user?.id ||
		user.isAnonymous ||
		!config.enabled ||
		environment.HOTEL_LOBBY_DUO_ENABLED !== "true"
	)
		return false;
	const scope = readVideoEffectAccessScope(environment);
	return scope === "authenticated" || (scope === "internal" && canAccessVideoV1(config, user));
}
