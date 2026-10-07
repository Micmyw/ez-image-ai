import { parseEnv } from "node:util";

import {
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_TEMPLATE_VERSION,
	RAINDANCE_TEMPLATE_VERSION,
	resolveVideoEffectPrice,
} from "@repo/config/video-effects.server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
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
describe("Cloudflare build secret transport", () => {
	it.each(["2026-10-12T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "none"])(
		"cancels only the explicitly selected ordinary price deadline from %s",
		(validUntil) => {
			const policy = {
				VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_PRICE_BASIS: "original-cost-evidence",
				VIDEO_PRICE_VALID_UNTIL: validUntil,
				VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				VIDEO_V1_ACCESS: "authenticated",
				VIDEO_COST_RUNTIME_MICROS: "100000",
				VIDEO_COST_PAYMENT_FEE_BPS: "654",
				VIDEO_INTERNAL_FUNDING: "original-ordinary-funding",
				HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
				HOTEL_LOBBY_DUO_PRICE_BASIS: "original-template-budget",
				HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "original-template-funding",
				RAINDANCE_ACCESS: "authenticated",
			};
			const input = {
				CLOUDFLARE_PRODUCTION_ENV: `PRIVATE_KEY=unchanged-fixture\nVIDEO_V1_ENABLED=true\nVIDEO_PRICE_VALID_UNTIL=${validUntil}`,
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
				VIDEO_V1_BUILD_PRICE_EXPIRY: "none",
			};
			const snapshot = { ...input };
			const observed: unknown[] = [];
			const output = parseEnv(
				readCloudflareBuildEnvironment(input, (evidence) => observed.push(evidence)),
			);
			expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual({
				...policy,
				VIDEO_PRICE_VALID_UNTIL: "none",
			});
			expect(expandVideoRuntimeEnvironment(output)).toMatchObject({
				PRIVATE_KEY: "unchanged-fixture",
				VIDEO_V1_ENABLED: "true",
				VIDEO_PRICE_VALID_UNTIL: "none",
			});
			expect(observed).toEqual([
				{
					previousVersion: VIDEO_SUPPLIER_PRICE_VERSION,
					nextVersion: VIDEO_SUPPLIER_PRICE_VERSION,
					validUntil,
				},
			]);
			expect(input).toEqual(snapshot);
			expect(output).not.toHaveProperty("VIDEO_V1_BUILD_PRICE_EXPIRY");
			expect(withoutCloudflareBuildSecrets(input)).toEqual({});
		},
	);
	it.each([undefined, "", "invalid-date", "None", "unlimited"])(
		"never invents an inherited deadline for expiry cancellation (%s)",
		(validUntil) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: JSON.stringify({
						VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
						VIDEO_PRICE_BASIS: "original-cost-evidence",
						VIDEO_PRICE_VALID_UNTIL: validUntil,
					}),
					VIDEO_V1_BUILD_PRICE_EXPIRY: "none",
				}),
			).toThrow(/^VIDEO_BUILD_PRICE_POLICY_REQUIRED$/);
		},
	);
	it.each(["", "None", " none", "none ", "2100-01-01", "false", "none\nINJECTED=true"])(
		"rejects a malformed build expiry control %j",
		(value) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_V1_BUILD_PRICE_EXPIRY: value,
				}),
			).toThrow(/^VIDEO_BUILD_PRICE_EXPIRY_OVERRIDE_INVALID$/);
		},
	);
	it("does not cancel a legacy price snapshot unless its version approval migrates in the same build", () => {
		const input = {
			CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
			VIDEO_RUNTIME_CONFIG: JSON.stringify({
				VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
				VIDEO_PRICE_BASIS: "original-cost-evidence",
				VIDEO_PRICE_VALID_UNTIL: "2000-01-01T00:00:00.000Z",
			}),
			VIDEO_V1_BUILD_PRICE_EXPIRY: "none",
		};
		expect(() => readCloudflareBuildEnvironment(input)).toThrow(
			/^VIDEO_BUILD_PRICE_POLICY_REQUIRED$/,
		);
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				...input,
				VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_V1_BUILD_PRICE_BASIS: "new-public-supplier-source",
			}),
		);
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual({
			VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_PRICE_BASIS: "original-cost-evidence; new-public-supplier-source",
			VIDEO_PRICE_VALID_UNTIL: "none",
		});
	});
	it("accepts a persisted explicit none deadline during supplier evidence migration", () => {
		const observed: unknown[] = [];
		const output = parseEnv(
			readCloudflareBuildEnvironment(
				{
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: JSON.stringify({
						VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
						VIDEO_PRICE_BASIS: "original-cost-evidence",
						VIDEO_PRICE_VALID_UNTIL: "none",
					}),
					VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
					VIDEO_V1_BUILD_PRICE_BASIS: "new-public-supplier-source",
				},
				(evidence) => observed.push(evidence),
			),
		);
		expect(expandVideoRuntimeEnvironment(output).VIDEO_PRICE_VALID_UNTIL).toBe("none");
		expect(observed).toEqual([
			{
				previousVersion: VIDEO_SUPPLIER_PRICE_VERSION,
				nextVersion: VIDEO_SUPPLIER_PRICE_VERSION,
				validUntil: "none",
			},
		]);
	});
	it("keeps an inherited finite deadline when only an ambient runtime expiry tries to cancel it", () => {
		const policy = {
			VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_PRICE_BASIS: "original-cost-evidence",
			VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
		};
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
				VIDEO_PRICE_VALID_UNTIL: "none",
			}),
		);
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
	});
	it.each(["kie-public-2026-10-04.3", VIDEO_SUPPLIER_PRICE_VERSION])(
		"migrates only supplier approval from %s and appends evidence without changing the inherited expiry",
		(previousVersion) => {
			const base = {
				VIDEO_PRICE_ACCEPTED_VERSION: previousVersion,
				VIDEO_PRICE_BASIS: "original approved supplier, moderation and runtime costs",
				VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
				VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				VIDEO_COST_RUNTIME_MICROS: "100000",
				VIDEO_COST_PAYMENT_FEE_BPS: "654",
				VIDEO_INTERNAL_FUNDING: "original-ordinary-funding",
				HOTEL_LOBBY_DUO_ACCESS: "authenticated",
				HOTEL_LOBBY_DUO_PRICE_BASIS: "original-template-budget",
				HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "original-template-funding",
				RAINDANCE_ACCESS: "internal",
			};
			const appendix = "Kie public model source https://kie.ai/model-pricing updated 2026-10-07";
			const source = `PRIVATE_KEY=unchanged-fixture\nVIDEO_V1_ENABLED=true\nVIDEO_PRICE_ACCEPTED_VERSION=${previousVersion}\nVIDEO_PRICE_BASIS='${base.VIDEO_PRICE_BASIS}'\nVIDEO_PRICE_VALID_UNTIL=${base.VIDEO_PRICE_VALID_UNTIL}`;
			const input = {
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
				VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_V1_BUILD_PRICE_BASIS: appendix,
			};
			const snapshot = { ...input };
			const observed: unknown[] = [];
			const output = parseEnv(
				readCloudflareBuildEnvironment(input, (evidence) => observed.push(evidence)),
			);
			const expected = {
				...base,
				VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_PRICE_BASIS: `${base.VIDEO_PRICE_BASIS}; ${appendix}`,
			};
			expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(expected);
			expect(expandVideoRuntimeEnvironment(output)).toMatchObject({
				...expected,
				PRIVATE_KEY: "unchanged-fixture",
				VIDEO_V1_ENABLED: "true",
			});
			expect(observed).toEqual([
				{
					previousVersion,
					nextVersion: VIDEO_SUPPLIER_PRICE_VERSION,
					validUntil: base.VIDEO_PRICE_VALID_UNTIL,
				},
			]);
			expect(input).toEqual(snapshot);
			expect(withoutCloudflareBuildSecrets(input)).toEqual({});
			for (const key of ["VIDEO_V1_BUILD_PRICE_VERSION", "VIDEO_V1_BUILD_PRICE_BASIS"])
				expect(output).not.toHaveProperty(key);
			const repeated = parseEnv(
				readCloudflareBuildEnvironment({
					...input,
					CLOUDFLARE_PRODUCTION_ENV: readCloudflareBuildEnvironment(input),
					VIDEO_RUNTIME_CONFIG: output.VIDEO_RUNTIME_CONFIG,
				}),
			);
			expect(JSON.parse(repeated.VIDEO_RUNTIME_CONFIG!)).toEqual(expected);
		},
	);
	it("leaves price approval unchanged when both build controls are absent", () => {
		const policy = {
			VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
			VIDEO_PRICE_BASIS: "existing-price-evidence",
			VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
		};
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			}),
		);
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
	});
	it.each([
		{ VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION },
		{ VIDEO_V1_BUILD_PRICE_BASIS: "supplier-source" },
		{
			VIDEO_V1_BUILD_PRICE_VERSION: "arbitrary-price-version",
			VIDEO_V1_BUILD_PRICE_BASIS: "source",
		},
		{
			VIDEO_V1_BUILD_PRICE_VERSION: "kie-public-2026-10-04.3",
			VIDEO_V1_BUILD_PRICE_BASIS: "source",
		},
		{ VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION, VIDEO_V1_BUILD_PRICE_BASIS: "" },
		{
			VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_V1_BUILD_PRICE_BASIS: "  ",
		},
		{
			VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_V1_BUILD_PRICE_BASIS: "source\nINJECTED=true",
		},
	])("rejects partial or malformed supplier price build controls", (overrides) => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				...overrides,
			}),
		).toThrow(/^VIDEO_BUILD_PRICE_OVERRIDE_INVALID$/);
	});
	it.each([
		{},
		{ VIDEO_PRICE_BASIS: "" },
		{ VIDEO_PRICE_BASIS: "  " },
		{ VIDEO_PRICE_ACCEPTED_VERSION: "arbitrary-unapproved-version" },
		{ VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.2" },
		{ VIDEO_PRICE_VALID_UNTIL: "invalid-date" },
		{ VIDEO_PRICE_VALID_UNTIL: "2000-01-01T00:00:00.000Z" },
		{ VIDEO_PRICE_VALID_UNTIL: new Date(Date.now()).toISOString() },
	])("refuses invalid or expired inherited approval before replacing it", (overrides) => {
		const base = Object.keys(overrides).length
			? {
					VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
					VIDEO_PRICE_BASIS: "original-price-evidence",
					VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
					...overrides,
				}
			: {};
		const observed: unknown[] = [];
		expect(() =>
			readCloudflareBuildEnvironment(
				{
					CLOUDFLARE_PRODUCTION_ENV: "PRIVATE_KEY=unchanged-fixture",
					VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
					VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
					VIDEO_V1_BUILD_PRICE_BASIS: "new-public-supplier-source",
				},
				(evidence) => observed.push(evidence),
			),
		).toThrow(/^VIDEO_BUILD_PRICE_POLICY_REQUIRED$/);
		expect(observed).toEqual([]);
	});
	it("rejects existing price flat/packed conflicts without logging policy", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_PRICE_BASIS=conflicting-flat-evidence",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
					VIDEO_PRICE_BASIS: "original-price-evidence",
					VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
				}),
				VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_V1_BUILD_PRICE_BASIS: "new-public-supplier-source",
			}),
		).toThrow(/^VIDEO_RUNTIME_CONFIG_CONFLICT$/);
	});
	it("refuses an oversized price appendix without dropping inherited cost evidence", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
					VIDEO_PRICE_BASIS: "x".repeat(2800),
					VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
				}),
				VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_V1_BUILD_PRICE_BASIS: "y".repeat(2800),
			}),
		).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
	});
	it.each(["authenticated", "internal"])(
		"changes only ordinary video access through the dedicated %s build control",
		(access) => {
			const base = {
				VIDEO_V1_ACCESS: access === "internal" ? "authenticated" : "internal",
				VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				VIDEO_INTERNAL_FUNDING: "original-ordinary-funding",
				VIDEO_PRICE_BASIS: "original-cost-evidence",
				HOTEL_LOBBY_DUO_ACCESS: "authenticated",
				HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "original-template-funding",
				RAINDANCE_ACCESS: "internal",
			};
			const source = `UNRELATED=secret-fixture\nVIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false\nKIE_API_KEY=provider-fixture\nVIDEO_V1_ACCESS=${base.VIDEO_V1_ACCESS}`;
			const input = {
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
				VIDEO_V1_BUILD_ACCESS: access,
				VIDEO_V1_ACCESS: "public",
			};
			const snapshot = { ...input };
			const output = parseEnv(readCloudflareBuildEnvironment(input));
			expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual({
				...base,
				VIDEO_V1_ACCESS: access,
			});
			expect(expandVideoRuntimeEnvironment(output)).toMatchObject({
				...parseEnv(source),
				...base,
				VIDEO_V1_ACCESS: access,
			});
			expect(output).not.toHaveProperty("VIDEO_V1_BUILD_ACCESS");
			expect(input).toEqual(snapshot);
			expect(withoutCloudflareBuildSecrets(input)).toEqual({});
			expect(
				publicBuildVariables(
					Object.fromEntries(
						Object.entries(output).filter(
							(entry): entry is [string, string] => entry[1] !== undefined,
						),
					),
				),
			).toEqual({});
		},
	);
	it("preserves ordinary access without a dedicated override and ignores ambient access", () => {
		const policy = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
		};
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
				VIDEO_V1_ACCESS: "authenticated",
			}),
		);
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
	});
	it.each([
		"",
		"public",
		"anonymous",
		"TRUE",
		" authenticated",
		"authenticated ",
		"internal\nINJECTED=true",
	])("rejects invalid ordinary video build access %j without echoing its value", (access) => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_V1_BUILD_ACCESS: access,
			}),
		).toThrow(/^VIDEO_BUILD_ACCESS_OVERRIDE_INVALID$/);
	});
	it.each([undefined, "{}", '{"VIDEO_MODEL_CONTRACT_VERSION":"obsolete"}'])(
		"requires the build runner's current server model contract for ordinary access (%s)",
		(base) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: base,
					VIDEO_V1_BUILD_ACCESS: "authenticated",
				}),
			).toThrow(/^VIDEO_BUILD_ACCESS_POLICY_REQUIRED$/);
		},
	);
	it("rejects preexisting flat/packed conflicts before applying ordinary access", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true\nVIDEO_V1_ACCESS=authenticated",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_V1_ACCESS: "internal",
					VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				}),
				VIDEO_V1_BUILD_ACCESS: "authenticated",
			}),
		).toThrow(/^VIDEO_RUNTIME_CONFIG_CONFLICT$/);
	});
	it("merges ordinary access into a split bundle while preserving opaque secrets", () => {
		const source = `VIDEO_V1_ENABLED=false\nPRIVATE_KEY=${"secret-fixture".repeat(500)}\n`;
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				...unpackValues(packCloudflareBuildEnvironment(source)),
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_V1_ACCESS: "internal",
					VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				}),
				VIDEO_V1_BUILD_ACCESS: "authenticated",
			}),
		);
		expect(output.PRIVATE_KEY).toBe(parseEnv(source).PRIVATE_KEY);
		expect(output.VIDEO_V1_ENABLED).toBe("false");
		expect(expandVideoRuntimeEnvironment(output).VIDEO_V1_ACCESS).toBe("authenticated");
	});
	it("refuses an access merge that exceeds the private policy size limit", () => {
		const base = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
			VIDEO_PRICE_BASIS: "",
		};
		base.VIDEO_PRICE_BASIS = "x".repeat(5000 - Buffer.byteLength(JSON.stringify(base)));
		expect(Buffer.byteLength(JSON.stringify(base))).toBe(5000);
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
				VIDEO_V1_BUILD_ACCESS: "authenticated",
			}),
		).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
	});
	it("composes ordinary access with independent template overlays without changing the model contract", () => {
		const base = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
			VIDEO_PRICE_BASIS: "original-cost-evidence",
			VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
			VIDEO_INTERNAL_FUNDING: "original-ordinary-funding",
			HOTEL_LOBBY_DUO_ACCESS: "internal",
			HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "original-template-funding",
			RAINDANCE_ACCESS: "internal",
		};
		const output = expandVideoRuntimeEnvironment(
			parseEnv(
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true\nVIDEO_V1_ACCESS=internal",
					VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
					VIDEO_V1_BUILD_ACCESS: "authenticated",
					VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
					VIDEO_V1_BUILD_PRICE_BASIS: "new-public-supplier-source",
					VIDEO_V1_BUILD_PRICE_EXPIRY: "none",
					HOTEL_LOBBY_DUO_RUNTIME_CONFIG: '{"HOTEL_LOBBY_DUO_ACCESS":"authenticated"}',
					RAINDANCE_RUNTIME_CONFIG: '{"RAINDANCE_ACCESS":"authenticated"}',
				}),
			),
		);
		expect(output).toMatchObject({
			VIDEO_V1_ACCESS: "authenticated",
			VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_PRICE_BASIS: "original-cost-evidence; new-public-supplier-source",
			VIDEO_PRICE_VALID_UNTIL: "none",
			HOTEL_LOBBY_DUO_ACCESS: "authenticated",
			RAINDANCE_ACCESS: "authenticated",
			VIDEO_INTERNAL_FUNDING: base.VIDEO_INTERNAL_FUNDING,
			HOTEL_LOBBY_DUO_INTERNAL_FUNDING: base.HOTEL_LOBBY_DUO_INTERNAL_FUNDING,
		});
		expect(output.VIDEO_MODEL_CONTRACT_VERSION).toBe(VIDEO_MODEL_CATALOG_VERSION);
	});
	it("merges a narrow private template patch over the build's current base and preserves the ordinary model contract", () => {
		const base = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
			VIDEO_INTERNAL_FUNDING: "original-ordinary-funding",
			HOTEL_LOBBY_DUO_INTERNAL_FUNDING: "original-template-funding",
			HOTEL_LOBBY_DUO_PRICE_BASIS: "old-template-price",
		};
		const patch = {
			HOTEL_LOBBY_DUO_ACCESS: "authenticated",
			HOTEL_LOBBY_DUO_PRICE_BASIS: "new budget, not invoice",
		};
		const environment = {
			CLOUDFLARE_PRODUCTION_ENV:
				"UNRELATED=secret-fixture\nVIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false\nHOTEL_LOBBY_DUO_PRICE_BASIS=old-template-price",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
			HOTEL_LOBBY_DUO_RUNTIME_CONFIG: JSON.stringify(patch),
		};
		const snapshot = { ...environment };
		const output = parseEnv(readCloudflareBuildEnvironment(environment));
		const merged = expandVideoRuntimeEnvironment(output);
		for (const [key, value] of Object.entries(base))
			if (key !== "HOTEL_LOBBY_DUO_PRICE_BASIS") expect(merged[key]).toBe(value);
		expect(merged).toMatchObject({
			...patch,
			VIDEO_V1_ENABLED: "true",
			HOTEL_LOBBY_DUO_ENABLED: "false",
			UNRELATED: "secret-fixture",
		});
		expect(output).not.toHaveProperty("HOTEL_LOBBY_DUO_RUNTIME_CONFIG");
		expect(merged.VIDEO_MODEL_CONTRACT_VERSION).toBe(VIDEO_MODEL_CATALOG_VERSION);
		const repeated = expandVideoRuntimeEnvironment(
			parseEnv(
				readCloudflareBuildEnvironment({
					...environment,
					CLOUDFLARE_PRODUCTION_ENV: readCloudflareBuildEnvironment(environment),
					VIDEO_RUNTIME_CONFIG: output.VIDEO_RUNTIME_CONFIG,
				}),
			),
		);
		expect(repeated.VIDEO_MODEL_CONTRACT_VERSION).toBe(merged.VIDEO_MODEL_CONTRACT_VERSION);
		expect(environment).toEqual(snapshot);
		expect(withoutCloudflareBuildSecrets(environment)).toEqual({});
	});
	it.each([undefined, "", "{}", "invalid", '{"VIDEO_MODEL_CONTRACT_VERSION":"obsolete"}'])(
		"requires an actual current base for a template patch (%s)",
		(base) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: base,
					HOTEL_LOBBY_DUO_RUNTIME_CONFIG: '{"HOTEL_LOBBY_DUO_ACCESS":"authenticated"}',
				}),
			).toThrow();
		},
	);
	it("refuses template patches that change ordinary policy, funding, switches or secrets", () => {
		for (const key of [
			"VIDEO_V1_ACCESS",
			"VIDEO_MODEL_CONTRACT_VERSION",
			"VIDEO_INTERNAL_FUNDING",
			"HOTEL_LOBBY_DUO_INTERNAL_FUNDING",
			"HOTEL_LOBBY_DUO_ENABLED",
			"KIE_API_KEY",
		]) {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: JSON.stringify({
						VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
					}),
					HOTEL_LOBBY_DUO_RUNTIME_CONFIG: JSON.stringify({ [key]: "do-not-print-this" }),
				}),
			).toThrow(/^HOTEL_LOBBY_RUNTIME_OVERRIDE_INVALID$/);
		}
	});
	it("rejects a merged policy over 5000 bytes without dropping existing fields", () => {
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
					VIDEO_PRICE_BASIS: "x".repeat(2800),
				}),
				HOTEL_LOBBY_DUO_RUNTIME_CONFIG: JSON.stringify({
					HOTEL_LOBBY_DUO_PRICE_BASIS: "y".repeat(2800),
				}),
			}),
		).toThrow(/^VIDEO_RUNTIME_CONFIG_INVALID$/);
	});
	it("validates the merged 69-credit quote before the separate template build switch can open", () => {
		const base = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
			VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_PRICE_BASIS: "isolated budget fixture",
			VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00Z",
			VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
			VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
			VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
			VIDEO_COST_MODERATION_BASE_MICROS: "5100",
			VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
			VIDEO_COST_RUNTIME_MICROS: "100000",
			VIDEO_COST_STORAGE_MICROS: "10000",
			VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
			VIDEO_COST_PAYMENT_FEE_BPS: "654",
			VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
		};
		const patch = {
			HOTEL_LOBBY_DUO_ACCESS: "authenticated",
			HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
			HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
			HOTEL_LOBBY_DUO_PRICE_BASIS: "isolated template budget, not invoice",
			HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00Z",
			HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "20000",
			HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: "750",
			HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "isolated payment budget",
			HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
			HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: base.VIDEO_COST_TEXT_RULE_VERSION,
			HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "isolated text fixture",
			HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
			HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
			HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
			HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
			HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
			HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
		};
		const input = {
			CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
			HOTEL_LOBBY_DUO_RUNTIME_CONFIG: JSON.stringify(patch),
			HOTEL_LOBBY_DUO_BUILD_ENABLED: "true",
		};
		const merged = expandVideoRuntimeEnvironment(parseEnv(readCloudflareBuildEnvironment(input)));
		const raindance = expandVideoRuntimeEnvironment(
			parseEnv(
				readCloudflareBuildEnvironment({
					...input,
					RAINDANCE_RUNTIME_CONFIG: JSON.stringify({
						RAINDANCE_ENABLED: "true",
						RAINDANCE_ACCESS: "authenticated",
						RAINDANCE_ACCEPTED_TEMPLATE_VERSION: RAINDANCE_TEMPLATE_VERSION,
					}),
				}),
			),
		);
		expect(raindance.RAINDANCE_ACCESS).toBe("authenticated");
		for (const [key, value] of Object.entries(merged))
			expect(raindance[key]).toBe(key === "VIDEO_RUNTIME_CONFIG" ? raindance[key] : value);
		expect(
			resolveVideoEffectPrice(
				{
					effectId: "raindance-solo",
					presetKey: "standard",
					inputs: { leftAssetId: "one", rightAssetId: "one" },
				},
				raindance,
			).credits,
		).toBe(69n);
		expect(() =>
			readCloudflareBuildEnvironment({
				...input,
				RAINDANCE_RUNTIME_CONFIG: JSON.stringify({ VIDEO_V1_ACCESS: "authenticated" }),
			}),
		).toThrow("RAINDANCE_RUNTIME_OVERRIDE_INVALID");
		expect(
			withoutCloudflareBuildSecrets({
				RAINDANCE_RUNTIME_CONFIG: "private",
				RAINDANCE_ACCESS: "authenticated",
				RAINDANCE_ENABLED: "true",
			}),
		).toEqual({});
		expect(merged.HOTEL_LOBBY_DUO_ENABLED).toBe("true");
		expect(merged.VIDEO_V1_ACCESS).toBe("internal");
		expect(
			resolveVideoEffectPrice(
				{
					effectId: "hotel-lobby-duo",
					presetKey: "standard",
					inputs: { leftAssetId: "fixture-left", rightAssetId: "fixture-right" },
				},
				merged,
			).credits,
		).toBe(69n);
		expect(() =>
			readCloudflareBuildEnvironment({
				...input,
				HOTEL_LOBBY_DUO_RUNTIME_CONFIG: JSON.stringify({
					...patch,
					HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2000-01-01T00:00:00Z",
				}),
			}),
		).toThrow(/^VIDEO_EFFECT_BUILD_ENABLED_POLICY_REQUIRED$/);
		expect(() =>
			readCloudflareBuildEnvironment({
				...input,
				HOTEL_LOBBY_DUO_RUNTIME_CONFIG: '{"HOTEL_LOBBY_DUO_ACCESS":"authenticated"}',
			}),
		).toThrow(/^VIDEO_EFFECT_BUILD_ENABLED_POLICY_REQUIRED$/);
	});
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
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				}),
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
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
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
	it("allows a dedicated emergency close without a policy override or server model contract", () => {
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
		const source = `VIDEO_V1_ENABLED=false\nVIDEO_RUNTIME_CONFIG='${JSON.stringify({ VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION })}'\n`;
		expect(() =>
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: source,
				VIDEO_V1_BUILD_ENABLED: "true",
			}),
		).toThrow(/^VIDEO_BUILD_ENABLED_POLICY_REQUIRED$/);
	});
	it.each([undefined, "", "obsolete-model-contract"])(
		"does not enable with a missing or outdated server model contract",
		(version) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=false",
					VIDEO_RUNTIME_CONFIG: JSON.stringify({ VIDEO_MODEL_CONTRACT_VERSION: version }),
					VIDEO_V1_BUILD_ENABLED: "true",
				}),
			).toThrow(/^VIDEO_BUILD_ENABLED_POLICY_REQUIRED$/);
		},
	);
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
			VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
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
