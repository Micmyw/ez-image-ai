import { describe, expect, it } from "vitest";

import {
	expandVideoRuntimeEnvironment,
	hydrateVideoRuntimeEnvironment,
	packVideoRuntimeEnvironment,
	parseHotelLobbyRuntimeOverride,
	parseVideoRuntimeConfig,
	VIDEO_RUNTIME_ENVIRONMENT_KEYS,
} from "./video-runtime-environment";

const policy = {
	VIDEO_V1_ACCESS: "internal",
	VIDEO_V1_ALLOWED_USER_IDS: "user-a,user-b",
	VIDEO_V1_PROVIDER_CONCURRENCY: "1",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_V1_UPLOAD_CORS_READY: "true",
	VIDEO_COST_STORAGE_MICROS: "100",
	HOTEL_LOBBY_DUO_PRICE_VERSION: "fixture-price-only",
	HOTEL_LOBBY_DUO_ACCESS: "authenticated",
	HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "20000",
	HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: "750",
	HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "fixture-only-payment-approval",
	HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
	VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify([{ productKey: "fixture", sounds: [false] }]),
	VIDEO_INTERNAL_FUNDING: JSON.stringify({
		userIds: ["fixture-user"],
		validUntil: "2100-01-01T00:00:00.000Z",
		reason: "fixture-only-authorized-scope",
	}),
};

describe("private video runtime environment transport", () => {
	it("limits build-only template patches to template policy, never funding or ordinary access", () => {
		expect(parseHotelLobbyRuntimeOverride('{"HOTEL_LOBBY_DUO_ACCESS":"authenticated"}')).toEqual({
			HOTEL_LOBBY_DUO_ACCESS: "authenticated",
		});
		for (const key of [
			"VIDEO_V1_ACCESS",
			"VIDEO_MODEL_ALLOWED_OPTIONS",
			"VIDEO_INTERNAL_FUNDING",
			"HOTEL_LOBBY_DUO_INTERNAL_FUNDING",
			"HOTEL_LOBBY_DUO_ENABLED",
			"HOTEL_LOBBY_DUO_BUILD_ENABLED",
			"KIE_API_KEY",
			"HOTEL_LOBBY_DUO_RUNTIME_CONFIG",
		])
			expect(() =>
				parseHotelLobbyRuntimeOverride(JSON.stringify({ [key]: "secret-not-echoed" })),
			).toThrow(/^HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID$/);
		for (const value of [
			"{}",
			"invalid",
			'{"HOTEL_LOBBY_DUO_ACCESS":"public"}',
			'{"HOTEL_LOBBY_DUO_ACCESS":" authenticated"}',
			JSON.stringify({ HOTEL_LOBBY_DUO_PRICE_BASIS: "界".repeat(1800) }),
		])
			expect(() => parseHotelLobbyRuntimeOverride(value)).toThrow(
				/^HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID$/,
			);
	});
	it("round trips policy and leaves kill switch, image flags and credentials separate", () => {
		const input = {
			...policy,
			VIDEO_V1_ENABLED: "false",
			HOTEL_LOBBY_DUO_ENABLED: "false",
			KIE_API_KEY: "fixture-only",
			SEEAPI_WEBHOOK_SIGNING_KEYS: "fixture-only",
			MEDIA_GENERATION_ENABLED: "true",
		};
		const packed = packVideoRuntimeEnvironment(input);
		expect(parseVideoRuntimeConfig(packed.VIDEO_RUNTIME_CONFIG)).toEqual(policy);
		for (const key of Object.keys(policy)) expect(packed).not.toHaveProperty(key);
		expect(packed).toMatchObject({
			VIDEO_V1_ENABLED: "false",
			KIE_API_KEY: "fixture-only",
			SEEAPI_WEBHOOK_SIGNING_KEYS: "fixture-only",
			MEDIA_GENERATION_ENABLED: "true",
		});
		expect(expandVideoRuntimeEnvironment(packed)).toMatchObject(input);
		expect(packVideoRuntimeEnvironment(packed)).toEqual(packed);
		expect(input).not.toHaveProperty("VIDEO_RUNTIME_CONFIG");
	});
	it("preserves legacy flat input and accepts identical mixed input", () => {
		expect(expandVideoRuntimeEnvironment(policy)).toEqual(policy);
		expect(
			expandVideoRuntimeEnvironment({ ...policy, VIDEO_RUNTIME_CONFIG: JSON.stringify(policy) }),
		).toMatchObject(policy);
		expect(packVideoRuntimeEnvironment({ KIE_API_KEY: "fixture" })).toEqual({
			KIE_API_KEY: "fixture",
		});
		expect(packVideoRuntimeEnvironment({})).not.toHaveProperty("VIDEO_INTERNAL_FUNDING");
	});
	it.each([
		"KIE_API_KEY",
		"KIE_WEBHOOK_SECRET",
		"SEEAPI_API_KEY",
		"SEEAPI_WEBHOOK_SIGNING_KEYS",
		"VIDEO_SEEAPI_CALLBACK_SECRET",
		"WAFFO_PRIVATE_KEY",
		"VIDEO_V1_ENABLED",
		"HOTEL_LOBBY_DUO_ENABLED",
		"VIDEO_WORKFLOW",
		"VIDEO_MEDIA_BUCKET",
		"NEXT_PUBLIC_VIDEO_RUNTIME_CONFIG",
		"UNKNOWN",
		"__proto__",
	])("rejects forbidden field %s without leaking its value", (key) => {
		const encoded = JSON.stringify({ [key]: "do-not-print-fixture" });
		expect(() => parseVideoRuntimeConfig(encoded)).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
	});
	it.each([
		undefined,
		null,
		"",
		"[{}]",
		"null",
		"true",
		"broken",
		'{"VIDEO_V1_ACCESS":true}',
		'{"VIDEO_V1_ACCESS":{}}',
		'{"VIDEO_V1_ACCESS":null}',
		JSON.stringify({ VIDEO_PRICE_BASIS: "line\nbreak" }),
		JSON.stringify({ VIDEO_PRICE_BASIS: "界".repeat(1800) }),
	])("rejects malformed, nonstring, control-character or oversized content", (value) => {
		expect(() => parseVideoRuntimeConfig(value)).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
	});
	it("rejects conflicting source values at expansion and packaging before mutation", () => {
		const input = {
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			VIDEO_V1_PROVIDER_CONCURRENCY: "5",
		};
		expect(() => expandVideoRuntimeEnvironment(input)).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
		expect(() => packVideoRuntimeEnvironment(input)).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
		expect(input.VIDEO_V1_PROVIDER_CONCURRENCY).toBe("5");
	});
	it("hydrates every allowed field and preserves unrelated process credentials", () => {
		const packedPolicy = Object.fromEntries(
			VIDEO_RUNTIME_ENVIRONMENT_KEYS.map((key) => [key, "fixture-policy"]),
		);
		const target = { KIE_API_KEY: "process-fixture", MEDIA_GENERATION_ENABLED: "true" } as Record<
			string,
			string | undefined
		>;
		const binding = {};
		const result = hydrateVideoRuntimeEnvironment(
			{
				VIDEO_RUNTIME_CONFIG: JSON.stringify(packedPolicy),
				VIDEO_V1_ENABLED: "true",
				VIDEO_WORKFLOW: binding,
			},
			target,
		);
		expect(target).toMatchObject({
			...packedPolicy,
			VIDEO_V1_ENABLED: "true",
			KIE_API_KEY: "process-fixture",
			MEDIA_GENERATION_ENABLED: "true",
		});
		expect(result.VIDEO_WORKFLOW).toBe(binding);
	});
	it("refreshes the snapshot without stale policies or restoration across async consumers", async () => {
		const target: Record<string, string | undefined> = {};
		const input = { VIDEO_RUNTIME_CONFIG: JSON.stringify(policy), VIDEO_V1_ENABLED: "false" };
		const reads = await Promise.all(
			Array.from({ length: 4 }, async () => {
				hydrateVideoRuntimeEnvironment(input, target);
				await Promise.resolve();
				return { ...target };
			}),
		);
		for (const read of reads) expect(read).toEqual(reads[0]);
		hydrateVideoRuntimeEnvironment(
			{ VIDEO_V1_ENABLED: "true", VIDEO_V1_ACCESS: "internal" },
			target,
		);
		expect(target).toEqual({
			VIDEO_V1_ENABLED: "true",
			HOTEL_LOBBY_DUO_ENABLED: "false",
			VIDEO_V1_ACCESS: "internal",
		});
		hydrateVideoRuntimeEnvironment({}, target);
		expect(target).toEqual({ VIDEO_V1_ENABLED: "false", HOTEL_LOBBY_DUO_ENABLED: "false" });
	});
	it.each([
		JSON.stringify({ VIDEO_V1_ENABLED: "true" }),
		"broken",
		JSON.stringify({ KIE_API_KEY: "fixture" }),
	])("closes invalid runtime policy without disrupting unrelated image settings", (encoded) => {
		const target: Record<string, string | undefined> = {
			...policy,
			VIDEO_V1_ENABLED: "true",
			MEDIA_GENERATION_ENABLED: "true",
		};
		const result = hydrateVideoRuntimeEnvironment(
			{ VIDEO_RUNTIME_CONFIG: encoded, VIDEO_V1_ENABLED: "true", ...policy },
			target,
		);
		expect(target).toEqual({
			VIDEO_V1_ENABLED: "false",
			HOTEL_LOBBY_DUO_ENABLED: "false",
			MEDIA_GENERATION_ENABLED: "true",
		});
		expect(result.VIDEO_V1_ENABLED).toBe("false");
		expect(result).not.toHaveProperty("VIDEO_RUNTIME_CONFIG");
	});
	it("closes conflicting flat/packed runtime policy and never derives enabled from policy", () => {
		const target: Record<string, string | undefined> = {};
		hydrateVideoRuntimeEnvironment(
			{
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
				VIDEO_V1_ACCESS: "public",
				VIDEO_V1_ENABLED: "true",
			},
			target,
		);
		expect(target).toEqual({ VIDEO_V1_ENABLED: "false", HOTEL_LOBBY_DUO_ENABLED: "false" });
		hydrateVideoRuntimeEnvironment({ VIDEO_RUNTIME_CONFIG: JSON.stringify(policy) }, target);
		expect(target.VIDEO_V1_ENABLED).toBe("false");
	});
	it("hydrates the independent template switch and clears it between versions", () => {
		const target: Record<string, string | undefined> = {};
		hydrateVideoRuntimeEnvironment(
			{ VIDEO_V1_ENABLED: "true", HOTEL_LOBBY_DUO_ENABLED: "true" },
			target,
		);
		expect(target.HOTEL_LOBBY_DUO_ENABLED).toBe("true");
		hydrateVideoRuntimeEnvironment({ VIDEO_V1_ENABLED: "true" }, target);
		expect(target.HOTEL_LOBBY_DUO_ENABLED).toBe("false");
		hydrateVideoRuntimeEnvironment(
			{ HOTEL_LOBBY_DUO_ENABLED: "true", VIDEO_RUNTIME_CONFIG: "invalid" },
			target,
		);
		expect(target.HOTEL_LOBBY_DUO_ENABLED).toBe("false");
	});
});
