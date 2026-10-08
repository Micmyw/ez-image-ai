import { parseEnv } from "node:util";

import {
	VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "@repo/config/video-effects";
import { canAccessVideoEffect } from "@repo/config/video-effects-access.server";
import {
	HOTEL_LOBBY_TEMPLATE_VERSION,
	RAINDANCE_TEMPLATE_VERSION,
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
} from "@repo/config/video-effects.server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import {
	VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "@repo/config/video-pricing.server";
import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { canAccessVideoV1, readVideoV1Config, videoV1Readiness } from "@repo/config/video-v1";
import { describe, expect, it } from "vitest";

import { readCloudflareBuildEnvironment } from "./build-secrets";
import { verifyApprovedVideoEffectPrices } from "./video-effect-retail-preflight";
import { verifyApprovedVideoRetailPrices } from "./video-retail-preflight";

// Approvals are already present: this suite isolates compaction, not the intended
// introduction of the separately approved long-effect templates.
const activePolicy = {
	VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_ACCEPTED_TEMPLATE_VERSION: RAINDANCE_TEMPLATE_VERSION,
	RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: RAINDANCE_LONG_TEMPLATE_VERSION,
	VIDEO_V1_ACCESS: "authenticated",
	HOTEL_LOBBY_DUO_ACCESS: "internal",
	RAINDANCE_ENABLED: "true",
	RAINDANCE_ACCESS: "internal",
	RUMPELSTILTSKIN_ACCESS: "internal",
	RUMPELSTILTSKIN_ALLOWED_USER_IDS: "motion-owner",
	VIDEO_INTERNAL_FUNDING: '{"userIds":["funding-owner"],"validUntil":"2099-01-01"}',
	HOTEL_LOBBY_DUO_INTERNAL_FUNDING: '{"userIds":["hotel-owner"],"validUntil":"2099-01-01"}',
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
	VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
	HOTEL_LOBBY_DUO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2099-01-01T00:00:00Z",
	HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
	HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
	HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
	HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
	HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
	HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
};
const flat = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	HOTEL_LOBBY_DUO_ENABLED: "true",
	RUMPELSTILTSKIN_ENABLED: "true",
	KIE_API_KEY: "synthetic-fixture",
	KIE_WEBHOOK_SECRET: "synthetic-fixture",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	WAFFO_MERCHANT_ID: "synthetic-fixture",
	WAFFO_PRIVATE_KEY: "synthetic-fixture",
	SEEAPI_API_KEY: "synthetic-fixture",
	SEEAPI_WEBHOOK_SIGNING_KEYS: '{"whkey_test":"whsec_local_test_signing_secret_20261004"}',
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
};
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };

function scenario(
	patch: Record<string, string | undefined> = {},
	flatPatch: Record<string, string | undefined> = {},
) {
	const expectedPolicy = Object.fromEntries(
		Object.entries({ ...activePolicy, ...patch }).filter(([, value]) => value !== undefined),
	);
	const environment = Object.fromEntries(
		Object.entries({ ...flat, ...flatPatch }).filter(([, value]) => value !== undefined),
	);
	const legacyPolicy = {
		...expectedPolicy,
		VIDEO_V1_ALLOWED_USER_IDS: "retired-user,admin",
		VIDEO_MODEL_ALLOWED_OPTIONS: "[]",
	};
	return {
		expectedPolicy,
		environment,
		legacyPolicy,
		input: {
			CLOUDFLARE_PRODUCTION_ENV: Object.entries(environment)
				.map(([key, value]) => `${key}='${value}'`)
				.join("\n"),
			VIDEO_RUNTIME_CONFIG: JSON.stringify(legacyPolicy),
			VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
		},
	};
}
function environments(
	patch: Record<string, string | undefined> = {},
	flatPatch: Record<string, string | undefined> = {},
) {
	const { input, expectedPolicy, environment, legacyPolicy } = scenario(patch, flatPatch);
	const output = parseEnv(readCloudflareBuildEnvironment(input));
	// This includes the live Rumpelstiltskin list, funding, safety and model settings.
	expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(expectedPolicy);
	for (const [key, value] of Object.entries(environment)) expect(output[key]).toBe(value);
	return {
		before: expandVideoRuntimeEnvironment({
			...environment,
			VIDEO_RUNTIME_CONFIG: JSON.stringify(legacyPolicy),
		}),
		after: expandVideoRuntimeEnvironment(output),
	};
}

const users = [
	null,
	{ id: "retired-user", isAnonymous: true },
	{ id: "retired-user" },
	{ id: "customer" },
	{ id: "motion-owner" },
	{ id: "admin", role: "admin" },
] as const;
function access(environment: Record<string, string | undefined>) {
	return users.map((user) => [
		canAccessVideoV1(readVideoV1Config(environment), user),
		canAccessVideoEffect(environment, user, "hotel-lobby-duo"),
		canAccessVideoEffect(environment, user, "raindance-solo"),
		canAccessVideoEffect(environment, user, "raindance-duo"),
		canAccessVideoEffect(environment, user, "rumpelstiltskin-solo"),
	]);
}

describe("build policy compaction semantics", () => {
	it("retains ordinary access and every independent effect audience, including the live motion list", () => {
		const { before, after } = environments();
		expect(access(after)).toEqual(access(before));
		expect(access(after)).toEqual([
			[false, false, false, false, false],
			[false, false, false, false, false],
			[true, false, false, false, false],
			[true, false, false, false, false],
			[true, false, false, false, true],
			[true, true, true, true, false],
		]);
	});
	it.each(["internal", "invalid", undefined])(
		"does not reopen ordinary rollback or invalid/missing access: %s",
		(scope) => {
			const { before, after } = environments({ VIDEO_V1_ACCESS: scope });
			expect(access(after)).toEqual(access(before));
			expect(access(after).map((row) => row[0])).toEqual([
				false,
				false,
				false,
				false,
				false,
				scope !== "invalid",
			]);
		},
	);
	it.each([
		["HOTEL_LOBBY_DUO_ACCESS", 1],
		["RAINDANCE_ACCESS", 2],
		["RUMPELSTILTSKIN_ACCESS", 4],
	] as const)("preserves independent access scopes of %s", (key, column) => {
		const scopes =
			key === "RUMPELSTILTSKIN_ACCESS"
				? ["authenticated", undefined]
				: ["authenticated", "invalid", undefined];
		for (const scope of scopes) {
			const { before, after } = environments({ [key]: scope });
			expect(access(after)).toEqual(access(before));
			expect(access(after)[3]![column]).toBe(
				scope === "authenticated" || (key === "RUMPELSTILTSKIN_ACCESS" && scope === undefined),
			);
		}
	});
	it.each(["VIDEO_V1_ENABLED", "HOTEL_LOBBY_DUO_ENABLED", "RUMPELSTILTSKIN_ENABLED"])(
		"retains the independent disabled switch %s",
		(key) => {
			const { before, after } = environments(
				key === "VIDEO_V1_ENABLED" ? { RAINDANCE_ENABLED: "false" } : {},
				{ [key]: "false" },
			);
			expect(access(after)).toEqual(access(before));
			const columns =
				key === "VIDEO_V1_ENABLED" ? [0, 1, 2, 3, 4] : [key.startsWith("HOTEL") ? 1 : 4];
			for (const row of access(after))
				for (const column of columns) expect(row[column]).toBe(false);
		},
	);
	it("keeps the packed Raindance disable switch closed", () => {
		const { before, after } = environments({ RAINDANCE_ENABLED: "false" });
		expect(access(after)).toEqual(access(before));
		for (const row of access(after)) expect(row.slice(2, 4)).toEqual([false, false]);
	});
	it("keeps implemented-model readiness with an empty obsolete model list", () => {
		const { before, after } = environments();
		expect(videoV1Readiness(before, bindings, { multiModel: true })).toEqual({
			ready: true,
			reasons: [],
		});
		expect(videoV1Readiness(after, bindings, { multiModel: true })).toEqual(
			videoV1Readiness(before, bindings, { multiModel: true }),
		);
	});
	it.each([
		["MEDIA_GENERATION_ENABLED", "false", "MEDIA_GENERATION_DISABLED"],
		["KIE_API_KEY", undefined, "VIDEO_PROVIDER_NOT_CONFIGURED"],
		["SEEAPI_API_KEY", undefined, "VIDEO_VISUAL_MODERATION_NOT_CONFIGURED"],
		["WAFFO_PRIVATE_KEY", undefined, "VIDEO_MODERATION_NOT_CONFIGURED"],
	] as const)("does not bypass the readiness gate %s", (key, value, reason) => {
		const { before, after } = environments({}, { [key]: value });
		const result = videoV1Readiness(after, bindings, { multiModel: true });
		expect(result).toEqual(videoV1Readiness(before, bindings, { multiModel: true }));
		expect(result.ready).toBe(false);
		expect(result.reasons).toContain(reason);
	});
	it("keeps an unapproved model contract unavailable", () => {
		const { before, after } = environments({ VIDEO_MODEL_CONTRACT_VERSION: "unapproved" });
		const result = videoV1Readiness(after, bindings, { multiModel: true });
		expect(result).toEqual(videoV1Readiness(before, bindings, { multiModel: true }));
		expect(result).toMatchObject({ ready: false, reasons: ["VIDEO_MODEL_CONTRACT_NOT_CONFIRMED"] });
	});
	it("preserves all 1,188 ordinary prices and the six approved effect price pairs", () => {
		const { before, after } = environments();
		const ordinary = verifyApprovedVideoRetailPrices(after);
		expect(ordinary).toEqual(verifyApprovedVideoRetailPrices(before));
		expect(ordinary).toMatchObject({ enabled: true, checked: 1188, differences: 0 });
		const effects = verifyApprovedVideoEffectPrices(after);
		expect(effects).toEqual(verifyApprovedVideoEffectPrices(before));
		expect(effects).toMatchObject({ enabled: true, checked: 6, differences: 0 });
		expect(
			effects.rows?.map(({ standardCredits, annualCredits }) => [standardCredits, annualCredits]),
		).toEqual([
			["69", "69"],
			["116", "101"],
			["69", "69"],
			["116", "101"],
			["69", "69"],
			["116", "101"],
		]);
	});
	it.each([
		[{ VIDEO_PRICE_ACCEPTED_VERSION: "unapproved" }, {}, "VIDEO_PRICE_NOT_APPROVED"],
		[{ VIDEO_PRICE_VALID_UNTIL: "2000-01-01" }, {}, "VIDEO_PRICE_EXPIRED"],
		[{ VIDEO_COST_STORAGE_MICROS: undefined }, {}, "VIDEO_COST_POLICY_NOT_CONFIGURED"],
		[{ RUMPELSTILTSKIN_ACCESS: "invalid" }, {}, "RUMPELSTILTSKIN_ACCESS_INVALID"],
		[{}, { VIDEO_V1_ENABLED: "false" }, "VIDEO_EFFECT_VIDEO_DISABLED"],
	] as const)(
		"rejects invalid preparation before and after compaction: %j",
		(patch, flatPatch, error) => {
			const { input } = scenario(patch, flatPatch);
			for (const approval of [undefined, VIDEO_EFFECT_RETAIL_PRICE_VERSION])
				expect(() =>
					readCloudflareBuildEnvironment({
						...input,
						VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION: approval,
					}),
				).toThrow(error);
		},
	);
});
