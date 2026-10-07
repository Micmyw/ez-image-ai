import { HOTEL_LOBBY_EFFECT_ID, type VideoEffectId } from "./video-effects";
import { canAccessInternalVideoV1, readVideoV1Config, type VideoV1Environment } from "./video-v1";

export type VideoEffectAccessScope = "internal" | "authenticated";

/** Only this template's server setting can widen its audience; malformed values stay closed. */
export function readVideoEffectAccessScope(
	environment: VideoV1Environment,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
): VideoEffectAccessScope | null {
	const scope =
		environment[
			effectId === HOTEL_LOBBY_EFFECT_ID ? "HOTEL_LOBBY_DUO_ACCESS" : "RAINDANCE_ACCESS"
		] ?? "internal";
	return scope === "internal" || scope === "authenticated" ? scope : null;
}

export function canAccessVideoEffect(
	environment: VideoV1Environment,
	user: { id: string; role?: string | null; isAnonymous?: boolean | null } | null | undefined,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
): boolean {
	const config = readVideoV1Config(environment);
	if (
		!user?.id ||
		user.isAnonymous ||
		!config.enabled ||
		environment[
			effectId === HOTEL_LOBBY_EFFECT_ID ? "HOTEL_LOBBY_DUO_ENABLED" : "RAINDANCE_ENABLED"
		] !== "true"
	)
		return false;
	const scope = readVideoEffectAccessScope(environment, effectId);
	return (
		scope === "authenticated" || (scope === "internal" && canAccessInternalVideoV1(config, user))
	);
}
