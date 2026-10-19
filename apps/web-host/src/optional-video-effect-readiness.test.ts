import { parseEnv } from "node:util";

import { resolveVideoEffectPrice } from "@repo/config/video-effects.server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/config/video-effects.server", async (original) => ({
	...(await original<typeof import("@repo/config/video-effects.server")>()),
	resolveVideoEffectPrice: vi.fn(),
}));

import { readCloudflareBuildEnvironment } from "./build-secrets";
import { assessOptionalVideoEffectOptions } from "./optional-video-effect-readiness";

afterEach(() => vi.resetAllMocks());

describe("optional effect build isolation", () => {
	it.each([
		"VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED",
		"VIDEO_EFFECT_PRICE_NOT_APPROVED",
		"VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED",
		"VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED",
		"VIDEO_EFFECT_PAYMENT_COST_NOT_CONFIRMED",
		"VIDEO_EFFECT_TEXT_COST_NOT_CONFIRMED",
		"VIDEO_EFFECT_PRICING_TARGET_INVALID",
	])("reports %s without changing admission policy or unrelated image settings", (reason) => {
		vi.mocked(resolveVideoEffectPrice).mockImplementation(() => {
			throw new Error(reason);
		});
		const source =
			"VIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=true\nMEDIA_GENERATION_ENABLED=true\nUNRELATED=kept";
		const result = readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source });
		expect(result).toBe(source);
		expect(assessOptionalVideoEffectOptions(parseEnv(result))[0]).toMatchObject({
			effectId: "hotel-lobby-duo",
			duration: 5,
			available: false,
			reasons: [reason],
		});
	});
	it("keeps explicit build enable control while reporting missing optional policy", () => {
		vi.mocked(resolveVideoEffectPrice).mockImplementation(() => {
			throw new Error("VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED");
		});
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false",
					HOTEL_LOBBY_DUO_BUILD_ENABLED: "true",
				}),
			).HOTEL_LOBBY_DUO_ENABLED,
		).toBe("true");
	});
	it.each([
		"VIDEO_RUNTIME_CONFIG_INVALID",
		"VIDEO_RUNTIME_CONFIG_CONFLICT",
		"VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED",
		"VIDEO_COST_POLICY_NOT_CONFIGURED",
	])("keeps %s fatal", (reason) => {
		vi.mocked(resolveVideoEffectPrice).mockImplementation(() => {
			throw new Error(reason);
		});
		expect(() =>
			assessOptionalVideoEffectOptions({
				VIDEO_V1_ENABLED: "true",
				HOTEL_LOBBY_DUO_ENABLED: "true",
			}),
		).toThrow(reason);
	});
	it("keeps unknown failures fatal without exposing arbitrary error text", () => {
		vi.mocked(resolveVideoEffectPrice).mockImplementation(() => {
			throw new Error("private-sentinel");
		});
		expect(() =>
			assessOptionalVideoEffectOptions({
				VIDEO_V1_ENABLED: "true",
				HOTEL_LOBBY_DUO_ENABLED: "true",
			}),
		).toThrow(/^VIDEO_EFFECT_BUILD_READINESS_FAILED$/);
	});
	it("does not weaken malformed or conflicting opaque policy validation", () => {
		expect(() => assessOptionalVideoEffectOptions({ VIDEO_RUNTIME_CONFIG: "bad-json" })).toThrow(
			"VIDEO_RUNTIME_CONFIG_INVALID",
		);
		expect(() =>
			assessOptionalVideoEffectOptions({
				VIDEO_RUNTIME_CONFIG: '{"HOTEL_LOBBY_DUO_PRICE_BASIS":"packed"}',
				HOTEL_LOBBY_DUO_PRICE_BASIS: "flat",
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
	});
	it("reports disabled and ordinary-video-disabled options without rewriting flags", () => {
		const source = { VIDEO_V1_ENABLED: "false", HOTEL_LOBBY_DUO_ENABLED: "true" };
		expect(assessOptionalVideoEffectOptions(source)[0]).toMatchObject({
			available: false,
			reasons: ["VIDEO_EFFECT_VIDEO_DISABLED"],
		});
		expect(source).toEqual({ VIDEO_V1_ENABLED: "false", HOTEL_LOBBY_DUO_ENABLED: "true" });
		expect(resolveVideoEffectPrice).not.toHaveBeenCalled();
	});
});
