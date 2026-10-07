import { describe, expect, it } from "vitest";

import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
} from "./video-effects";
import { canAccessVideoEffect, readVideoEffectAccessScope } from "./video-effects-access.server";
import { canAccessVideoV1, readVideoV1Config } from "./video-v1";

const environment = {
	VIDEO_V1_ENABLED: "true",
	HOTEL_LOBBY_DUO_ENABLED: "true",
	VIDEO_V1_ALLOWED_USER_IDS: "internal-owner",
};
const customer = { id: "registered-customer", role: "user", isAnonymous: false };

describe("Hotel Lobby template access scope", () => {
	it("defaults to the existing internal audience without widening ordinary video", () => {
		expect(readVideoEffectAccessScope({})).toBe("internal");
		expect(canAccessVideoEffect(environment, customer)).toBe(false);
		expect(canAccessVideoEffect(environment, { id: "internal-owner" })).toBe(true);
		expect(canAccessVideoEffect(environment, { id: "operator", role: "admin" })).toBe(true);
	});
	it("explicitly admits all registered customers only to the template", () => {
		const publicTemplate = { ...environment, HOTEL_LOBBY_DUO_ACCESS: "authenticated" };
		expect(canAccessVideoEffect(publicTemplate, customer)).toBe(true);
		expect(canAccessVideoV1(readVideoV1Config(publicTemplate), customer)).toBe(false);
	});
	it.each([HOTEL_LOBBY_EFFECT_ID, RAINDANCE_SOLO_EFFECT_ID, RAINDANCE_DUO_EFFECT_ID] as const)(
		"keeps internal template %s restricted after ordinary video opens",
		(effectId) => {
			const ordinaryVideoOpen = {
				...environment,
				VIDEO_V1_ACCESS: "authenticated",
				RAINDANCE_ENABLED: "true",
			};
			expect(canAccessVideoV1(readVideoV1Config(ordinaryVideoOpen), customer)).toBe(true);
			expect(canAccessVideoEffect(ordinaryVideoOpen, customer, effectId)).toBe(false);
			expect(canAccessVideoEffect(ordinaryVideoOpen, { id: "internal-owner" }, effectId)).toBe(
				true,
			);
			expect(
				canAccessVideoEffect(ordinaryVideoOpen, { id: "operator", role: "admin" }, effectId),
			).toBe(true);
			expect(
				canAccessVideoEffect(
					{
						...ordinaryVideoOpen,
						HOTEL_LOBBY_DUO_ACCESS: "authenticated",
						RAINDANCE_ACCESS: "authenticated",
					},
					customer,
					effectId,
				),
			).toBe(true);
		},
	);
	it.each([null, undefined, { id: "guest", isAnonymous: true }, { id: "", role: "admin" }])(
		"rejects absent/anonymous identity %j even when enabled",
		(user) => {
			expect(
				canAccessVideoEffect({ ...environment, HOTEL_LOBBY_DUO_ACCESS: "authenticated" }, user),
			).toBe(false);
		},
	);
	it.each(["public", "true", " authenticated", ""])(
		"fails closed for malformed scope %j",
		(scope) => {
			const env = { ...environment, HOTEL_LOBBY_DUO_ACCESS: scope };
			expect(readVideoEffectAccessScope(env)).toBeNull();
			expect(canAccessVideoEffect(env, { id: "operator", role: "admin" })).toBe(false);
		},
	);
	it.each(["VIDEO_V1_ENABLED", "HOTEL_LOBBY_DUO_ENABLED"])(
		"retains the %s emergency admission gate",
		(key) => {
			expect(
				canAccessVideoEffect(
					{ ...environment, HOTEL_LOBBY_DUO_ACCESS: "authenticated", [key]: "false" },
					customer,
				),
			).toBe(false);
		},
	);
});
