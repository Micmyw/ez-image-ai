import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VideoEffectRequest } from "./video-effects";
import {
	createVideoEffectTemplateSnapshot,
	HOTEL_LOBBY_PRICE_VERSION,
	HOTEL_LOBBY_SAFETY_POLICY_VERSION,
	HOTEL_LOBBY_TEMPLATE_VERSION,
	parseVideoEffectTemplateSnapshot,
	resolveVideoEffectPrice,
	resolveVideoEffectTemplate,
} from "./video-effects.server";
import {
	calculateVideoRetailPrice,
	resolveVideoModelPrice,
	VIDEO_SUPPLIER_PRICE_VERSION,
	type VideoCostPolicy,
} from "./video-pricing.server";

const request: VideoEffectRequest = {
	effectId: "hotel-lobby-duo",
	presetKey: "standard",
	inputs: { leftAssetId: "left", rightAssetId: "right" },
};
/** Hypothetical isolated cost fixture; never a production price or real account approval. */
function fixtureEnvironment(): Record<string, string | undefined> {
	return {
		HOTEL_LOBBY_DUO_ENABLED: "true",
		HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
		HOTEL_LOBBY_DUO_PRICE_VERSION: HOTEL_LOBBY_PRICE_VERSION,
		HOTEL_LOBBY_DUO_PRICE_BASIS: "fictional local cost fixture",
		HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2026-11-01T00:00:00Z",
		HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: "fictional local approved payment budget",
		HOTEL_LOBBY_DUO_COST_POLICY_VERSION: HOTEL_LOBBY_SAFETY_POLICY_VERSION,
		HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
		HOTEL_LOBBY_DUO_TEXT_COST_BASIS: "fictional local zero-cost fixture only",
		HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "0",
		HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS: "20000",
		HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "1000",
		HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "1000",
		HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "2000",
		HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "3000",
		VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify([
			{
				productKey: "video-seedance-1-5-pro",
				modes: ["image-to-video"],
				durations: [5],
				resolutions: ["720p"],
				sounds: [false],
			},
		]),
		VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
		VIDEO_PRICE_BASIS: "fictional local video cost fixture",
		VIDEO_PRICE_VALID_UNTIL: "2026-10-20T00:00:00Z",
		VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
		VIDEO_COST_VISUAL_POLICY_VERSION: "seeapi-video-policy-2026-10-04.1",
		VIDEO_COST_TEXT_RULE_VERSION: "waffo-prompt-safety-2026-10-04.1",
		VIDEO_COST_MODERATION_BASE_MICROS: "10000",
		VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
		VIDEO_COST_RUNTIME_MICROS: "5000",
		VIDEO_COST_STORAGE_MICROS: "5000",
		VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
		VIDEO_COST_PAYMENT_FEE_BPS: "500",
		VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("frozen Hotel Lobby template", () => {
	it("maps two roles to a scene before fixed single-image video; recovery does not use mutable flags", () => {
		const stored = createVideoEffectTemplateSnapshot(request);
		expect(stored.storage).toEqual({
			sceneMaximumBytes: 20000000,
			sceneRetentionSeconds: 2592000,
			videoMaximumBytes: 104857600,
		});
		expect(stored.scene).toMatchObject({
			productKey: "nano-banana-2-lite-1k",
			outputCount: 1,
			aspectRatio: "9:16",
		});
		expect(stored.scene.prompt).toContain("image 1 defines the LEFT");
		expect(stored.scene.prompt).toContain("image 2 defines the RIGHT");
		expect(stored.video).toMatchObject({
			productKey: "video-seedance-1-5-pro",
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			fixedLens: true,
		});
		expect(parseVideoEffectTemplateSnapshot(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
		expect(() => resolveVideoEffectTemplate(request, {})).toThrow("VIDEO_EFFECT_DISABLED");
		expect(parseVideoEffectTemplateSnapshot(stored)).toEqual(stored);
	});
	it("rejects altered execution and unknown snapshots without silently substituting new defaults", () => {
		const stored = createVideoEffectTemplateSnapshot(request);
		for (const value of [
			null,
			{ ...stored, templateVersion: "new-default" },
			{ ...stored, video: { ...stored.video, sound: true } },
			{ ...stored, scene: { ...stored.scene, productKey: "expensive-fallback" } },
			{ ...stored, output: { ...stored.output, width: 360 } },
			{ ...stored, provider: "unexpected" },
		])
			expect(() => parseVideoEffectTemplateSnapshot(value)).toThrow(
				"VIDEO_EFFECT_TEMPLATE_SNAPSHOT_INVALID",
			);
	});
	it("requires template approval and the existing video model option allowlist", () => {
		const env = fixtureEnvironment();
		expect(resolveVideoEffectTemplate(request, env).templateVersion).toBe(
			HOTEL_LOBBY_TEMPLATE_VERSION,
		);
		expect(() =>
			resolveVideoEffectTemplate(request, {
				...env,
				HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: undefined,
			}),
		).toThrow("VIDEO_EFFECT_TEMPLATE_NOT_CONFIRMED");
		expect(() =>
			resolveVideoEffectTemplate(request, { ...env, VIDEO_MODEL_ALLOWED_OPTIONS: undefined }),
		).toThrow("VIDEO_MODEL_OPTIONS_NOT_CONFIGURED");
		expect(() =>
			resolveVideoEffectTemplate(request, {
				...env,
				VIDEO_MODEL_ALLOWED_OPTIONS: env.VIDEO_MODEL_ALLOWED_OPTIONS!.replace(
					'"image-to-video"',
					'"text-to-video"',
				),
			}),
		).toThrow("VIDEO_MODEL_OPTION_NOT_ENABLED");
	});
});

describe("one complete duo quote", () => {
	it("requires revenue at least three times complete cost without changing ordinary video pricing", () => {
		const env = fixtureEnvironment();
		const ordinary = resolveVideoModelPrice(createVideoEffectTemplateSnapshot(request).video, env);
		const price = resolveVideoEffectPrice(request, env);
		expect(BigInt(price.pricingDetails.minimumGrossRevenueMicros)).toBeGreaterThanOrEqual(
			3n * BigInt(price.pricingDetails.completeCostMicros),
		);
		expect(price.pricingDetails.costPolicy.markupBps).toBe("20000");
		expect(price.pricingDetails.costPolicy.paymentFeeBps).toBe("750");
		expect(ordinary.pricingDetails.costPolicy.markupBps).toBe("11000");
		expect(ordinary.pricingDetails.costPolicy.paymentFeeBps).toBe("500");
		expect(
			resolveVideoModelPrice(createVideoEffectTemplateSnapshot(request).video, {
				...env,
				HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "25000",
				HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: "1000",
			}),
		).toEqual(ordinary);
	});
	it("retains higher inherited payment budgets and accepts a stricter template revenue target", () => {
		const price = resolveVideoEffectPrice(request, {
			...fixtureEnvironment(),
			VIDEO_COST_PAYMENT_FEE_BPS: "1400",
			HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: "25000",
			HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: "750",
		});
		expect(price.pricingDetails.costPolicy.paymentFeeBps).toBe("1400");
		expect(price.pricingDetails.costPolicy.markupBps).toBe("25000");
		expect(BigInt(price.pricingDetails.minimumGrossRevenueMicros) * 2n).toBeGreaterThanOrEqual(
			7n * BigInt(price.pricingDetails.completeCostMicros),
		);
	});
	it("does not approve an old price version, a smaller target or an unconfirmed payment budget", () => {
		const env = fixtureEnvironment();
		expect(() =>
			resolveVideoEffectPrice(request, {
				...env,
				HOTEL_LOBBY_DUO_PRICE_VERSION: "hotel-lobby-duo-cost-2026-10-05.1",
			}),
		).toThrow("VIDEO_EFFECT_PRICE_NOT_APPROVED");
		for (const value of ["11000", "19999", "0", "", "100001"])
			expect(() =>
				resolveVideoEffectPrice(request, { ...env, HOTEL_LOBBY_DUO_PRICE_MARKUP_BPS: value }),
			).toThrow();
		for (const value of ["0", "654", "749", "10000", ""])
			expect(() =>
				resolveVideoEffectPrice(request, { ...env, HOTEL_LOBBY_DUO_PAYMENT_FEE_BPS: value }),
			).toThrow();
		for (const value of [undefined, "", "   "])
			expect(() =>
				resolveVideoEffectPrice(request, { ...env, HOTEL_LOBBY_DUO_PAYMENT_COST_BASIS: value }),
			).toThrow("VIDEO_EFFECT_PAYMENT_COST_NOT_CONFIRMED");
	});
	it("quotes 69 credits for the explicit conservative budget and rejects the economics of 68", () => {
		const price = resolveVideoEffectPrice(request, {
			...fixtureEnvironment(),
			VIDEO_COST_MODERATION_BASE_MICROS: "5100",
			VIDEO_COST_MODERATION_PER_SECOND_MICROS: "200",
			VIDEO_COST_RUNTIME_MICROS: "100000",
			VIDEO_COST_STORAGE_MICROS: "10000",
			VIDEO_COST_PAYMENT_FIXED_MICROS: "0",
			VIDEO_COST_PAYMENT_FEE_BPS: "654",
			HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS: "5100",
			HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS: "5100",
			HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS: "100000",
			HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS: "10000",
		});
		expect(price.credits).toBe(69n);
		expect(price.pricingDetails.minimumGrossRevenueMicros).toBe("1514136");
		expect(price.pricingDetails.completeCostMicros).toBe("501228");
		const previousRevenue =
			(price.credits - 1n) * price.paidFundingPolicy.minimumUsdMicrosPerCredit;
		const previousPaymentFee = (previousRevenue * 750n + 9999n) / 10000n;
		expect(previousRevenue).toBeLessThan(
			3n * (BigInt(price.pricingDetails.riskAdjustedCostMicros) + previousPaymentFee),
		);
	});
	it("adds direct scene costs and all three image reviews before one risk/fee/retail calculation", () => {
		const price = resolveVideoEffectPrice(request, fixtureEnvironment());
		const policy: VideoCostPolicy = {
			moderationBaseMicros: 13000n,
			moderationPerSecondMicros: 5000n,
			audioModerationPerSecondMicros: 0n,
			runtimeMicros: 7000n,
			storageMicros: 8000n,
			paymentFixedAllocationMicros: 2000n,
			paymentFeeBps: 750n,
			nonBillableFailureBps: 1000n,
			markupBps: 20000n,
		};
		const expected = calculateVideoRetailPrice({
			providerCostMicros: 107500n,
			duration: 5,
			sound: false,
			policy,
		});
		expect(price.providerCostMicros).toBe(107500n);
		expect(price.moderationCostMicros).toBe(38000n);
		expect(price.credits).toBe(expected.credits);
		expect(price.pricingDetails.directCostMicros).toBe("160500");
		expect(price.pricingDetails.costPolicy.paymentFixedAllocationMicros).toBe("2000");
		expect(price.pricingDetails.costComponents).toMatchObject({
			sceneProviderCostMicros: "20000",
			videoProviderCostMicros: "87500",
			inputReviewCostMicros: "2000",
			sceneReviewCostMicros: "1000",
		});
		expect(price.paidFundingPolicy.minimumUsdMicrosPerCredit).toBe(21944n);
		expect(price.pricingDetails.completeCostMicros).toBe(expected.completeCostMicros.toString());
	});
	it("charges both explicit text review budgets and never assumes a free tariff", () => {
		const env = fixtureEnvironment();
		const price = resolveVideoEffectPrice(request, {
			...env,
			HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: "1500",
		});
		expect(price.moderationCostMicros).toBe(41000n);
		expect(price.pricingDetails.costComponents.textReviewCostMicros).toBe("3000");
		expect(price.pricingDetails.textReviewCount).toBe(2);
		for (const key of ["HOTEL_LOBBY_DUO_TEXT_COST_RULE_VERSION", "HOTEL_LOBBY_DUO_TEXT_COST_BASIS"])
			expect(() => resolveVideoEffectPrice(request, { ...env, [key]: undefined })).toThrow(
				"VIDEO_EFFECT_TEXT_COST_NOT_CONFIRMED",
			);
		expect(() =>
			resolveVideoEffectPrice(request, {
				...env,
				HOTEL_LOBBY_DUO_TEXT_REVIEW_COST_MICROS: undefined,
			}),
		).toThrow("VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED");
	});
	it("expires at the earlier scene or video cost deadline", () => {
		const env = fixtureEnvironment();
		expect(resolveVideoEffectPrice(request, env).pricingDetails.validUntil).toBe(
			"2026-10-20T00:00:00.000Z",
		);
		expect(
			resolveVideoEffectPrice(request, {
				...env,
				HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2026-10-10T00:00:00Z",
			}).pricingDetails.validUntil,
		).toBe("2026-10-10T00:00:00.000Z");
		expect(() =>
			resolveVideoEffectPrice(request, {
				...env,
				HOTEL_LOBBY_DUO_PRICE_VALID_UNTIL: "2026-10-05T00:00:00Z",
			}),
		).toThrow("VIDEO_EFFECT_PRICE_EXPIRED");
		expect(() =>
			resolveVideoEffectPrice(request, { ...env, VIDEO_PRICE_VALID_UNTIL: "2026-10-05T00:00:00Z" }),
		).toThrow("VIDEO_PRICE_EXPIRED");
	});
	it("never invents approval, provider cost, moderation, transfer or storage budget", () => {
		const env = fixtureEnvironment();
		for (const key of [
			"HOTEL_LOBBY_DUO_SCENE_PROVIDER_COST_MICROS",
			"HOTEL_LOBBY_DUO_INPUT_REVIEW_COST_MICROS",
			"HOTEL_LOBBY_DUO_SCENE_REVIEW_COST_MICROS",
			"HOTEL_LOBBY_DUO_ADDITIONAL_RUNTIME_COST_MICROS",
			"HOTEL_LOBBY_DUO_ADDITIONAL_STORAGE_COST_MICROS",
		])
			for (const value of [undefined, "0", "-1", "NaN"])
				expect(() => resolveVideoEffectPrice(request, { ...env, [key]: value })).toThrow(
					"VIDEO_EFFECT_COST_POLICY_NOT_CONFIGURED",
				);
		expect(() =>
			resolveVideoEffectPrice(request, { ...env, HOTEL_LOBBY_DUO_PRICE_VERSION: undefined }),
		).toThrow("VIDEO_EFFECT_PRICE_NOT_APPROVED");
		expect(() =>
			resolveVideoEffectPrice(request, { ...env, HOTEL_LOBBY_DUO_COST_POLICY_VERSION: undefined }),
		).toThrow("VIDEO_EFFECT_COST_POLICY_NOT_CONFIRMED");
		expect(() =>
			resolveVideoEffectPrice(request, { ...env, VIDEO_COST_TEXT_RULE_VERSION: undefined }),
		).toThrow("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
	});
});
