import { describe, expect, it } from "vitest";

import {
	getVideoModel,
	getVideoModelOptions,
	videoModelInputSchema,
	videoModelReceiptInputSchema,
} from "./video-models";
import {
	resolveVideoModelPrice,
	videoSupplierCostMicros,
	VIDEO_SUPPLIER_PRICE_VERSION,
} from "./video-pricing.server";

// Independent transcription of the 2026-10-08 official regional per-video matrix.
// Budget values are the recorded application policy, not a live billing assertion.
const tariffs = [
	["lite", "720p", 75_000n, [24n, 24n, 24n]],
	["lite", "1080p", 112_500n, [29n, 29n, 29n]],
	["lite", "4k", 375_000n, [61n, 61n, 61n]],
	["fast", "720p", 150_000n, [33n, 33n, 33n]],
	["fast", "1080p", 187_500n, [38n, 38n, 38n]],
	["fast", "4k", 450_000n, [70n, 70n, 70n]],
	["quality", "720p", 1_125_000n, [153n, 154n, 154n]],
	["quality", "1080p", 1_162_500n, [158n, 158n, 158n]],
	["quality", "4k", 1_425_000n, [190n, 190n, 191n]],
] as const;
const environment = {
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "RECORDED_BUDGET_TEST_ONLY_2026_10_08",
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
const base = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat on a quiet blue lake",
	duration: 8,
	resolution: "720p",
	aspectRatio: "16:9",
	sound: true,
};

describe("explicit Veo tiers and complete-cost pricing", () => {
	const cases = tariffs.flatMap(([veoTier, resolution, cost, credits]) =>
		([4, 6, 8] as const).flatMap((duration, index) =>
			(["text-to-video", "image-to-video"] as const).map((mode) => ({
				veoTier,
				resolution,
				duration,
				mode,
				cost,
				credits: credits[index]!,
			})),
		),
	);
	it.each(cases)(
		"binds $veoTier $resolution $duration s $mode to its own cost and quote",
		(test) => {
			const request = {
				...base,
				...test,
				...(test.mode === "image-to-video" ? { inputAssetId: "sealed-first-frame" } : {}),
			};
			const { cost, credits, ...input } = request;
			expect(videoModelInputSchema.parse(input)).toEqual(input);
			expect(videoSupplierCostMicros(input)).toBe(cost);
			const price = resolveVideoModelPrice(input, environment);
			expect(price.credits).toBe(credits);
			expect(price.providerCostMicros).toBe(cost);
			expect(price.moderationCostMicros).toBe(5100n + BigInt(input.duration) * 200n);
			const details = price.pricingDetails as Record<string, unknown>;
			expect(BigInt(String(details.profitMicros)) * 10_000n).toBeGreaterThanOrEqual(
				BigInt(String(details.completeCostMicros)) * 11_000n,
			);
		},
	);
	it("requires a new explicit tier while retaining an absent tier in historical receipts byte-for-byte", () => {
		expect(videoModelInputSchema.safeParse(base).success).toBe(false);
		expect(videoModelReceiptInputSchema.parse(base)).toEqual(base);
		expect(videoModelReceiptInputSchema.parse(base)).not.toHaveProperty("veoTier");
		expect(getVideoModel("video-veo-3-1")!.defaults["text-to-video"]).toMatchObject({
			duration: 8,
			veoTier: "lite",
		});
		expect(
			new Set(
				getVideoModelOptions("video-veo-3-1", "text-to-video").map((option) => option.veoTier),
			),
		).toEqual(new Set(["lite", "fast", "quality"]));
	});
	it.each([
		{ veoTier: "turbo" },
		{ veoTier: "pro" },
		{ veoTier: "veo3_lite" },
		{ veoTier: "lite", productKey: "video-veo-3-1-fast" },
		{ veoTier: "quality", productKey: "video-kling-3", duration: 5, sound: false },
		{ veoTier: "lite", duration: 5 },
		{ veoTier: "lite", resolution: "480p" },
		{ veoTier: "lite", sound: false },
	])("rejects unsupported or foreign tier combinations %j", (patch) => {
		const input = { ...base, ...patch };
		expect(videoModelInputSchema.safeParse(input).success).toBe(false);
		expect(() => videoSupplierCostMicros(input as never)).toThrow("VIDEO_MODEL_PRICE_UNAVAILABLE");
	});
});
