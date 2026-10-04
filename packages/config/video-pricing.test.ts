import { describe, expect, it } from "vitest";

import { getVideoModelOptions } from "./video-models";
import {
	calculateVideoRetailPrice,
	resolveVideoModelPrice,
	videoPaidCreditFloorMicros,
	videoSupplierCostMicros,
	VIDEO_SUPPLIER_PRICE_VERSION,
	type VideoCostPolicy,
} from "./video-pricing.server";

// Deliberately hypothetical policy for mathematical tests, not production expenses.
const policy: VideoCostPolicy = {
	moderationBaseMicros: 10_000n,
	moderationPerSecondMicros: 5_000n,
	audioModerationPerSecondMicros: 2_000n,
	runtimeMicros: 5_000n,
	storageMicros: 5_000n,
	paymentFixedAllocationMicros: 2_000n,
	paymentFeeBps: 500n,
	nonBillableFailureBps: 1000n,
	markupBps: 11_000n,
};
const request = {
	productKey: "video-kling-2-6-v1",
	mode: "text-to-video" as const,
	duration: 5,
	sound: false,
	resolution: "default",
};
describe("video full variable cost pricing", () => {
	it("uses the lowest annual revenue per issued credit including bonuses", () => {
		expect(videoPaidCreditFloorMicros()).toBe(21_944n);
	});
	it("uses exact supplier tariffs including per-video steps and image surcharges", () => {
		expect(videoSupplierCostMicros(request)).toBe(275_000n);
		expect(videoSupplierCostMicros({ ...request, sound: true })).toBe(550_000n);
		expect(
			videoSupplierCostMicros({
				...request,
				productKey: "video-minimax-h3",
				resolution: "768p",
				mode: "image-to-video",
			}),
		).toBe(220_000n);
		expect(
			videoSupplierCostMicros({
				...request,
				productKey: "video-seedance-1-pro-fast",
				resolution: "720p",
				mode: "image-to-video",
				duration: 10,
			}),
		).toBe(180_000n);
		expect(
			videoSupplierCostMicros({
				...request,
				productKey: "video-gemini-omni-flash",
				resolution: "4k",
				duration: 4,
			}),
		).toBe(735_000n);
	});
	it("refuses unavailable variant prices instead of aliasing another model", () => {
		for (const productKey of [
			"video-minimax-h3-turbo",
			"video-veo-3-1",
			"video-veo-3-1-fast",
			"unknown",
		])
			expect(() => videoSupplierCostMicros({ ...request, productKey })).toThrow(
				"VIDEO_MODEL_PRICE_UNAVAILABLE",
			);
	});
	it("maintains >100% profit on complete cost after rounding and percentage payment fees", () => {
		for (const providerCostMicros of [1n, 8750n, 275_000n, 15_600_000n])
			for (const paymentFeeBps of [0n, 290n, 500n, 2000n])
				for (const nonBillableFailureBps of [1n, 500n, 2500n]) {
					const result = calculateVideoRetailPrice({
						providerCostMicros,
						duration: 5,
						sound: true,
						policy: { ...policy, paymentFeeBps, nonBillableFailureBps },
					});
					expect(result.profitMicros * 10_000n).toBeGreaterThanOrEqual(
						result.completeCostMicros * policy.markupBps,
					);
					expect(result.profitMicros).toBeGreaterThan(result.completeCostMicros);
					expect(result.credits * result.creditFloorMicros).toBe(result.minimumGrossRevenueMicros);
				}
	});
	it("prices every supported non-Veo tuple with positive auditable costs", () => {
		for (const productKey of [
			"video-minimax-h3",
			"video-kling-2-6-v1",
			"video-kling-3",
			"video-kling-3-turbo",
			"video-seedance-2-5",
			"video-seedance-2",
			"video-seedance-2-mini",
			"video-seedance-2-fast",
			"video-seedance-1-5-pro",
			"video-seedance-1-pro-fast",
			"video-gemini-omni-flash",
		])
			for (const mode of ["text-to-video", "image-to-video"] as const)
				for (const option of getVideoModelOptions(productKey, mode))
					expect(videoSupplierCostMicros({ productKey, mode, ...option })).toBeGreaterThan(0n);
	});
	it("rejects under-100% markup, impossible fee policy and invalid numbers", () => {
		for (const overrides of [
			{ markupBps: 10_000n },
			{ markupBps: 9000n },
			{ paymentFeeBps: 9000n },
			{ nonBillableFailureBps: 10_000n },
			{ storageMicros: -1n },
		])
			expect(() =>
				calculateVideoRetailPrice({
					providerCostMicros: 275_000n,
					duration: 5,
					sound: false,
					policy: { ...policy, ...overrides },
				}),
			).toThrow("VIDEO_PRICE_INVALID");
	});
	it("requires approved current price basis and every real cost setting", () => {
		expect(() => resolveVideoModelPrice(request, {})).toThrow("VIDEO_PRICE_NOT_APPROVED");
		const env = {
			VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
			VIDEO_PRICE_BASIS: "isolated fixture only",
			VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
			VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
			VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
			VIDEO_PRICE_VALID_UNTIL: new Date(Date.now() + 60000).toISOString(),
			VIDEO_COST_MODERATION_BASE_MICROS: "10000",
			VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
			VIDEO_COST_RUNTIME_MICROS: "5000",
			VIDEO_COST_STORAGE_MICROS: "5000",
			VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
			VIDEO_COST_PAYMENT_FEE_BPS: "500",
			VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
		};
		expect(resolveVideoModelPrice(request, env).paidFundingPolicy.minimumUsdMicrosPerCredit).toBe(
			21_944n,
		);
		expect(resolveVideoModelPrice(request, env).pricingDetails.visualPolicyVersion).toBe(
			env.VIDEO_COST_VISUAL_POLICY_VERSION,
		);
		expect(resolveVideoModelPrice(request, env).pricingDetails.textRuleVersion).toBe(
			env.VIDEO_COST_TEXT_RULE_VERSION,
		);
		expect(() =>
			resolveVideoModelPrice(request, { ...env, VIDEO_COST_TEXT_RULE_VERSION: undefined }),
		).toThrow("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
		for (const drift of [undefined, "video-policy-2026-10-04.1", "unknown-policy"])
			expect(() =>
				resolveVideoModelPrice(request, { ...env, VIDEO_COST_VISUAL_POLICY_VERSION: drift }),
			).toThrow("VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED");
		const withSound = resolveVideoModelPrice({ ...request, sound: true }, env);
		expect(withSound.pricingDetails.audioSafetyPolicy).toEqual({
			schemaVersion: 1,
			mode: "not_requested",
		});
		expect(withSound.pricingDetails.costPolicy.audioModerationPerSecondMicros).toBe("0");
		expect(withSound.providerCostMicros).toBe(550_000n);
		expect(() =>
			resolveVideoModelPrice(request, { ...env, VIDEO_COST_MODERATION_BASE_MICROS: "" }),
		).toThrow("VIDEO_COST_POLICY_NOT_CONFIGURED");
		expect(() =>
			resolveVideoModelPrice(request, { ...env, VIDEO_PRICE_VALID_UNTIL: "2000-01-01" }),
		).toThrow("VIDEO_PRICE_EXPIRED");
	});
});
