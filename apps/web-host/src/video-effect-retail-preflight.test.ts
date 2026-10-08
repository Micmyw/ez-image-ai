import { parseEnv } from "node:util";

import {
	VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_LONG_TEMPLATE_VERSION,
} from "@repo/config/video-effects";
import {
	HOTEL_LOBBY_TEMPLATE_VERSION,
	RAINDANCE_TEMPLATE_VERSION,
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
} from "@repo/config/video-effects.server";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { describe, expect, it } from "vitest";

import { readCloudflareBuildEnvironment, withoutCloudflareBuildSecrets } from "./build-secrets";
import { verifyApprovedVideoEffectPrices } from "./video-effect-retail-preflight";

// Synthetic copy of the approved budget for unit verification; live build evidence is separate.
const policy = {
	VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: HOTEL_LOBBY_LONG_TEMPLATE_VERSION,
	RAINDANCE_ENABLED: "true",
	RAINDANCE_ACCESS: "authenticated",
	RAINDANCE_ACCEPTED_TEMPLATE_VERSION: RAINDANCE_TEMPLATE_VERSION,
	RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: RAINDANCE_LONG_TEMPLATE_VERSION,
	HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
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
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "SYNTHETIC_TEST_BUDGET_ONLY",
	VIDEO_PRICE_VALID_UNTIL: "none",
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
describe("effect price release preflight", () => {
	it("recomputes all six options with effect costs and refuses price drift without exposing secrets", () => {
		const input = {
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			HOTEL_LOBBY_DUO_ENABLED: "true",
			KIE_API_KEY: "secret-sentinel",
		};
		const report = verifyApprovedVideoEffectPrices(input);
		expect(report).toMatchObject({ enabled: true, checked: 6, differences: 0 });
		expect(report.rows?.find((row) => row.duration === 10)?.standard).toMatchObject({
			directCostMicros: "437400",
			riskAdjustedCostMicros: "486000",
			costPolicy: { paymentFeeBps: "750", markupBps: "27500" },
		});
		expect(JSON.stringify(report)).not.toContain("secret-sentinel");
		expect(() =>
			verifyApprovedVideoEffectPrices({
				...input,
				VIDEO_RUNTIME_CONFIG: JSON.stringify({ ...policy, VIDEO_COST_RUNTIME_MICROS: "120000" }),
			}),
		).toThrow("VIDEO_EFFECT_APPROVED_PRICES_CHANGED");
		expect(() =>
			verifyApprovedVideoEffectPrices({
				...input,
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					...policy,
					HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2000-01-01",
				}),
			}),
		).toThrow("VIDEO_EFFECT_PRICE_EXPIRED");
	});
	it("adds only dedicated approvals and preserves access, ordinary pricing, funding and prior versions", () => {
		const {
			VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: _retail,
			HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: _hotel,
			RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: _rain,
			...base
		} = policy;
		const input = {
			CLOUDFLARE_PRODUCTION_ENV:
				"VIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false\nUNRELATED=kept",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(base),
			VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
		};
		const output = parseEnv(readCloudflareBuildEnvironment(input));
		expect(output.HOTEL_LOBBY_DUO_ENABLED).toBe("false");
		expect(output.UNRELATED).toBe("kept");
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
		expect(withoutCloudflareBuildSecrets(input)).not.toHaveProperty(
			"VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION",
		);
		expect(() =>
			readCloudflareBuildEnvironment({
				...input,
				VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION: "unknown",
			}),
		).toThrow("VIDEO_EFFECT_BUILD_RETAIL_POLICY_REQUIRED");
	});
	it("does not invent a production policy when approval is absent", () =>
		expect(verifyApprovedVideoEffectPrices({})).toEqual({ enabled: false, checked: 0 }));
	it("compacts only retired allowlists before the overlay while retaining the 5,000-byte bound", () => {
		const {
			VIDEO_EFFECT_RETAIL_PRICE_ACCEPTED_VERSION: _retail,
			HOTEL_LOBBY_DUO_ACCEPTED_LONG_TEMPLATE_VERSION: _hotel,
			RAINDANCE_ACCEPTED_LONG_TEMPLATE_VERSION: _rain,
			...base
		} = policy;
		const legacy = {
			...base,
			VIDEO_MODEL_ALLOWED_OPTIONS: "",
			VIDEO_V1_ALLOWED_USER_IDS: "retired-user",
		};
		legacy.VIDEO_MODEL_ALLOWED_OPTIONS = "x".repeat(
			4_990 - Buffer.byteLength(JSON.stringify(legacy)),
		);
		const input = {
			CLOUDFLARE_PRODUCTION_ENV:
				"VIDEO_V1_ENABLED=true\nHOTEL_LOBBY_DUO_ENABLED=false\nUNRELATED=kept",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(legacy),
			VIDEO_EFFECT_BUILD_RETAIL_PRICE_VERSION: VIDEO_EFFECT_RETAIL_PRICE_VERSION,
		};
		expect(Buffer.byteLength(input.VIDEO_RUNTIME_CONFIG)).toBe(4_990);
		const result = parseEnv(readCloudflareBuildEnvironment(input));
		expect(result.HOTEL_LOBBY_DUO_ENABLED).toBe("false");
		expect(result.UNRELATED).toBe("kept");
		expect(JSON.parse(result.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
		const active = { ...base, HOTEL_LOBBY_DUO_PRICE_BASIS: "" };
		active.HOTEL_LOBBY_DUO_PRICE_BASIS = "x".repeat(
			4_990 - Buffer.byteLength(JSON.stringify(active)),
		);
		expect(() =>
			readCloudflareBuildEnvironment({ ...input, VIDEO_RUNTIME_CONFIG: JSON.stringify(active) }),
		).toThrow("VIDEO_RUNTIME_CONFIG_INVALID");
	});
});
