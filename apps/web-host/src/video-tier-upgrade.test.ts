import { parseEnv } from "node:util";

import { expandVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import { describe, expect, it } from "vitest";

import { readCloudflareBuildEnvironment, withoutCloudflareBuildSecrets } from "./build-secrets";

const base = {
	VIDEO_MODEL_CONTRACT_VERSION: "video-models-2026-10-04.2",
	VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-07.1",
	VIDEO_PRICE_BASIS: "existing-approved-complete-costs",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_V1_ACCESS: "authenticated",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	HOTEL_LOBBY_DUO_ACCESS: "internal",
	HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
	RAINDANCE_ACCESS: "internal",
};
const changes = {
	VIDEO_V1_BUILD_MODEL_VERSION: "video-models-2026-10-08.1",
	VIDEO_V1_BUILD_PRICE_VERSION: "kie-public-2026-10-08.1",
	VIDEO_V1_BUILD_PRICE_BASIS: "Veo region tariff observed 2026-10-08; no recharge bonus",
};
describe("explicit video tier contract deployment upgrade", () => {
	it.each(["none", "2100-01-01T00:00:00.000Z"])(
		"upgrades only known contract/version evidence while preserving %s and all policies",
		(deadline) => {
			const policy = { ...base, VIDEO_PRICE_VALID_UNTIL: deadline };
			const input = {
				CLOUDFLARE_PRODUCTION_ENV: `VIDEO_V1_ENABLED=true\nPRIVATE_KEY=unchanged\nVIDEO_MODEL_CONTRACT_VERSION=${base.VIDEO_MODEL_CONTRACT_VERSION}`,
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
				...changes,
			};
			const output = parseEnv(readCloudflareBuildEnvironment(input));
			const expected = {
				...policy,
				VIDEO_MODEL_CONTRACT_VERSION: changes.VIDEO_V1_BUILD_MODEL_VERSION,
				VIDEO_PRICE_ACCEPTED_VERSION: changes.VIDEO_V1_BUILD_PRICE_VERSION,
				VIDEO_PRICE_BASIS: `${base.VIDEO_PRICE_BASIS}; ${changes.VIDEO_V1_BUILD_PRICE_BASIS}`,
			};
			expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(expected);
			expect(expandVideoRuntimeEnvironment(output)).toMatchObject({
				...expected,
				VIDEO_V1_ENABLED: "true",
				PRIVATE_KEY: "unchanged",
			});
			expect(withoutCloudflareBuildSecrets(input)).toEqual({});
			expect(
				parseEnv(
					readCloudflareBuildEnvironment({
						...input,
						CLOUDFLARE_PRODUCTION_ENV: readCloudflareBuildEnvironment(input),
						VIDEO_RUNTIME_CONFIG: output.VIDEO_RUNTIME_CONFIG,
					}),
				),
			).toEqual(output);
		},
	);
	it.each([undefined, "", "unknown", "video-models-2026-10-04.1"])(
		"rejects unapproved source model contracts %s",
		(version) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
					VIDEO_RUNTIME_CONFIG: JSON.stringify({ ...base, VIDEO_MODEL_CONTRACT_VERSION: version }),
					...changes,
				}),
			).toThrow("VIDEO_BUILD_MODEL_POLICY_REQUIRED");
		},
	);
	it.each(["", "unknown", "video-models-2026-10-04.2", "video-models-2026-10-08.1\nINJECTED=true"])(
		"rejects invalid requested model upgrades %s",
		(version) => {
			expect(() =>
				readCloudflareBuildEnvironment({
					CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
					VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
					...changes,
					VIDEO_V1_BUILD_MODEL_VERSION: version,
				}),
			).toThrow("VIDEO_BUILD_MODEL_OVERRIDE_INVALID");
		},
	);
	it("does not upgrade a bundled historical contract without the explicit control", () => {
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
			}),
		);
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(base);
	});
});
