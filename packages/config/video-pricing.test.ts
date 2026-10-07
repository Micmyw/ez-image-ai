import { afterEach, describe, expect, it, vi } from "vitest";

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
function approvedPriceEnvironment() {
	return {
		VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
		VIDEO_PRICE_BASIS: "isolated fixture only",
		VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
		VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
		VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
		VIDEO_PRICE_VALID_UNTIL: "2026-11-01T00:00:00.000Z",
		VIDEO_COST_MODERATION_BASE_MICROS: "10000",
		VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
		VIDEO_COST_RUNTIME_MICROS: "5000",
		VIDEO_COST_STORAGE_MICROS: "5000",
		VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
		VIDEO_COST_PAYMENT_FEE_BPS: "500",
		VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
	};
}
afterEach(() => vi.useRealTimers());
describe("video full variable cost pricing", () => {
	it("uses the lowest annual revenue per issued credit including bonuses", () => {
		expect(videoPaidCreditFloorMicros()).toBe(21_944n);
	});
	it("uses exact supplier tariffs including per-video steps and free single-image input", () => {
		expect(videoSupplierCostMicros(request)).toBe(275_000n);
		expect(videoSupplierCostMicros({ ...request, sound: true })).toBe(550_000n);
		expect(
			videoSupplierCostMicros({
				...request,
				productKey: "video-minimax-h3",
				resolution: "768p",
				mode: "image-to-video",
			}),
		).toBe(200_000n);
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
	it.each([
		["768p", 5, 200_000n],
		["2k", 15, 975_000n],
	] as const)(
		"does not surcharge H3 single-image input at %s for %s seconds",
		(resolution, duration, expected) => {
			for (const mode of ["text-to-video", "image-to-video"] as const)
				expect(
					videoSupplierCostMicros({
						...request,
						productKey: "video-minimax-h3",
						mode,
						resolution,
						duration,
						sound: true,
					}),
				).toBe(expected);
		},
	);
	it("refuses unavailable variant prices instead of aliasing another model", () => {
		for (const productKey of [
			"video-minimax-h3-turbo",
			"video-veo-3-1",
			"video-veo-3-1-pro",
			"unknown",
		])
			expect(() => videoSupplierCostMicros({ ...request, productKey })).toThrow(
				"VIDEO_MODEL_PRICE_UNAVAILABLE",
			);
	});
	it("prices explicit old-route Veo Fast per video across supported durations", () => {
		for (const mode of ["text-to-video", "image-to-video"] as const)
			for (const duration of [4, 6, 8])
				for (const [resolution, expected] of [
					["720p", 300_000n],
					["1080p", 325_000n],
					["4k", 900_000n],
				] as const)
					expect(
						videoSupplierCostMicros({
							productKey: "video-veo-3-1-fast",
							mode,
							duration,
							resolution,
							sound: true,
						}),
					).toBe(expected);
	});
	it.each([{ duration: 5 }, { resolution: "480p" }, { sound: false }])(
		"does not price unsupported Veo Fast parameters %j",
		(patch) => {
			expect(() =>
				videoSupplierCostMicros({
					...request,
					productKey: "video-veo-3-1-fast",
					duration: 4,
					resolution: "720p",
					sound: true,
					...patch,
				}),
			).toThrow("VIDEO_MODEL_PRICE_UNAVAILABLE");
		},
	);
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
	it("prices every supported mapped tuple with positive auditable costs", () => {
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
			"video-veo-3-1-fast",
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

describe("October 7 supplier price refresh and finite operator approval", () => {
	it.each(["video-seedance-2-mini", "video-seedance-2-fast"])(
		"quotes %s after the superseded cutoff and freezes the operator deadline",
		(productKey) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-07T13:50:00.000Z"));
			const env = {
				...approvedPriceEnvironment(),
				VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-07.1",
			};
			const price = resolveVideoModelPrice({ ...request, productKey, resolution: "720p" }, env);
			expect(price.pricingVersion).toBe("kie-public-2026-10-07.1");
			expect(price.pricingDetails.validUntil).toBe(env.VIDEO_PRICE_VALID_UNTIL);
		},
	);
	it.each([
		["video-seedance-2-mini", "2026-10-07T06:00:00.000Z"],
		["video-seedance-2-mini", "2026-10-07T06:00:00.001Z"],
		["video-seedance-2-fast", "2026-10-07T06:00:00.000Z"],
		["video-seedance-2-fast", "2026-10-08T00:00:00.000Z"],
	])("keeps %s quotable at %s under the renewed approved basis", (productKey, now) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(now));
		expect(
			resolveVideoModelPrice(
				{ ...request, productKey, resolution: "720p" },
				approvedPriceEnvironment(),
			).pricingVersion,
		).toBe("kie-public-2026-10-07.1");
	});
	it.each(["video-seedance-2-mini", "video-seedance-2-fast"])(
		"refuses %s exactly at the finite operator approval deadline",
		(productKey) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
			const env = {
				...approvedPriceEnvironment(),
				VIDEO_PRICE_VALID_UNTIL: "2026-10-12T00:00:00.000Z",
			};
			const selection = { ...request, productKey, resolution: "720p" };
			expect(resolveVideoModelPrice(selection, env).pricingDetails.validUntil).toBe(
				env.VIDEO_PRICE_VALID_UNTIL,
			);
			vi.setSystemTime(new Date(env.VIDEO_PRICE_VALID_UNTIL));
			expect(() => resolveVideoModelPrice(selection, env)).toThrow("VIDEO_PRICE_EXPIRED");
		},
	);
	it.each([
		["video-kling-2-6-v1", "default"],
		["video-minimax-h3", "768p"],
		["video-seedance-2", "720p"],
		["video-seedance-2-5", "720p"],
	])(
		"preserves %s pricing under its own approval after the basis refresh",
		(productKey, resolution) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
			const env = approvedPriceEnvironment();
			expect(
				resolveVideoModelPrice({ ...request, productKey, resolution }, env).pricingDetails
					.validUntil,
			).toBe(env.VIDEO_PRICE_VALID_UNTIL);
		},
	);
	it("requires explicit approval of the revised tariff version", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
		expect(() =>
			resolveVideoModelPrice(request, {
				...approvedPriceEnvironment(),
				VIDEO_PRICE_ACCEPTED_VERSION: "kie-public-2026-10-04.3",
			}),
		).toThrow("VIDEO_PRICE_NOT_APPROVED");
	});
	it.each([
		["video-seedance-2-mini", "480p", 19_000n],
		["video-seedance-2-mini", "720p", 41_000n],
		["video-seedance-2-fast", "480p", 59_000n],
		["video-seedance-2-fast", "720p", 124_000n],
	] as const)(
		"preserves %s %s budget for all modes, durations and sound options",
		(productKey, resolution, rate) => {
			for (const mode of ["text-to-video", "image-to-video"] as const)
				for (let duration = 4; duration <= 15; duration++)
					for (const sound of [false, true])
						expect(videoSupplierCostMicros({ productKey, resolution, mode, duration, sound })).toBe(
							rate * BigInt(duration),
						);
		},
	);
	it.each([undefined, "", "invalid-date"])(
		"rejects absent or invalid finite approval %s",
		(validUntil) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
			expect(() =>
				resolveVideoModelPrice(request, {
					...approvedPriceEnvironment(),
					VIDEO_PRICE_VALID_UNTIL: validUntil,
				}),
			).toThrow("VIDEO_PRICE_EXPIRED");
		},
	);
});

describe("explicit ordinary video approval without a deadline", () => {
	it("keeps the approved basis quotable after October 12 without inventing a date", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
		const finite = resolveVideoModelPrice(request, approvedPriceEnvironment());
		const env = { ...approvedPriceEnvironment(), VIDEO_PRICE_VALID_UNTIL: "none" };
		for (const now of ["2026-10-12T00:00:00.000Z", "2030-01-01T00:00:00.000Z"]) {
			vi.setSystemTime(new Date(now));
			const price = resolveVideoModelPrice(request, env);
			expect(price.pricingDetails).toMatchObject({
				...finite.pricingDetails,
				priceApprovalExpiryMode: "none",
				validUntil: null,
			});
			expect(price.pricingVersion).toBe(finite.pricingVersion);
			expect(price.pricingBasis).toBe(finite.pricingBasis);
			expect(price.credits).toBe(finite.credits);
			expect(price.paidFundingPolicy).toEqual(finite.paidFundingPolicy);
		}
	});
	it("marks newly approved finite snapshots explicitly", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
		expect(
			resolveVideoModelPrice(request, approvedPriceEnvironment()).pricingDetails,
		).toMatchObject({
			priceApprovalExpiryMode: "until",
			validUntil: approvedPriceEnvironment().VIDEO_PRICE_VALID_UNTIL,
		});
	});
	it.each([undefined, "", " ", "NONE", " none", "none ", "invalid-date"])(
		"does not treat an absent or malformed deadline %s as no expiry",
		(validUntil) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
			expect(() =>
				resolveVideoModelPrice(request, {
					...approvedPriceEnvironment(),
					VIDEO_PRICE_VALID_UNTIL: validUntil,
				}),
			).toThrow("VIDEO_PRICE_EXPIRED");
		},
	);
	it("still requires the accepted version, basis and complete cost policy", () => {
		const env = { ...approvedPriceEnvironment(), VIDEO_PRICE_VALID_UNTIL: "none" };
		for (const patch of [
			{ VIDEO_PRICE_ACCEPTED_VERSION: "old-version" },
			{ VIDEO_PRICE_BASIS: " " },
		])
			expect(() => resolveVideoModelPrice(request, { ...env, ...patch })).toThrow(
				"VIDEO_PRICE_NOT_APPROVED",
			);
		expect(() =>
			resolveVideoModelPrice(request, { ...env, VIDEO_COST_RUNTIME_MICROS: undefined }),
		).toThrow("VIDEO_COST_POLICY_NOT_CONFIGURED");
	});
});
