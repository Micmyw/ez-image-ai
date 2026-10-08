import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { describe, expect, it, vi } from "vitest";

import { buildKieVideoModelRequest, KieVideoModelsAdapter } from "./kie-video-models";

const base = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat crosses a calm lake",
	duration: 8,
	resolution: "720p",
	aspectRatio: "16:9",
	sound: true,
	callbackUrl: "https://app.example.test/api/webhooks/video/kie/frozen",
};
const highUrl = "https://cdn.example.test/high.mp4";
const originalUrl = "https://cdn.example.test/original.mp4";
const context = {
	resolution: "1080p",
	veoTier: "quality" as const,
	modelContractVersion: VIDEO_MODEL_CATALOG_VERSION,
};
function adapterFor(resultJson: unknown, fields: Record<string, unknown> = {}, code = 200) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({
			code,
			data: {
				taskId: "frozen-task",
				state: "success",
				resultJson: typeof resultJson === "string" ? resultJson : JSON.stringify(resultJson),
				...fields,
			},
		}),
	);
	return { fetch, adapter: new KieVideoModelsAdapter({ apiKey: "fixture", fetch }) };
}
describe("explicit generic Veo provider contract", () => {
	const cases = (
		[
			["lite", "veo3_lite"],
			["fast", "veo3_fast"],
			["quality", "veo3"],
		] as const
	).flatMap(([veoTier, providerModel]) =>
		["720p", "1080p", "4k"].flatMap((resolution) =>
			[4, 6, 8].flatMap((duration) =>
				(["text-to-video", "image-to-video"] as const).map((mode) => ({
					veoTier,
					providerModel,
					resolution,
					duration,
					mode,
				})),
			),
		),
	);
	it.each(cases)(
		"sends explicit $providerModel for $mode $resolution $duration",
		({ providerModel, ...selection }) => {
			const image = selection.mode === "image-to-video";
			const result = buildKieVideoModelRequest({
				...base,
				...selection,
				...(image
					? { inputAssetId: "sealed", imageUrl: "https://private.example.test/first.png" }
					: {}),
			});
			expect(result).toEqual({
				model: "veo-3-1",
				callBackUrl: base.callbackUrl,
				input: {
					prompt: base.prompt,
					model: providerModel,
					duration: selection.duration,
					resolution: selection.resolution,
					aspect_ratio: "16:9",
					enable_translation: false,
					generation_type: image ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO",
					...(image ? { image_urls: ["https://private.example.test/first.png"] } : {}),
				},
			});
		},
	);
	it("does not insert a new Lite tier into the old generic request", () => {
		expect(buildKieVideoModelRequest(base)).toMatchObject({
			model: "veo-3-1",
			input: { duration: 8, resolution: "720p" },
		});
		expect((buildKieVideoModelRequest(base) as { input: object }).input).not.toHaveProperty(
			"model",
		);
	});
	it.each(["1080p", "4k"])(
		"takes only the frozen %s upgraded result, never the original",
		async (resolution) => {
			const { adapter, fetch } = adapterFor({
				data: { result_urls: [highUrl], origin_urls: [originalUrl] },
			});
			await expect(
				adapter.retrieve("frozen-task", "video-veo-3-1", { ...context, resolution }),
			).resolves.toMatchObject({ status: "SUCCEEDED", outputUrl: highUrl });
			expect(fetch.mock.calls.map(([url]) => url)).toEqual([
				"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=frozen-task",
			]);
		},
	);
	it("retains the documented generic 720p resultUrls format", async () => {
		const { adapter } = adapterFor({ resultUrls: [originalUrl] });
		await expect(
			adapter.retrieve("frozen-task", "video-veo-3-1", { ...context, resolution: "720p" }),
		).resolves.toMatchObject({ status: "SUCCEEDED", outputUrl: originalUrl });
	});
	it.each(["video-veo-3-1-fast", "video-kling-3"])(
		"never applies the explicit Veo contract to foreign product %s",
		async (productKey) => {
			const { adapter, fetch } = adapterFor({ data: { result_urls: [highUrl] } });
			await expect(adapter.retrieve("frozen-task", productKey, context)).rejects.toThrow(
				"VIDEO_MODEL_CONTRACT_UNAVAILABLE",
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("rejects an unknown frozen model contract before retrieving results", async () => {
		const { adapter, fetch } = adapterFor({ data: { result_urls: [highUrl] } });
		await expect(
			adapter.retrieve("frozen-task", "video-veo-3-1", {
				...context,
				modelContractVersion: "unverified-future-contract",
			}),
		).rejects.toThrow("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		{ model: "kling-3.0/video" },
		{
			param: JSON.stringify({
				model: "veo-3-1",
				input: { model: "veo3_lite", resolution: "1080p" },
			}),
		},
		{ param: JSON.stringify({ model: "veo-3-1", input: { model: "veo3", resolution: "720p" } }) },
		{ param: "not-json" },
	])("rejects contradictory authoritative request metadata %j", async (fields) => {
		const { adapter } = adapterFor({ data: { result_urls: [highUrl] } }, fields);
		await expect(adapter.retrieve("frozen-task", "video-veo-3-1", context)).rejects.toThrow(
			"VIDEO_PROVIDER_INVALID_RESPONSE",
		);
	});
	it("accepts the matching request metadata without inferring it from callback fields", async () => {
		const { adapter } = adapterFor(
			{ data: { result_urls: [highUrl] } },
			{
				model: "veo-3-1",
				param: JSON.stringify({ model: "veo-3-1", input: { model: "veo3", resolution: "1080p" } }),
			},
		);
		await expect(adapter.retrieve("frozen-task", "video-veo-3-1", context)).resolves.toMatchObject({
			status: "SUCCEEDED",
			outputUrl: highUrl,
		});
	});
	it("reads the documented string-encoded input within param", async () => {
		const { adapter } = adapterFor(
			{ data: { result_urls: [highUrl] } },
			{
				model: "veo-3-1",
				param: JSON.stringify({
					model: "veo-3-1",
					input: JSON.stringify({ model: "veo3", resolution: "1080p" }),
				}),
			},
		);
		await expect(adapter.retrieve("frozen-task", "video-veo-3-1", context)).resolves.toMatchObject({
			status: "SUCCEEDED",
		});
	});
	it.each([
		{ resultUrls: [originalUrl] },
		{ data: { origin_urls: [originalUrl] } },
		{ data: { result_urls: [] } },
		{ data: { result_urls: [highUrl, originalUrl] } },
		{ data: { result_urls: ["http://cdn.example.test/video.mp4"] } },
		{ data: { result_urls: ["https://user:pass@cdn.example.test/video.mp4"] } },
		{ data: { result_urls: ["https://cdn.example.test/video.mp4#fragment"] } },
		"not-json",
	])("rejects invalid or lower-resolution results %j", async (body) => {
		const { adapter } = adapterFor(body);
		await expect(adapter.retrieve("frozen-task", "video-veo-3-1", context)).rejects.toThrow(
			"VIDEO_PROVIDER_INVALID_RESPONSE",
		);
	});
	it.each([
		{ fields: { taskId: "other-task" }, code: 200 },
		{ fields: {}, code: 500 },
		{ fields: { state: "invented" }, code: 200 },
	])("rejects unauthoritative task results %j", async ({ fields, code }) => {
		const { adapter } = adapterFor({ data: { result_urls: [highUrl] } }, fields, code);
		await expect(adapter.retrieve("frozen-task", "video-veo-3-1", context)).rejects.toThrow(
			"VIDEO_PROVIDER_INVALID_RESPONSE",
		);
	});
	it.each(["waiting", "queuing", "generating", "fail"])(
		"retains authoritative %s before reading output",
		async (state) => {
			const { adapter } = adapterFor({ data: { result_urls: [highUrl] } }, { state });
			await expect(
				adapter.retrieve("frozen-task", "video-veo-3-1", context),
			).resolves.toMatchObject({ status: state === "fail" ? "FAILED" : "PENDING" });
		},
	);
});
