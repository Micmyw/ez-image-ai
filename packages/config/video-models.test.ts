import { describe, expect, it } from "vitest";

import {
	getVideoModel,
	getVideoModelOptions,
	VIDEO_MODEL_CATALOG,
	validateVideoModelSelection,
	videoModelInputSchema,
} from "./video-models";

describe("official video model capabilities", () => {
	it("has unique public keys and valid defaults for every implemented mode", () => {
		expect(new Set(VIDEO_MODEL_CATALOG.map((model) => model.productKey)).size).toBe(
			VIDEO_MODEL_CATALOG.length,
		);
		for (const model of VIDEO_MODEL_CATALOG) {
			for (const mode of model.modes) {
				expect(
					validateVideoModelSelection({
						productKey: model.productKey,
						mode,
						...model.defaults[mode]!,
					}),
				).toBe(true);
				for (const option of getVideoModelOptions(model.productKey, mode)) {
					expect(
						videoModelInputSchema.safeParse({
							...option,
							productKey: model.productKey,
							mode,
							prompt: "A quiet landscape",
							...(mode === "image-to-video" ? { inputAssetId: "sealed-image" } : {}),
						}).success,
					).toBe(true);
				}
			}
		}
	});
	it("does not infer unsupported variants or competitor capabilities", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "blocked")) {
			expect(model.blockedReason).toBeTruthy();
			expect(getVideoModelOptions(model.productKey, "text-to-video")).toEqual([]);
		}
		expect(
			getVideoModelOptions("video-minimax-h3", "text-to-video").some(
				(option) => option.resolution === "480p",
			),
		).toBe(false);
		expect(getVideoModelOptions("video-seedance-1-pro-fast", "text-to-video")).toEqual([]);
		expect(
			getVideoModelOptions("video-gemini-omni-flash", "text-to-video").some(
				(option) => option.duration === 3,
			),
		).toBe(false);
	});
	it("supports the documented Seedance 1.5 Pro parameters in both modes", () => {
		const model = getVideoModel("video-seedance-1-5-pro")!;
		for (const mode of ["text-to-video", "image-to-video"] as const) {
			const options = getVideoModelOptions(model.productKey, mode);
			expect([...new Set(options.map((option) => option.duration))]).toEqual([
				4, 5, 6, 7, 8, 9, 10, 11, 12,
			]);
			expect(new Set(options.map((option) => option.resolution))).toEqual(
				new Set(["480p", "720p", "1080p"]),
			);
			expect(new Set(options.map((option) => option.aspectRatio))).toEqual(
				new Set(["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"]),
			);
			expect(new Set(options.map((option) => option.sound))).toEqual(new Set([false, true]));
			for (const change of [
				{ duration: 3 },
				{ duration: 13 },
				{ duration: 5.5 },
				{ resolution: "4k" },
				{ aspectRatio: "adaptive" },
				{ aspectRatio: "source" },
			]) {
				expect(
					validateVideoModelSelection({
						productKey: model.productKey,
						mode,
						...model.defaults[mode]!,
						...change,
					}),
				).toBe(false);
			}
		}
	});
	it("rejects unsupported keys and cross-mode parameter combinations", () => {
		const selection = {
			productKey: "video-seedance-1-pro-fast",
			mode: "image-to-video" as const,
			duration: 5,
			resolution: "720p",
			aspectRatio: "source",
			sound: false,
		};
		expect(validateVideoModelSelection(selection)).toBe(true);
		for (const change of [
			{ mode: "text-to-video" as const },
			{ aspectRatio: "16:9" },
			{ sound: true },
			{ productKey: "video-veo-3-1-pro" },
			{ productKey: "bytedance/seedance-1.5-pro" },
		]) {
			expect(validateVideoModelSelection({ ...selection, ...change })).toBe(false);
		}
	});
	it("rejects incompatible mode, audio, duration and resolution selections", () => {
		const base = {
			productKey: "video-minimax-h3",
			mode: "text-to-video",
			prompt: "The sea",
			duration: 6,
			resolution: "768p",
			aspectRatio: "16:9",
			sound: true,
		};
		for (const change of [
			{ sound: false },
			{ duration: 16 },
			{ resolution: "480p" },
			{ aspectRatio: "source" },
			{ inputAssetId: "private" },
			{ providerModel: "arbitrary" },
		])
			expect(videoModelInputSchema.safeParse({ ...base, ...change }).success).toBe(false);
		expect(
			videoModelInputSchema.safeParse({ ...base, mode: "image-to-video", aspectRatio: "source" })
				.success,
		).toBe(false);
		expect(
			videoModelInputSchema.safeParse({
				...base,
				mode: "image-to-video",
				aspectRatio: "source",
				inputAssetId: "private",
			}).success,
		).toBe(true);
	});
	it("enforces each model's Unicode prompt bounds before payment", () => {
		for (const model of VIDEO_MODEL_CATALOG.filter((entry) => entry.status === "implemented")) {
			const mode = model.modes[0]!;
			const base = {
				productKey: model.productKey,
				mode,
				...model.defaults[mode]!,
				...(mode === "image-to-video" ? { inputAssetId: "sealed" } : {}),
			};
			expect(
				videoModelInputSchema.safeParse({ ...base, prompt: "海".repeat(model.maxPromptCodePoints) })
					.success,
			).toBe(true);
			expect(
				videoModelInputSchema.safeParse({
					...base,
					prompt: "海".repeat(model.maxPromptCodePoints + 1),
				}).success,
			).toBe(false);
			expect(videoModelInputSchema.safeParse({ ...base, prompt: " ".repeat(20) }).success).toBe(
				false,
			);
		}
	});
	it("represents provider-native audio as allowed, without a fake mute switch", () => {
		for (const key of [
			"video-minimax-h3",
			"video-gemini-omni-flash",
			"video-kling-3-turbo",
			"video-veo-3-1",
			"video-veo-3-1-fast",
		]) {
			expect(getVideoModel(key)?.audio).toBe("provider-native");
			expect(getVideoModelOptions(key, "text-to-video").every((option) => option.sound)).toBe(true);
		}
	});
	it("exposes only the documented old-endpoint Veo Fast capabilities", () => {
		const model = getVideoModel("video-veo-3-1-fast")!;
		expect(model.status).toBe("implemented");
		expect(model.defaults["text-to-video"]).toEqual({
			duration: 4,
			resolution: "720p",
			aspectRatio: "16:9",
			sound: true,
		});
		for (const group of model.groups) {
			expect(group.durations).toEqual([4, 6, 8]);
			expect(group.resolutions).toEqual(["720p", "1080p", "4k"]);
			expect(group.sounds).toEqual([true]);
		}
		expect(model.groups.find((group) => group.mode === "text-to-video")!.aspectRatios).toEqual([
			"16:9",
			"9:16",
		]);
		expect(model.groups.find((group) => group.mode === "image-to-video")!.aspectRatios).toEqual([
			"16:9",
			"9:16",
			"source",
		]);
		expect(getVideoModel("video-veo-3-1-pro")!.status).toBe("blocked");
	});
	it("caps provider-long prompts at the actual text moderation UTF-16 limit", () => {
		const model = getVideoModel("video-seedance-2-5")!;
		expect(model.maxPromptCodePoints).toBe(10000);
		const base = {
			productKey: model.productKey,
			mode: "text-to-video",
			...model.defaults["text-to-video"]!,
		};
		expect(videoModelInputSchema.safeParse({ ...base, prompt: "a".repeat(10000) }).success).toBe(
			true,
		);
		expect(videoModelInputSchema.safeParse({ ...base, prompt: "a".repeat(10001) }).success).toBe(
			false,
		);
		expect(videoModelInputSchema.safeParse({ ...base, prompt: "😀".repeat(5001) }).success).toBe(
			false,
		);
	});
});
