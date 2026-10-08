import { describe, expect, it, vi } from "vitest";

import {
	buildKieVideoModelRequest,
	KieVideoModelsAdapter,
	type KieVideoModelInput,
} from "./kie-video-models";

const input = {
	productKey: "video-veo-3-1",
	mode: "text-to-video" as const,
	prompt: "A sailboat on a lake",
	duration: 4,
	resolution: "1080p",
	aspectRatio: "16:9",
	sound: true,
	callbackUrl: "https://app.example/callback",
};
const tiers = [
	["lite", "veo3_lite"],
	["fast", "veo3_fast"],
	["quality", "veo3"],
] as const;
const context = {
	resolution: "1080p",
	veoTier: "lite" as const,
	modelContractVersion: "video-models-2026-10-08.1",
};
function fixture(
	result: unknown = {
		data: {
			result_urls: ["https://media.example/high.mp4"],
			origin_urls: ["https://media.example/origin.mp4"],
		},
	},
	data: Record<string, unknown> = {},
) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({
			code: 200,
			data: {
				taskId: "task-1",
				state: "success",
				resultJson: JSON.stringify(result),
				...data,
			},
		}),
	);
	return { fetch, adapter: new KieVideoModelsAdapter({ apiKey: "test-only", fetch }) };
}
describe("frozen Veo contract consumer bridge", () => {
	it.each(tiers)(
		"maps explicit %s to %s without changing generic outer route",
		(veoTier, model) => {
			for (const resolution of ["720p", "1080p", "4k"]) {
				for (const duration of [4, 6, 8]) {
					for (const mode of ["text-to-video", "image-to-video"] as const) {
						const body = buildKieVideoModelRequest({
							...input,
							veoTier,
							duration,
							resolution,
							mode,
							...(mode === "image-to-video"
								? {
										inputAssetId: "sealed",
										imageUrl: "https://media.example/input.png",
										aspectRatio: "source",
									}
								: {}),
						});
						expect(body.model).toBe("veo-3-1");
						if (!("input" in body)) throw new Error("Expected the generic Market payload");
						expect(body.input).toMatchObject({
							model,
							resolution,
							duration,
							aspect_ratio: mode === "image-to-video" ? "Auto" : "16:9",
						});
					}
				}
			}
		},
	);
	it("preserves the exact absent-tier generic payload", () => {
		expect(buildKieVideoModelRequest(input)).toEqual({
			model: "veo-3-1",
			callBackUrl: input.callbackUrl,
			input: {
				prompt: input.prompt,
				duration: 4,
				resolution: "1080p",
				aspect_ratio: "16:9",
				enable_translation: false,
				generation_type: "TEXT_2_VIDEO",
			},
		});
	});
	it.each(tiers)(
		"sends one %s task and retains uncertainty without fallback",
		async (veoTier, model) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 503 }));
			const adapter = new KieVideoModelsAdapter({ apiKey: "test-only", fetch });
			expect(await adapter.submit({ ...input, veoTier })).toMatchObject({ status: "UNCERTAIN" });
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
			const body = fetch.mock.calls[0]![1]!.body;
			if (typeof body !== "string") throw new Error("Expected a JSON request body");
			expect(JSON.parse(body)).toMatchObject({
				model: "veo-3-1",
				input: { model },
			});
		},
	);
	it.each(tiers)("reads authoritative frozen %s high resolution output", async (veoTier, model) => {
		for (const resolution of ["1080p", "4k"]) {
			const { adapter, fetch } = fixture(undefined, {
				model: "veo-3-1",
				param: JSON.stringify({ model: "veo-3-1", input: JSON.stringify({ model, resolution }) }),
			});
			expect(
				await adapter.retrieve("task-1", "video-veo-3-1", { ...context, resolution, veoTier }),
			).toMatchObject({ status: "SUCCEEDED", outputUrl: "https://media.example/high.mp4" });
			expect(fetch.mock.calls[0]![0]).toBe(
				"https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-1",
			);
		}
	});
	it("keeps the old generic and frozen 720p resultUrls shape", async () => {
		const { adapter } = fixture({ resultUrls: ["https://media.example/base.mp4"] });
		expect(await adapter.retrieve("task-1", "video-veo-3-1")).toMatchObject({
			outputUrl: "https://media.example/base.mp4",
		});
		expect(
			await adapter.retrieve("task-1", "video-veo-3-1", { ...context, resolution: "720p" }),
		).toMatchObject({ outputUrl: "https://media.example/base.mp4" });
	});
	it.each([
		{ data: { origin_urls: ["https://media.example/origin.mp4"] } },
		{ resultUrls: ["https://media.example/base.mp4"] },
		{ data: { result_urls: [] } },
		{ data: { result_urls: ["https://media.example/a.mp4", "https://media.example/b.mp4"] } },
		{ data: { result_urls: ["http://media.example/a.mp4"] } },
		{ data: { result_urls: ["https://user:password@media.example/a.mp4"] } },
		{ data: { result_urls: ["https://media.example/a.mp4#fragment"] } },
	])("never substitutes origin/legacy/invalid URLs for high resolution %j", async (result) => {
		await expect(
			fixture(result).adapter.retrieve("task-1", "video-veo-3-1", context),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
	});
	it.each([
		{ taskId: "other-task" },
		{ state: "unknown" },
		{ resultJson: "{" },
		{ resultJson: "a".repeat(32769) },
		{ model: "veo3_fast" },
		{ param: "{" },
		{ param: "a".repeat(32769) },
		{ param: JSON.stringify({ model: "veo-3-1", input: { model: "veo3", resolution: "1080p" } }) },
		{
			param: JSON.stringify({
				model: "veo-3-1",
				input: { model: "veo3_lite", resolution: "720p" },
			}),
		},
	])("rejects mismatched or malformed authoritative data %j", async (data) => {
		await expect(
			fixture(undefined, data).adapter.retrieve("task-1", "video-veo-3-1", context),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
	});
	it.each(["waiting", "queuing", "generating", "fail"])(
		"does not consume URLs in %s state",
		async (state) => {
			expect(
				await fixture(null, { state }).adapter.retrieve("task-1", "video-veo-3-1", context),
			).toMatchObject({ status: state === "fail" ? "FAILED" : "PENDING" });
		},
	);
	it.each([
		{ modelContractVersion: "video-models-2026-10-04.2" },
		{ modelContractVersion: "video-models-2099-01-01.1" },
		{ resolution: "8k" },
		{ veoTier: "pro" },
	])("rejects an unknown frozen result context before HTTP %j", async (extra) => {
		const { adapter, fetch } = fixture();
		await expect(
			adapter.retrieve("task-1", "video-veo-3-1", { ...context, ...extra } as never),
		).rejects.toThrow("VIDEO_MODEL_CONTRACT_UNAVAILABLE");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(["video-veo-3-1-fast", "video-kling-3"])(
		"rejects explicit tiers on foreign %s routes",
		async (productKey) => {
			const { adapter, fetch } = fixture();
			expect(() =>
				buildKieVideoModelRequest({ ...input, productKey, veoTier: "lite" } as KieVideoModelInput),
			).toThrow();
			await expect(adapter.retrieve("task-1", productKey, context)).rejects.toThrow(
				"VIDEO_MODEL_CONTRACT_UNAVAILABLE",
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
