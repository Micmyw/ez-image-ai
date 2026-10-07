import {
	HOTEL_LOBBY_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	type VideoEffectId,
} from "./video-effects";
import { canAccessInternalVideoV1, readVideoV1Config, type VideoV1Environment } from "./video-v1";

export type VideoEffectAccessScope = "internal" | "authenticated";

/** Only this template's server setting can widen its audience; malformed values stay closed. */
export function readVideoEffectAccessScope(
	environment: VideoV1Environment,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
): VideoEffectAccessScope | null {
	if (effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID) {
		const scope = environment.RUMPELSTILTSKIN_ACCESS ?? "authenticated";
		return scope === "internal" || scope === "authenticated" ? scope : null;
	}
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
	const enabled =
		effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID
			? (environment.RUMPELSTILTSKIN_ENABLED ?? "true") === "true"
			: environment[
					effectId === HOTEL_LOBBY_EFFECT_ID ? "HOTEL_LOBBY_DUO_ENABLED" : "RAINDANCE_ENABLED"
				] === "true";
	if (!user?.id || user.isAnonymous || !config.enabled || !enabled) return false;
	const scope = readVideoEffectAccessScope(environment, effectId);
	// An administrator role or another product's whitelist never grants this internal test access.
	if (effectId === RUMPELSTILTSKIN_SOLO_EFFECT_ID)
		return (
			scope === "authenticated" ||
			(scope === "internal" &&
				(environment.RUMPELSTILTSKIN_ALLOWED_USER_IDS ?? "")
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
					.includes(user.id))
		);
	return (
		scope === "authenticated" || (scope === "internal" && canAccessInternalVideoV1(config, user))
	);
}
