import { parseEnv } from "node:util";

import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import {
	VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "@repo/config/video-pricing.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { describe, expect, it } from "vitest";

import { readCloudflareBuildEnvironment, withoutCloudflareBuildSecrets } from "./build-secrets";
import { verifyApprovedVideoRetailPrices } from "./video-retail-preflight";

const policy = {
	VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_PRICE_BASIS: "HISTORICAL_APPROVED_TEST_BUDGET_ONLY",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
describe("production retail release preflight", () => {
	it("compares every approved tuple with the effective build policy without exposing secrets", () => {
		const report = verifyApprovedVideoRetailPrices({
			VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			KIE_API_KEY: "secret-test-sentinel",
		});
		expect(report).toMatchObject({
			enabled: true,
			checked: 1188,
			differences: 0,
			costPolicy: { paymentFeeBps: "654", baseMarkupBps: "11000" },
		});
		expect(JSON.stringify(report)).not.toContain("secret-test-sentinel");
	});
	it("blocks a material cost change and any base-margin change before deployment", () => {
		expect(() =>
			verifyApprovedVideoRetailPrices({ ...policy, VIDEO_COST_PAYMENT_FEE_BPS: "655" }),
		).toThrow("VIDEO_RETAIL_APPROVED_PRICES_CHANGED");
		expect(() =>
			verifyApprovedVideoRetailPrices({ ...policy, VIDEO_PRICE_MARKUP_BPS: "12000" }),
		).toThrow("VIDEO_RETAIL_EXISTING_BASE_MARKUP_CHANGED");
	});
	it("requires the dedicated build approval and preserves unrelated values and entry status", () => {
		const { VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: _retail, ...prior } = policy;
		const input = {
			CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true\nUNRELATED=kept",
			VIDEO_RUNTIME_CONFIG: JSON.stringify(prior),
			VIDEO_V1_BUILD_RETAIL_PRICE_VERSION: VIDEO_RETAIL_PRICE_VERSION,
		};
		const output = parseEnv(readCloudflareBuildEnvironment(input));
		expect(output.VIDEO_V1_ENABLED).toBe("true");
		expect(output.UNRELATED).toBe("kept");
		expect(JSON.parse(output.VIDEO_RUNTIME_CONFIG!)).toEqual(policy);
		expect(withoutCloudflareBuildSecrets(input)).not.toHaveProperty(
			"VIDEO_V1_BUILD_RETAIL_PRICE_VERSION",
		);
		expect(() =>
			readCloudflareBuildEnvironment({
				...input,
				VIDEO_V1_BUILD_RETAIL_PRICE_VERSION: "future-unapproved",
			}),
		).toThrow("VIDEO_BUILD_RETAIL_POLICY_REQUIRED");
	});
	it("keeps compatibility when retail approval is absent", () => {
		expect(verifyApprovedVideoRetailPrices({})).toEqual({ enabled: false, checked: 0 });
	});
	it("applies retail approval after existing supplier/model version overlays", () => {
		const { VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: _retail, ...prior } = policy;
		const output = parseEnv(
			readCloudflareBuildEnvironment({
				CLOUDFLARE_PRODUCTION_ENV: "VIDEO_V1_ENABLED=true",
				VIDEO_RUNTIME_CONFIG: JSON.stringify({
					...prior,
					VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
					VIDEO_MODEL_CONTRACT_VERSION: "video-models-2026-10-04.2",
				}),
				VIDEO_V1_BUILD_PRICE_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
				VIDEO_V1_BUILD_PRICE_BASIS: "Approved supplier evidence",
				VIDEO_V1_BUILD_MODEL_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				VIDEO_V1_BUILD_RETAIL_PRICE_VERSION: VIDEO_RETAIL_PRICE_VERSION,
			}),
		);
		expect(verifyApprovedVideoRetailPrices(output)).toMatchObject({
			checked: 1188,
			differences: 0,
		});
	});
});
