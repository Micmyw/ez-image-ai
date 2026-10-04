import {
	createVideoVisualSafetyProfile,
	readVideoVisualSafetyProfile,
} from "@repo/config/video-safety";
import { describe, expect, it, vi } from "vitest";

import { createConfiguredVideoSafetyAdapter } from "./video-configured";

const environment = {
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	SEEAPI_API_KEY: "fixture-key",
};
const profile = createVideoVisualSafetyProfile("seeapi", 5);
const input = {
	assetUrl: "https://private.example/output.mp4",
	callbackUrl: "https://app.example/callback/task-bound-proof",
	idempotencyKey: "asset-fixture",
	ruleVersion: profile.ruleVersion,
	visualSafetyProfile: profile,
	video: { durationMillis: 5000, audioTrackIds: [] },
};
const task = {
	id: "task_fixture",
	object: "inference",
	model: "video-nsfw-filter",
	endpoint: "video-moderation",
	provider: "seeapi",
	status: "processing",
	result: null,
	error: null,
};

describe("SeeAPI-only video safety composition", () => {
	it.each([undefined, "sightengine", "waffo"])(
		"does not use a text/image synchronous shortcut for setting %s",
		async (setting) => {
			const fetch = vi.fn<typeof globalThis.fetch>();
			const adapter = createConfiguredVideoSafetyAdapter(
				{
					...environment,
					VIDEO_V1_TEXT_SAFETY_ADAPTER: setting,
					VIDEO_V1_IMAGE_SAFETY_ADAPTER: setting,
				},
				{ fetch },
				profile,
			);
			expect(
				await adapter.moderateText({ text: "fixture", ruleVersion: profile.ruleVersion }),
			).toMatchObject({ decision: "ERROR", reasonCode: "VIDEO_TEXT_MODERATION_USE_WAFFO" });
			expect(await adapter.moderateImage(input)).toMatchObject({
				decision: "ERROR",
				reasonCode: "MODERATION_ASYNC_IMAGE_REQUIRED",
			});
			expect(typeof adapter.submitImage).toBe("undefined");
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("provides asynchronous SeeAPI image review with strict existing image settings", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json(
				{ ...task, model: "nsfw-filter", endpoint: "image-moderation" },
				{ status: 202 },
			),
		);
		const adapter = createConfiguredVideoSafetyAdapter(environment, { fetch }, profile);
		expect(typeof adapter.submitImage).toBe("function");
		expect(await adapter.submitImage!(input)).toMatchObject({ moderationTaskId: "task_fixture" });
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
			model: "nsfw-filter",
			input: { image_url: input.assetUrl, threshold_offset: 0, strict_special_care: true },
		});
	});
	it("submits video only to the SeeAPI inference endpoint with the frozen profile", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(task, { status: 202 }));
		const adapter = createConfiguredVideoSafetyAdapter(environment, { fetch }, profile);
		expect(await adapter.submitVideo({ ...input, visualSafetyProfile: undefined })).toMatchObject({
			moderationTaskId: "task_fixture",
		});
		expect(fetch.mock.calls[0]![0]).toBe("https://api.seeapi.com/v1/inferences");
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({
			model: "video-nsfw-filter",
			callback_url: input.callbackUrl,
			input: { num_frames: 8 },
		});
	});
	it.each([undefined, "unknown", "test", "sightengine"])(
		"cannot execute an unsupported current provider %s",
		async (provider) => {
			const fetch = vi.fn<typeof globalThis.fetch>();
			const adapter = createConfiguredVideoSafetyAdapter(
				{ ...environment, VIDEO_V1_VIDEO_SAFETY_ADAPTER: provider },
				{ fetch },
			);
			const reason =
				provider === "sightengine"
					? "VIDEO_VISUAL_PROVIDER_RETIRED"
					: "VIDEO_MODERATION_NOT_CONFIGURED";
			await expect(adapter.submitVideo(input)).rejects.toThrow(reason);
			expect(await adapter.retrieveVideo({ ...input, moderationTaskId: task.id })).toMatchObject({
				decision: "ERROR",
				reasonCode: reason,
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, createVideoVisualSafetyProfile("sightengine", 5)])(
		"retains historical Sightengine identity but never drains it through an external adapter",
		async (visualSafetyProfile) => {
			const historical = readVideoVisualSafetyProfile({
				duration: 5,
				...(visualSafetyProfile ? { visualSafetyProfile } : {}),
			});
			const fetch = vi.fn<typeof globalThis.fetch>();
			const adapter = createConfiguredVideoSafetyAdapter(environment, { fetch }, historical);
			await expect(
				adapter.submitVideo({
					...input,
					ruleVersion: historical.ruleVersion,
					visualSafetyProfile: historical,
				}),
			).rejects.toThrow("VIDEO_VISUAL_PROVIDER_RETIRED");
			expect(
				await adapter.retrieveVideo({
					moderationTaskId: "med_legacy",
					ruleVersion: historical.ruleVersion,
					visualSafetyProfile: historical,
				}),
			).toMatchObject({ decision: "ERROR", reasonCode: "VIDEO_VISUAL_PROVIDER_RETIRED" });
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("rejects a changed policy binding before any provider request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const adapter = createConfiguredVideoSafetyAdapter(environment, { fetch }, profile);
		await expect(adapter.submitVideo({ ...input, ruleVersion: "other-rule" })).rejects.toThrow(
			"VIDEO_SAFETY_PROFILE_INVALID",
		);
		await expect(
			adapter.submitVideo({
				...input,
				visualSafetyProfile: createVideoVisualSafetyProfile("sightengine", 5),
			}),
		).rejects.toThrow("VIDEO_SAFETY_PROFILE_INVALID");
		expect(fetch).not.toHaveBeenCalled();
	});
});
