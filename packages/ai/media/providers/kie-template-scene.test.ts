import { describe, expect, it, vi } from "vitest";

import { buildKieTemplateSceneRequest, KieTemplateSceneAdapter } from "./kie-template-scene";
import { buildKieVideoModelRequest } from "./kie-video-models";

const input = {
	productKey: "nano-banana-2-lite-1k" as const,
	prompt: "Create exactly two performers with left and right identities.",
	referenceUrls: ["https://private.example/left", "https://private.example/right"] as [
		string,
		string,
	],
	aspectRatio: "9:16" as const,
	outputCount: 1 as const,
	callbackUrl: "https://ezpic.example/api/webhooks/video-template/kie/token",
};
describe("template-only two-reference scene mapping", () => {
	it("retains both identities in order and does not construct video first/last frames", () => {
		expect(buildKieTemplateSceneRequest(input)).toEqual({
			model: "nano-banana-2-lite",
			callBackUrl: input.callbackUrl,
			input: { prompt: input.prompt, image_urls: input.referenceUrls, aspect_ratio: "9:16" },
		});
		expect(
			buildKieTemplateSceneRequest({
				...input,
				referenceUrls: [input.referenceUrls[1], input.referenceUrls[0]],
			}).input.image_urls[0],
		).toBe(input.referenceUrls[1]);
		expect(() =>
			buildKieTemplateSceneRequest({ ...input, referenceUrls: [input.referenceUrls[0]] as never }),
		).toThrow();
	});
	it("makes one POST when timeout or malformed success leaves paid acceptance uncertain", async () => {
		for (const response of [new Error("lost response"), new Response('{"code":200,"data":{}}')]) {
			const fetch = vi.fn().mockImplementation(async () => {
				if (response instanceof Error) throw response;
				return response;
			});
			const result = await new KieTemplateSceneAdapter({ apiKey: "fixture", fetch }).submit(input);
			expect(result.status).toBe("UNCERTAIN");
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	});
	it("requires the exact accepted task and one scene result", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: {
						taskId: "other",
						state: "success",
						resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/a.png"] }),
					},
				}),
			),
		);
		await expect(
			new KieTemplateSceneAdapter({ apiKey: "fixture", fetch }).retrieve("scene-task"),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
	});
	it("sets a fixed camera only for the internal template override, and disables audio", () => {
		const video = {
			productKey: "video-seedance-1-5-pro",
			mode: "image-to-video" as const,
			prompt: "Animate both people",
			duration: 5,
			resolution: "720p",
			aspectRatio: "9:16",
			sound: false,
			inputAssetId: "scene-asset",
			callbackUrl: input.callbackUrl,
			imageUrl: "https://private.example/scene",
		};
		expect(buildKieVideoModelRequest(video).input.fixed_lens).toBe(false);
		const body = buildKieVideoModelRequest({ ...video, templateFixedLens: true });
		expect(body.input.fixed_lens).toBe(true);
		expect(body.input.generate_audio).toBe(false);
		expect(body.input.input_urls).toEqual([video.imageUrl]);
	});
});
