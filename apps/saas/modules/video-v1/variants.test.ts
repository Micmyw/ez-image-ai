import { describe, expect, it } from "vitest";

import { parseVideoDraft, serializeVideoDraft } from "./draft-storage";
import {
	changeVideoDraft,
	createVideoConfirmation,
	getVideoFailureRecovery,
	initialVideoDraft,
	parseVideoConfirmation,
	videoRequestFor,
	videoSelectionCredits,
	videoVariantControls,
} from "./model";

// Independent synthetic retail tuples exercise selection, never compute prices in the browser.
const catalog = {
	accessAllowed: true,
	models: [
		...(
			[
				["video-seedance-2-mini", ["720p", "480p"], 60],
				["video-seedance-2-fast", ["720p", "480p"], 80],
				["video-seedance-2", ["720p", "480p", "1080p", "4k"], 120],
				["video-kling-3", ["720p", "1080p", "4k"], 100],
				["video-kling-3-turbo", ["720p", "1080p"], 90],
			] as const
		).map(([productKey, resolutions, price]) => ({
			productKey,
			available: true,
			options: resolutions.flatMap((resolution) =>
				[5, 8].flatMap((duration) =>
					[false, true]
						.filter((sound) => productKey !== "video-kling-3-turbo" || sound)
						.map((sound) => ({
							mode: "text-to-video" as const,
							duration,
							resolution,
							sound,
							available: true,
							credits: String(price + (sound ? 0 : -40)),
						})),
				),
			),
		})),
		{
			productKey: "video-veo-3-1",
			available: true,
			options: (["lite", "fast", "quality"] as const).flatMap((veoTier, index) =>
				["720p", "1080p", "4k"].map((resolution) => ({
					mode: "text-to-video" as const,
					duration: 8,
					resolution,
					sound: true,
					veoTier,
					available: true,
					credits: String(24 + index * 50),
				})),
			),
		},
	],
};
describe("real model variants and editable draft memory", () => {
	it("defaults a new Veo selection to explicit Lite / 8 seconds and reads its exact catalog price before a prompt", () => {
		const draft = changeVideoDraft(initialVideoDraft, { productKey: "video-veo-3-1" }, catalog);
		expect(draft).toMatchObject({ duration: 8, resolution: "720p", veoTier: "lite", prompt: "" });
		expect(videoSelectionCredits(draft, catalog)).toBe("24");
		expect(videoRequestFor(draft)).toHaveProperty("veoTier", "lite");
		const quality = changeVideoDraft(draft, { veoTier: "quality" }, catalog);
		expect(videoSelectionCredits(quality, catalog)).toBe("124");
	});
	it("chooses Mini for first Seedance 2 selection at unchanged 720p / 8 seconds", () => {
		const draft = changeVideoDraft(
			{ ...initialVideoDraft, resolution: "720p", duration: 8 },
			{ productKey: "video-seedance-2" },
			catalog,
		);
		expect(draft).toMatchObject({
			productKey: "video-seedance-2-mini",
			resolution: "720p",
			duration: 8,
			sound: false,
		});
	});
	it.each(["1080p", "4k"])(
		"retains %s when the lower-cost Seedance variants cannot serve it",
		(resolution) => {
			const draft = changeVideoDraft(
				{ ...initialVideoDraft, resolution, duration: 8 },
				{ productKey: "video-seedance-2" },
				catalog,
			);
			expect(draft).toMatchObject({ productKey: "video-seedance-2", resolution, duration: 8 });
		},
	);
	it("chooses Turbo only when the incoming native-audio tuple actually costs less", () => {
		expect(
			changeVideoDraft(
				{ ...initialVideoDraft, sound: true, resolution: "720p" },
				{ productKey: "video-kling-3" },
				catalog,
			).productKey,
		).toBe("video-kling-3-turbo");
		expect(
			changeVideoDraft(initialVideoDraft, { productKey: "video-kling-3" }, catalog).productKey,
		).toBe("video-kling-3");
	});
	it("keeps an explicit tier across model changes, catalog price changes and owner draft restoration", () => {
		let draft = changeVideoDraft(initialVideoDraft, { productKey: "video-veo-3-1" }, catalog);
		draft = changeVideoDraft(draft, { veoTier: "quality" }, catalog);
		draft = changeVideoDraft(draft, { productKey: "video-seedance-2" }, catalog);
		expect(draft).not.toHaveProperty("veoTier");
		const changedCatalog = {
			...catalog,
			models: catalog.models.map((model) => ({
				...model,
				options: model.options.map((option) => ({ ...option, credits: "1" })),
			})),
		};
		draft = changeVideoDraft(draft, { productKey: "video-veo-3-1" }, changedCatalog);
		expect(draft.veoTier).toBe("quality");
		const controls = videoVariantControls(draft, changedCatalog)!;
		expect(controls.base.id).toBe("lite");
		expect(
			controls.alternatives.filter((variant) => variant.pressed).map((variant) => variant.id),
		).toEqual(["quality"]);
		expect(
			changeVideoDraft(
				draft,
				controls.alternatives.find((variant) => variant.id === "quality")!.patch,
				changedCatalog,
			),
		).toMatchObject({ veoTier: "lite", duration: 8, resolution: "720p" });
		expect(parseVideoDraft(serializeVideoDraft(draft, "owner", 100), "owner", 101)?.veoTier).toBe(
			"quality",
		);
		expect(videoRequestFor(draft)).not.toHaveProperty("variantSelections");
	});
	it("restores an old generic editable draft as its historical Fast tier without downgrading it", () => {
		const old = {
			...initialVideoDraft,
			productKey: "video-veo-3-1",
			duration: 4,
			resolution: "1080p",
			sound: true,
		};
		expect(parseVideoDraft(serializeVideoDraft(old, "owner", 100), "owner", 101)).toMatchObject({
			veoTier: "fast",
			duration: 4,
			resolution: "1080p",
		});
		const receipt = createVideoConfirmation(
			videoRequestFor({ ...old, prompt: "A calm lake" }),
			{
				quoteId: "old",
				credits: "50",
				expiresAt: "2026-10-01T00:00:00Z",
				requestFingerprint: "historical",
			},
			() => "same-key",
		);
		expect(parseVideoConfirmation(JSON.stringify(receipt))?.input).toEqual(receipt.input);
		expect(receipt.input.request).not.toHaveProperty("veoTier");
	});
	it("recognizes exact INVALID_VIDEO_QUOTE as definite rejection while preserving unknown receipt identity", () => {
		expect(
			getVideoFailureRecovery({ code: "BAD_REQUEST", data: { code: "INVALID_VIDEO_QUOTE" } }),
		).toMatchObject({
			clearQuote: true,
			refreshCatalog: true,
			normalizeDraft: true,
			reason: "quoteExpired",
		});
		for (const error of [
			{ code: "BAD_REQUEST" },
			{ message: "INVALID_VIDEO_QUOTE_TIMEOUT" },
			{ code: "TIMEOUT" },
		])
			expect(getVideoFailureRecovery(error).clearQuote).toBe(false);
	});
});
