import { describe, expect, it } from "vitest";

import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
} from "./video-effects";
import { canAccessVideoEffect, readVideoEffectAccessScope } from "./video-effects-access.server";
import { canAccessVideoV1, readVideoV1Config } from "./video-v1";

const environment = {
	VIDEO_V1_ENABLED: "true",
	HOTEL_LOBBY_DUO_ENABLED: "true",
};
const customer = { id: "registered-customer", role: "user", isAnonymous: false };

describe("Hotel Lobby template access scope", () => {
	it("defaults to administrator-only access without widening ordinary video", () => {
		expect(readVideoEffectAccessScope({})).toBe("internal");
		expect(canAccessVideoEffect(environment, customer)).toBe(false);
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

describe("Rumpelstiltskin authenticated customer access", () => {
	const effectId = RUMPELSTILTSKIN_SOLO_EFFECT_ID;
	it("defaults to registered customer access without requiring material or a private test list", () => {
		expect(readVideoEffectAccessScope({}, effectId)).toBe("authenticated");
		expect(canAccessVideoEffect(environment, customer, effectId)).toBe(true);
		expect(
			canAccessVideoEffect({ ...environment, VIDEO_V1_ACCESS: "internal" }, customer, effectId),
		).toBe(true);
	});
	it.each([null, undefined, { id: "guest", isAnonymous: true }, { id: "" }])(
		"rejects absent or anonymous identity %j",
		(user) => {
			expect(canAccessVideoEffect(environment, user, effectId)).toBe(false);
		},
	);
	it.each(["public", " authenticated", "", "true"])("rejects malformed access %j", (access) => {
		expect(
			canAccessVideoEffect({ ...environment, RUMPELSTILTSKIN_ACCESS: access }, customer, effectId),
		).toBe(false);
	});
	it.each(["false", "", "TRUE", "1"])(
		"honors an explicit kill switch or invalid enabled value %j",
		(enabled) => {
			expect(
				canAccessVideoEffect(
					{ ...environment, RUMPELSTILTSKIN_ENABLED: enabled },
					customer,
					effectId,
				),
			).toBe(false);
		},
	);
	it("retains the ordinary execution kill switch", () => {
		expect(
			canAccessVideoEffect({ ...environment, VIDEO_V1_ENABLED: "false" }, customer, effectId),
		).toBe(false);
	});
	it("requires its independent whitelist only for an explicit internal rollback", () => {
		const internal = {
			...environment,
			RUMPELSTILTSKIN_ACCESS: "internal",
			RUMPELSTILTSKIN_ALLOWED_USER_IDS: customer.id,
			VIDEO_V1_ALLOWED_USER_IDS: "administrator",
		};
		expect(canAccessVideoEffect(internal, customer, effectId)).toBe(true);
		expect(canAccessVideoEffect(internal, { id: "administrator", role: "admin" }, effectId)).toBe(
			false,
		);
		expect(
			canAccessVideoEffect(
				{ ...internal, RUMPELSTILTSKIN_ALLOWED_USER_IDS: undefined },
				customer,
				effectId,
			),
		).toBe(false);
	});
});
