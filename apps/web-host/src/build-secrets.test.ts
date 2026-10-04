import { parseEnv } from "node:util";

import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { readVideoSeeapiCallbackConfig } from "@repo/config/video-seeapi-callback";
import { describe, expect, it } from "vitest";

import {
	packCloudflareBuildEnvironment,
	readCloudflareBuildEnvironment,
	withoutCloudflareBuildSecrets,
} from "./build-secrets";
import { publicBuildVariables } from "./deployment";

const unpackValues = (variables: ReturnType<typeof packCloudflareBuildEnvironment>) =>
	Object.fromEntries(Object.entries(variables).map(([key, item]) => [key, item.value]));
const allowedVideoOptions = JSON.stringify([
	{
		productKey: "video-kling-2-6-v1",
		modes: ["text-to-video"],
		durations: [5],
		resolutions: ["default"],
		sounds: [false],
	},
]);

describe("Cloudflare build secret transport", () => {
	it("keeps ambient template flags inert and permits independent explicit emergency close", () => {
		const source = "HOTEL_LOBBY_DUO_ENABLED=true\nVIDEO_V1_ENABLED=true\nUNCHANGED=fixture";
		const untouched = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				HOTEL_LOBBY_DUO_ENABLED: "false",
			}),
		);
		expect(untouched.HOTEL_LOBBY_DUO_ENABLED).toBe("true");
		const closed = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				HOTEL_LOBBY_DUO_BUILD_ENABLED: "false",
			}),
		);
		expect(closed).toEqual({
			HOTEL_LOBBY_DUO_ENABLED: "false",
			VIDEO_V1_ENABLED: "true",
			UNCHANGED: "fixture",
		});
		expect(
			withoutCloudflareBuildSecrets({
				HOTEL_LOBBY_DUO_ENABLED: "true",
				HOTEL_LOBBY_DUO_BUILD_ENABLED: "true",
			}),
		).toEqual({});
	});
	it.each(["TRUE", " true", "true\nINJECTED=yes"])(
		"rejects invalid template build flag %j",
		(value) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
					HOTEL_LOBBY_DUO_BUILD_ENABLED: value,
				}),
			).toThrow("VIDEO_EFFECT_BUILD_ENABLED_OVERRIDE_INVALID");
		},
	);
	it("cannot open the template from ordinary video approval or a packed admission switch", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				HOTEL_LOBBY_DUO_BUILD_ENABLED: "true",
			}),
		).toThrow("VIDEO_EFFECT_BUILD_ENABLED_POLICY_REQUIRED");
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_MODEL_ALLOWED_OPTIONS: allowedVideoOptions }),
				HOTEL_LOBBY_DUO_BUILD_ENABLED: "true",
			}),
		).toThrow("VIDEO_EFFECT_BUILD_ENABLED_POLICY_REQUIRED");
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ HOTEL_LOBBY_DUO_ENABLED: "true" }),
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_INVALID");
	});
	it("enables only through the dedicated build flag with a valid current policy override", () => {
		const source = "UNRELATED=fixture\nVIDEO_V1_ENABLED=false\nBILLING_ENABLED=false";
		const policy = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_MODEL_ALLOWED_OPTIONS: allowedVideoOptions,
		};
		const input = {
			CLOUDFLARE_PRODUCTION_ENV: source,
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			VIDEO_V1_BUILD_ENABLED: "true",
			VIDEO_V1_ENABLED: "false",
		};
		const output = readCloudflareBuildEnvironment(input);
		const values = parseEnv(output);
		expect(output.startsWith(source)).toBe(true);
		expect(values).toEqual({
			UNRELATED: "fixture",
			VIDEO_V1_ENABLED: "true",
			BILLING_ENABLED: "false",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
		});
		expect(values).not.toHaveProperty("VIDEO_V1_BUILD_ENABLED");
		expect(input.CLOUDFLARE_PRODUCTION_ENV).toBe(source);
		expect(withoutCloudflareBuildSecrets(input)).toEqual({});
	});
	it("allows a dedicated emergency close without a policy override or model list", () => {
		const source = "VIDEO_V1_ENABLED=true\nUNCHANGED=fixture";
		const values = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_V1_BUILD_ENABLED: "false",
				VIDEO_V1_ENABLED: "true",
			}),
		);
		expect(values).toEqual({ VIDEO_V1_ENABLED: "false", UNCHANGED: "fixture" });
	});
	it.each(["", "TRUE", " true", "true ", "0", "1", "false\nINJECTED=true"])(
		"rejects invalid dedicated build flag %j without echoing values",
		(value) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_V1_BUILD_ENABLED: value,
				}),
			).toThrow(/^VIDEO_BUILD_ENABLED_OVERRIDE_INVALID$/);
		},
	);
	it("does not enable from only an existing bundled model policy", () => {
		const source = `VIDEO_V1_ENABLED=false\nVIDEO_RUNTIME_CONFIG='${JSON.stringify({ VIDEO_MODEL_ALLOWED_OPTIONS: allowedVideoOptions })}'\n`;
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_V1_BUILD_ENABLED: "true",
			}),
		).toThrow(/^VIDEO_BUILD_ENABLED_POLICY_REQUIRED$/);
	});
	it.each([
		undefined,
		"",
		"[]",
		"[{}]",
		"not-json",
		JSON.stringify([
			{
				productKey: "unknown",
				modes: ["text-to-video"],
				durations: [5],
				resolutions: ["default"],
				sounds: [false],
			},
		]),
		allowedVideoOptions.replace("[5]", "[30]"),
	])("does not enable with a missing, empty or invalid allowed model policy", (options) => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_MODEL_ALLOWED_OPTIONS: options }),
				VIDEO_V1_BUILD_ENABLED: "true",
			}),
		).toThrow(/^VIDEO_BUILD_ENABLED_POLICY_REQUIRED$/);
	});
	it("rejects malformed policy and packed build controls before changing the enabled flag", () => {
		for (const value of [
			"bad-json",
			'{"VIDEO_V1_BUILD_ENABLED":"true"}',
			'{"VIDEO_V1_ENABLED":"true"}',
			'{"KIE_API_KEY":"fixture"}',
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: value,
					VIDEO_V1_BUILD_ENABLED: "true",
				}),
			).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
		}
	});
	it("preserves parsed source fields when a standalone emergency close appends no quote delimiters", () => {
		const source = "UNRELATED='fixture-unclosed";
		const result = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_V1_BUILD_ENABLED: "false",
			}),
		);
		expect(result).toEqual({ ...parseEnv(source), VIDEO_V1_ENABLED: "false" });
	});
	it.each(["invalid", '{"KIE_API_KEY":"fixture-must-not-leak"}', '{"VIDEO_V1_ENABLED":"true"}'])(
		"rejects invalid policy embedded only in the authoritative bundle",
		(value) => {
			const environment = unpackValues(
				packCloudflareBuildEnvironment(`VIDEO_V1_ENABLED=false\nVIDEO_RUNTIME_CONFIG='${value}'\n`),
			);
			expect(() => readCloudflareBuildEnvironment(environment)).toThrow(
				/^VIDEO_RUNTIME_CONFIG_INVALID$/,
			);
		},
	);
	it("rejects a policy override that would change an unterminated dotenv value", () => {
		const environment = {
			...unpackValues(packCloudflareBuildEnvironment("PRIVATE_KEY='fixture-unclosed")),
			VIDEO_RUNTIME_CONFIG: '{"VIDEO_V1_ACCESS":"internal"}',
		};
		expect(() => readCloudflareBuildEnvironment(environment)).toThrow(
			/^VIDEO_RUNTIME_CONFIG_INVALID$/,
		);
	});
	it("overlays strict private video policy without enabling or exposing it to public builds", () => {
		const policy = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_PRICE_BASIS: "fixture 'quotes' # 中文",
			VIDEO_MODEL_ALLOWED_OPTIONS: '[{"sounds":[false]}]',
		};
		const env = {
			...unpackValues(
				packCloudflareBuildEnvironment("PRIVATE_KEY=unchanged\nVIDEO_V1_ENABLED=false\n"),
			),
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
		};
		const restored = parseEnv(readCloudflareBuildEnvironment(env));
		expect(expandVideoRuntimeEnvironment(restored)).toMatchObject({
			...policy,
			VIDEO_V1_ENABLED: "false",
			PRIVATE_KEY: "unchanged",
		});
		expect(publicBuildVariables(restored as Record<string, string>)).toEqual({});
		expect(
			withoutCloudflareBuildSecrets({
				...env,
				VIDEO_V1_ENABLED: "true",
				VIDEO_V1_ALLOWED_USER_IDS: "private-user",
			}),
		).toEqual({});
	});
	it.each(["true", "false"])(
		"ignores an ambient %s kill switch while preserving the authoritative bundle",
		(flag) => {
			const env = {
				...unpackValues(packCloudflareBuildEnvironment("VIDEO_V1_ENABLED=false\n")),
				VIDEO_V1_ENABLED: flag,
			};
			expect(parseEnv(readCloudflareBuildEnvironment(env)).VIDEO_V1_ENABLED).toBe("false");
		},
	);
	it("rejects ambient policy injection and conflicting bundled flat policy", () => {
		const base = unpackValues(
			packCloudflareBuildEnvironment("VIDEO_V1_ACCESS=internal\nVIDEO_V1_ENABLED=false\n"),
		);
		expect(() =>
			readCloudflareBuildEnvironment({
				...base,
				VIDEO_RUNTIME_CONFIG: '{"VIDEO_V1_ENABLED":"true"}',
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_INVALID");
		expect(() =>
			readCloudflareBuildEnvironment({
				...base,
				VIDEO_RUNTIME_CONFIG: '{"VIDEO_V1_ACCESS":"public"}',
			}),
		).toThrow("VIDEO_RUNTIME_CONFIG_CONFLICT");
		expect(
			parseEnv(readCloudflareBuildEnvironment({ ...base, VIDEO_V1_ENABLED: "true\nINJECTED=yes" })),
		).not.toHaveProperty("INJECTED");
	});
	it("overlays video callback secrets without changing the existing bundle or opening video", () => {
		const source = "PRIVATE_KEY=unchanged\nVIDEO_V1_ENABLED=false\nKIE_WEBHOOK_SECRET=old\n";
		const overrides = {
			KIE_WEBHOOK_SECRET: " Kie non-hex 'value\"/#=+_fixture ",
			VIDEO_SEEAPI_CALLBACK_SECRET: "callback-fixture-with-'quotes\"-and-#-0123456789",
			SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
				whkey_current: "whsec_fixture-signing-secret-'\"`#\\n",
				whkey_previous: "whsec_fixture-previous-signing-secret",
			}),
		};
		const environment: Record<string, string> = {
			...unpackValues(packCloudflareBuildEnvironment(source)),
			...overrides,
		};
		const result = readCloudflareBuildEnvironment(environment);
		const parsed = parseEnv(result);
		expect(result.startsWith(source)).toBe(true);
		expect(environment.CLOUDFLARE_PRODUCTION_ENV).toBe(source);
		expect(parsed).toMatchObject({
			PRIVATE_KEY: "unchanged",
			VIDEO_V1_ENABLED: "false",
			KIE_WEBHOOK_SECRET: overrides.KIE_WEBHOOK_SECRET,
			VIDEO_SEEAPI_CALLBACK_SECRET: overrides.VIDEO_SEEAPI_CALLBACK_SECRET,
		});
		expect(JSON.parse(parsed.SEEAPI_WEBHOOK_SIGNING_KEYS!)).toEqual(
			JSON.parse(overrides.SEEAPI_WEBHOOK_SIGNING_KEYS),
		);
		expect(readVideoSeeapiCallbackConfig(parsed).ready).toBe(true);
		expect(
			publicBuildVariables(
				Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				),
			),
		).toEqual({});
	});

	it("accepts independently supplied callback credentials without claiming partial config ready", () => {
		const source = "PRIVATE_KEY=unchanged\nVIDEO_V1_ENABLED=false\n";
		const overrides = {
			KIE_WEBHOOK_SECRET: "fixture-non-hex-provider-secret",
			VIDEO_SEEAPI_CALLBACK_SECRET: "fixture-callback-secret-0123456789-abcdef",
		};
		const parsed = parseEnv(
			readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source, ...overrides }),
		);
		expect(parsed).toEqual({ PRIVATE_KEY: "unchanged", VIDEO_V1_ENABLED: "false", ...overrides });
		expect(readVideoSeeapiCallbackConfig(parsed).ready).toBe(false);
		const keysOnly = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					whkey_current: "whsec_fixture-signing-secret",
				}),
			}),
		);
		expect(JSON.parse(keysOnly.SEEAPI_WEBHOOK_SIGNING_KEYS!)).toEqual({
			whkey_current: "whsec_fixture-signing-secret",
		});
		expect(readVideoSeeapiCallbackConfig(keysOnly).ready).toBe(false);
	});

	it("preserves bundled video callback secrets exactly when no overrides are provided", () => {
		const source =
			"KIE_WEBHOOK_SECRET=unchanged\nVIDEO_SEEAPI_CALLBACK_SECRET=unchanged\nSEEAPI_WEBHOOK_SIGNING_KEYS={}\n";
		expect(readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source })).toBe(source);
	});

	it("rejects an override swallowed by an unclosed quote in the existing bundle", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false\nPRIVATE_KEY='unfinished",
				VIDEO_SEEAPI_CALLBACK_SECRET: "fixture-callback-secret-0123456789-abcdef",
			}),
		).toThrow(
			new Error("CLOUDFLARE_VIDEO_CALLBACK_OVERRIDE_INVALID: VIDEO_SEEAPI_CALLBACK_SECRET"),
		);
	});

	it.each(["KIE_WEBHOOK_SECRET", "VIDEO_SEEAPI_CALLBACK_SECRET", "SEEAPI_WEBHOOK_SIGNING_KEYS"])(
		"applies only the supplied %s override, including bundles without a trailing newline",
		(key) => {
			const existing = {
				KIE_WEBHOOK_SECRET: "existing-kie-fixture",
				VIDEO_SEEAPI_CALLBACK_SECRET: "existing-callback-fixture-0123456789",
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					whkey_previous: "whsec_previous-fixture-secret",
				}),
			};
			const replacements = {
				KIE_WEBHOOK_SECRET: "非hex-fixture/+=#\\literal\\n",
				VIDEO_SEEAPI_CALLBACK_SECRET: "x".repeat(32),
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					whkey_current: "whsec_current-fixture-secret",
				}),
			};
			const source = Object.entries(existing)
				.map(([name, value]) => `${name}='${value}'`)
				.join("\n");
			const parsed = parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: source,
					[key]: replacements[key as keyof typeof replacements],
					VIDEO_V1_ENABLED: "true",
				}),
			);
			expect(parsed).toEqual({
				...existing,
				[key]: replacements[key as keyof typeof replacements],
			});
		},
	);

	it.each([32, 512])("preserves valid callback secret length %i", (length) => {
		const secret = "x".repeat(length);
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
					VIDEO_SEEAPI_CALLBACK_SECRET: secret,
				}),
			).VIDEO_SEEAPI_CALLBACK_SECRET,
		).toBe(secret);
	});

	it("keeps a maximal eight-key map with mixed dotenv punctuation valid", () => {
		const keys = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`whkey_${String(index).padStart(128, "x")}`,
				`whsec_${"'`#".repeat(85)}x`,
			]),
		);
		const parsed = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
				VIDEO_SEEAPI_CALLBACK_SECRET: "x".repeat(32),
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify(keys),
			}),
		);
		expect(JSON.parse(parsed.SEEAPI_WEBHOOK_SIGNING_KEYS!)).toEqual(keys);
		expect(readVideoSeeapiCallbackConfig(parsed).ready).toBe(true);
	});

	it.each([
		["KIE_WEBHOOK_SECRET", ""],
		["KIE_WEBHOOK_SECRET", "   "],
		["KIE_WEBHOOK_SECRET", "fixture\nVIDEO_V1_ENABLED=true"],
		["KIE_WEBHOOK_SECRET", "fixture\rINJECTED=true"],
		["KIE_WEBHOOK_SECRET", "fixture\0value"],
		["VIDEO_SEEAPI_CALLBACK_SECRET", ""],
		["VIDEO_SEEAPI_CALLBACK_SECRET", "x".repeat(31)],
		["VIDEO_SEEAPI_CALLBACK_SECRET", "x".repeat(513)],
		["VIDEO_SEEAPI_CALLBACK_SECRET", " ".repeat(32)],
		["VIDEO_SEEAPI_CALLBACK_SECRET", "x".repeat(31) + "中"],
		["VIDEO_SEEAPI_CALLBACK_SECRET", "x".repeat(32) + "\nINJECTED=true"],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", ""],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", "not-json-sensitive-fixture"],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", "{}"],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", "[]"],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", "null"],
		[
			"SEEAPI_WEBHOOK_SIGNING_KEYS",
			JSON.stringify({ key_current: "whsec_fixture-signing-secret" }),
		],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", JSON.stringify({ whkey_: "whsec_fixture-signing-secret" })],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", JSON.stringify({ whkey_current: "whsec_short" })],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", JSON.stringify({ whkey_current: "fixture-signing-secret" })],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", JSON.stringify({ whkey_current: 123 })],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", JSON.stringify({ whkey_current: "whsec_" + "x".repeat(257) })],
		[
			"SEEAPI_WEBHOOK_SIGNING_KEYS",
			JSON.stringify({ whkey_current: "whsec_fixture\nINJECTED=true" }),
		],
		["SEEAPI_WEBHOOK_SIGNING_KEYS", " ".repeat(8193)],
		[
			"SEEAPI_WEBHOOK_SIGNING_KEYS",
			JSON.stringify(
				Object.fromEntries(
					Array.from({ length: 9 }, (_, index) => [
						`whkey_${index}`,
						"whsec_fixture-signing-secret",
					]),
				),
			),
		],
	])("rejects an invalid %s override without echoing its value", (key, value) => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: `${key}=existing\nPRIVATE_KEY=unchanged\n`,
				[key]: value,
			}),
		).toThrow(new Error(`CLOUDFLARE_VIDEO_CALLBACK_OVERRIDE_INVALID: ${key}`));
	});

	it("updates the public brand without replacing unrelated production configuration", () => {
		const source = "PRIVATE_KEY=unchanged\nNEXT_PUBLIC_SITE_NAME=EzPic\nBILLING_ENABLED=true\n";
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					...unpackValues(packCloudflareBuildEnvironment(source)),
					NEXT_PUBLIC_SITE_NAME: "EzImageAI",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			NEXT_PUBLIC_SITE_NAME: "EzImageAI",
			BILLING_ENABLED: "true",
		});
	});
	it.each(["", "EzImageAI\nPRIVATE_KEY=changed", '"EzImageAI"', "x".repeat(101)])(
		"rejects an invalid public brand override: %s",
		(brand) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
					NEXT_PUBLIC_SITE_NAME: brand,
				}),
			).toThrow("CLOUDFLARE_PUBLIC_BRAND_OVERRIDE_INVALID");
		},
	);
	it("supports an explicit paired unlimited override and preserves unrelated production secrets", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV:
						"PRIVATE_KEY=unchanged\nGUEST_RISK_BUDGET_MICROS=200000\nGUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: "unlimited",
					GUEST_HARD_BUDGET_MICROS: "unlimited",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			GUEST_RISK_BUDGET_MICROS: "unlimited",
			GUEST_HARD_BUDGET_MICROS: "unlimited",
		});
	});
	it("rejects a partial unlimited build override", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV:
					"GUEST_RISK_BUDGET_MICROS=200000\nGUEST_HARD_BUDGET_MICROS=200000\n",
				GUEST_HARD_BUDGET_MICROS: "unlimited",
			}),
		).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
	});
	it("updates the guest risk budget within the existing hard cap without changing other secrets", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV:
						"PRIVATE_KEY=unchanged\nGUEST_RISK_BUDGET_MICROS=40000\nGUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: "200000",
				}),
			),
		).toEqual({
			PRIVATE_KEY: "unchanged",
			GUEST_RISK_BUDGET_MICROS: "200000",
			GUEST_HARD_BUDGET_MICROS: "200000",
		});
	});
	it.each(["0", "-1", "200001", "unlimited", "200000\nPRIVATE_KEY=changed"])(
		"rejects invalid or excessive guest budget overrides: %s",
		(budget) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "GUEST_HARD_BUDGET_MICROS=200000\n",
					GUEST_RISK_BUDGET_MICROS: budget,
					GUEST_HARD_BUDGET_MICROS: "999999999",
				}),
			).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
		},
	);
	it("requires an existing hard cap before accepting a guest budget override", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
				GUEST_RISK_BUDGET_MICROS: "200000",
			}),
		).toThrow("CLOUDFLARE_GUEST_BUDGET_OVERRIDE_INVALID");
	});
	it("overrides only the three daily guest limits without rewriting production secrets", () => {
		const limits = {
			GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
			GUEST_IP_MAX_PER_10_MINUTES: "2",
		};
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\nGUEST_IP_MAX_PER_10_MINUTES=1\n",
					...limits,
				}),
			),
		).toEqual({ PRIVATE_KEY: "unchanged", ...limits });
	});
	it("rejects partial or excessive daily guest overrides", () => {
		for (const limits of [
			{ GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "2" },
			{
				GUEST_SESSION_MAX_ACCEPTED_PER_DAY: "3",
				GUEST_DEVICE_MAX_ACCEPTED_PER_DAY: "2",
				GUEST_IP_MAX_PER_10_MINUTES: "2",
			},
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
					...limits,
				}),
			).toThrow("CLOUDFLARE_GUEST_QUOTA_OVERRIDES_INVALID");
		}
	});
	it.each(["test", "sightengine"])(
		"ignores an ambient %s adapter unless configured moderation overrides are requested",
		(adapter) => {
			const source = "MEDIA_SAFETY_ADAPTER=configured\nPRIVATE_KEY=unchanged\n";
			expect(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: source,
					MEDIA_SAFETY_ADAPTER: adapter,
				}),
			).toBe(source);
		},
	);
	it("can add a server-only image scanner credential without rewriting the secret bundle", () => {
		expect(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged\n",
					SEEAPI_API_KEY: "x".repeat(16),
				}),
			),
		).toEqual({ PRIVATE_KEY: "unchanged", SEEAPI_API_KEY: "x".repeat(16) });
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
				SEEAPI_API_KEY: "key\nOTHER=value",
			}),
		).toThrow("CLOUDFLARE_SEEAPI_KEY_INVALID");
	});
	it("refuses partial switches or disabling every detector", () => {
		for (const overrides of [
			{ MEDIA_SAFETY_ADAPTER: "configured" },
			{
				MEDIA_SAFETY_ADAPTER: "configured",
				MODERATION_TEXT_WAFFO_ENABLED: "false",
				MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			},
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged",
					...overrides,
				}),
			).toThrow("CLOUDFLARE_MODERATION_OVERRIDES_INVALID");
		}
	});
	it("applies explicit moderation switches without replacing unrelated production secrets", () => {
		const source = "MEDIA_SAFETY_ADAPTER=configured\nPRIVATE_KEY=unchanged\n";
		const switches = {
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
		};
		expect(
			parseEnv(readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source, ...switches })),
		).toEqual({ PRIVATE_KEY: "unchanged", ...switches });
	});
	it("keeps existing short dotenv secrets compatible", () => {
		const source = "NEXT_PUBLIC_SAAS_URL=https://ezimageai.com\nPRIVATE_KEY=example\n";
		const variables = packCloudflareBuildEnvironment(source);
		expect(Object.keys(variables)).toEqual(["CLOUDFLARE_PRODUCTION_ENV"]);
		expect(readCloudflareBuildEnvironment(unpackValues(variables))).toBe(source);
		expect(() => readCloudflareBuildEnvironment({})).toThrow("CLOUDFLARE_BUILD_SECRET_REQUIRED");
	});

	it("fits long Unicode dotenv content within Cloudflare's per-variable limit", () => {
		const source = `PRIVATE_VALUE="${"中文🌄\\nquoted text ".repeat(1000)}"\n`;
		const variables = packCloudflareBuildEnvironment(source);
		expect(Object.keys(variables).length).toBeGreaterThan(2);
		for (const variable of Object.values(variables)) {
			expect(variable.is_secret).toBe(true);
			expect(variable.value.length).toBeLessThanOrEqual(5000);
			expect(Buffer.from(variable.value, "utf8").toString("utf8")).toBe(variable.value);
		}
		expect(readCloudflareBuildEnvironment(unpackValues(variables))).toBe(source);
	});

	it("rejects incomplete or mixed secrets before use without echoing their values", () => {
		const environment = unpackValues(packCloudflareBuildEnvironment("sensitive".repeat(1000)));
		const missing = { ...environment };
		delete missing.CLOUDFLARE_PRODUCTION_ENV_PART_2;
		expect(() => readCloudflareBuildEnvironment(missing)).toThrow(
			"CLOUDFLARE_BUILD_SECRET_PART_INVALID: 2",
		);
		expect(() =>
			readCloudflareBuildEnvironment({
				...environment,
				CLOUDFLARE_PRODUCTION_ENV_PART_2: "private-replacement",
			}),
		).toThrow("CLOUDFLARE_BUILD_SECRET_CHECKSUM_MISMATCH");
	});

	it("bounds manifests and refuses oversized inputs", () => {
		for (const source of ["parts:0:bad", `parts:17:${"a".repeat(64)}`, "parts:2:bad"]) {
			expect(() => readCloudflareBuildEnvironment({ CLOUDFLARE_PRODUCTION_ENV: source })).toThrow(
				"CLOUDFLARE_BUILD_SECRET_MANIFEST_INVALID",
			);
		}
		expect(() => packCloudflareBuildEnvironment("a".repeat(72001))).toThrow(
			"CLOUDFLARE_BUILD_SECRET_TOO_LARGE",
		);
	});

	it("removes every secret part from subprocess environments while preserving deployment auth", () => {
		const environment = {
			...unpackValues(packCloudflareBuildEnvironment("private-data".repeat(1000))),
			CLOUDFLARE_PRODUCTION_ENV_PART_16: "stale-part",
			CLOUDFLARE_API_TOKEN: "deployment-token",
			SEEAPI_API_KEY: "private-image-scanner-key",
			KIE_WEBHOOK_SECRET: "private-kie-webhook-secret",
			VIDEO_SEEAPI_CALLBACK_SECRET: "private-seeapi-callback-secret",
			SEEAPI_WEBHOOK_SIGNING_KEYS: "private-seeapi-signing-keys",
			PATH: "tools",
		};
		expect(withoutCloudflareBuildSecrets(environment)).toEqual({
			CLOUDFLARE_API_TOKEN: "deployment-token",
			PATH: "tools",
		});
		expect(environment.CLOUDFLARE_PRODUCTION_ENV_PART_16).toBe("stale-part");
	});
});
