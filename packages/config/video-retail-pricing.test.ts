import { describe, expect, it } from "vitest";

import approved from "./fixtures/video-retail-approved-2026-10-08.json";
import { getVideoModelOptions, VIDEO_MODEL_CATALOG } from "./video-models";
import {
	calculateVideoRetailPrice,
	resolveVideoModelPrice,
	resolveVideoRetailTarget,
	VIDEO_RETAIL_PRICE_VERSION,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "./video-pricing.server";
import { createVideoVisualSafetyProfile } from "./video-safety";
import { createVideoTextSafetyProfile } from "./video-text-safety";

const environment = {
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: "video-retail-2026-10-08.1",
	VIDEO_PRICE_BASIS: "APPROVED_RETAIL_MATRIX_HISTORICAL_COST_FIXTURE",
	VIDEO_PRICE_VALID_UNTIL: "none",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_MODERATION_BASE_MICROS: "5100",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
	VIDEO_COST_RUNTIME_MICROS: "100000",
	VIDEO_COST_STORAGE_MICROS: "10000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
	VIDEO_COST_PAYMENT_FEE_BPS: "654",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};

describe("approved family video retail and annual upgrade prices", () => {
	it("reproduces every approved price from actual supplier units and complete costs", () => {
		expect(approved.rows).toHaveLength(1188);
		expect(VIDEO_RETAIL_PRICE_VERSION).toBe(environment.VIDEO_RETAIL_PRICE_ACCEPTED_VERSION);
		for (const { selection, standardCredits, annualCredits } of approved.rows) {
			const request = selection as Parameters<typeof resolveVideoModelPrice>[0];
			const standard = resolveVideoModelPrice(request, environment);
			const annual = resolveVideoModelPrice(request, environment, { audience: "annual" });
			expect(standard.credits.toString(), JSON.stringify(request)).toBe(standardCredits);
			expect(annual.credits.toString(), JSON.stringify(request)).toBe(annualCredits);
			expect(annual.credits).toBeLessThanOrEqual(standard.credits);
			expect(annual.pricingVersion).not.toBe(standard.pricingVersion);
			expect(annual.pricingDetails.retail?.display).toMatchObject({
				standardCredits,
				annualCredits,
				credits: annualCredits,
				audience: "annual",
				savedCredits: (BigInt(standardCredits) - BigInt(annualCredits)).toString(),
			});
		}
	});
	it("covers the complete current legal price catalogue without aspect-ratio duplicates", () => {
		const actual = new Set(
			VIDEO_MODEL_CATALOG.flatMap((model) =>
				model.modes.flatMap((mode) =>
					getVideoModelOptions(model.productKey, mode).map((option) =>
						JSON.stringify([
							model.productKey,
							mode,
							option.duration,
							option.resolution,
							option.sound,
							option.veoTier ?? "",
						]),
					),
				),
			),
		);
		const expected = new Set(
			approved.rows.map(({ selection: s }) =>
				JSON.stringify([
					s.productKey,
					s.mode,
					s.duration,
					s.resolution,
					s.sound,
					"veoTier" in s ? s.veoTier : "",
				]),
			),
		);
		expect(actual).toEqual(expected);
	});
	it("uses fixed family anchors, actual seconds, one mode upgrade, then cap-before-half", () => {
		const base = {
			productKey: "video-seedance-2",
			mode: "text-to-video" as const,
			duration: 15,
			resolution: "4k",
			sound: false,
		};
		expect(resolveVideoRetailTarget(base)).toMatchObject({
			baselineProductKey: "video-seedance-2-mini",
			extraSeconds: 11,
			resolutionSteps: 3,
			nonBaseMode: true,
			rawMarkupBps: 117500n,
			standardMarkupBps: 100000n,
			annualMarkupBps: 55500n,
		});
		for (const veoTier of ["fast", "quality"] as const)
			expect(
				resolveVideoRetailTarget({
					...base,
					productKey: "video-veo-3-1",
					duration: 8,
					resolution: "720p",
					sound: true,
					veoTier,
				}),
			).toMatchObject({
				extraSeconds: 4,
				nonBaseMode: true,
				standardMarkupBps: 47000n,
				annualMarkupBps: 29000n,
			});
		expect(
			resolveVideoRetailTarget({
				...base,
				productKey: "video-kling-3",
				duration: 5,
				resolution: "1080p",
			}),
		).toMatchObject({
			extraSeconds: 2,
			resolutionSteps: 1,
			nonBaseMode: false,
			standardMarkupBps: 34000n,
		});
	});
	it("keeps legacy approvals available and rejects unknown new approval versions", () => {
		const request = {
			productKey: "video-seedance-2-mini",
			mode: "text-to-video" as const,
			duration: 5,
			resolution: "720p",
			sound: false,
		};
		const old = resolveVideoModelPrice(request, {
			...environment,
			VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: undefined,
		});
		expect(old.credits).toBe(40n);
		expect(old.pricingVersion).toBe(VIDEO_SUPPLIER_PRICE_VERSION);
		expect(old.pricingDetails.retail).toBeUndefined();
		expect(() =>
			resolveVideoModelPrice(request, {
				...environment,
				VIDEO_RETAIL_PRICE_ACCEPTED_VERSION: "unknown",
			}),
		).toThrow("VIDEO_RETAIL_PRICE_NOT_APPROVED");
	});
	it("retains the payment-dependent finite-solution guard at the ordinary cap", () => {
		const policy = {
			moderationBaseMicros: 5100n,
			moderationPerSecondMicros: 200n,
			audioModerationPerSecondMicros: 0n,
			runtimeMicros: 100000n,
			storageMicros: 10000n,
			paymentFixedAllocationMicros: 0n,
			paymentFeeBps: 910n,
			nonBillableFailureBps: 1000n,
			markupBps: 100000n,
		};
		expect(() =>
			calculateVideoRetailPrice({ providerCostMicros: 75000n, duration: 4, sound: true, policy }),
		).toThrow("VIDEO_PRICE_INVALID");
	});
});
