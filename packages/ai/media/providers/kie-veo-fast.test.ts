import { getVideoModelOptions } from "@repo/config/video-models";
import { describe, expect, it, vi } from "vitest";

import officialFixture from "../catalog/fixtures/kie-veo-fast-contract-2026-10-05.json";
import { buildKieVeoFastRequest, KieVeoFastAdapter } from "./kie-veo-fast";
import type { KieVideoModelInput } from "./kie-video-models";

const textInput: KieVideoModelInput = {
	productKey: "video-veo-3-1-fast",
	mode: "text-to-video",
	prompt: "A quiet mountain lake under a blue sky",
	duration: 4,
	resolution: "720p",
	aspectRatio: "16:9",
	sound: true,
	callbackUrl: "https://example.test/api/webhooks/video/kie/bound-proof",
};
const imageInput: KieVideoModelInput = {
	...textInput,
	mode: "image-to-video",
	aspectRatio: "source",
	inputAssetId: "sealed-private-asset",
	imageUrl: "https://media.example.test/immutable-input.png",
};
const providerTaskId = "veo_task_fixture_123";
const outputUrl = "https://media.example.test/output.mp4";
const success = {
	taskId: providerTaskId,
	successFlag: 1,
	paramJson: JSON.stringify({ model: "veo3_fast", duration: 4, resolution: "720p" }),
	response: { taskId: providerTaskId, resultUrls: [outputUrl], resolution: "720p" },
};
function fetchRecord(data: unknown, status = 200) {
	return vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: 200, data }, { status }));
}

describe("Kie Veo 3.1 Fast legacy contract", () => {
	it("uses the top-level official request and preserves the reviewed prompt", () => {
		expect(buildKieVeoFastRequest(textInput)).toEqual({
			model: "veo3_fast",
			prompt: textInput.prompt,
			callBackUrl: textInput.callbackUrl,
			duration: 4,
			resolution: "720p",
			aspect_ratio: "16:9",
			generationType: "TEXT_2_VIDEO",
			enableTranslation: false,
		});
		const image = buildKieVeoFastRequest(imageInput);
		expect(image).toMatchObject({
			generationType: "FIRST_AND_LAST_FRAMES_2_VIDEO",
			imageUrls: [imageInput.imageUrl],
			aspect_ratio: "Auto",
		});
		for (const field of ["input", "sound", "enableFallback", "inputAssetId", "productKey"])
			expect(image).not.toHaveProperty(field);
	});
	it("matches the saved official property names and enums for all admitted tuples", () => {
		const properties = officialFixture.submit.request.properties as Record<
			string,
			{ enum?: unknown[] }
		>;
		for (const mode of ["text-to-video", "image-to-video"] as const) {
			const options = getVideoModelOptions(textInput.productKey, mode);
			expect(options.length).toBeGreaterThan(0);
			for (const option of options) {
				const request = buildKieVeoFastRequest({
					...(mode === "text-to-video" ? textInput : imageInput),
					...option,
				});
				for (const [key, value] of Object.entries(request)) {
					expect(properties[key], key).toBeDefined();
					if (properties[key]?.enum) expect(properties[key]!.enum).toContain(value);
				}
			}
		}
	});
	it.each([
		{ productKey: "video-veo-3-1" },
		{ productKey: "video-veo-3-1-pro" },
		{ productKey: "video-kling-2-6-v1" },
		{ duration: 5 },
		{ sound: false },
		{ resolution: "480p" },
		{ aspectRatio: "1:1" },
		{ aspectRatio: "source" },
		{ prompt: "x".repeat(1001) },
		{ imageUrl: "https://media.example.test/extra.png" },
		{ inputAssetId: "unexpected-asset" },
		{ enableFallback: true },
		{ enableTranslation: true },
	])("rejects unsupported or conflicting selections before a POST: %j", async (extra) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit({ ...textInput, ...extra }),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		"http://example.test/callback",
		"https://user:pass@example.test/callback",
		"https://example.test/callback#fragment",
		" https://example.test/callback",
		"https://example.test/call\nback",
	])("rejects an unsafe callback or source URL: %s", (url) => {
		expect(() => buildKieVeoFastRequest({ ...textInput, callbackUrl: url })).toThrow();
		expect(() => buildKieVeoFastRequest({ ...imageInput, imageUrl: url })).toThrow();
	});
	it("requires both the immutable input binding and its server-supplied image URL", () => {
		expect(() => buildKieVeoFastRequest({ ...imageInput, inputAssetId: undefined })).toThrow();
		expect(() => buildKieVeoFastRequest({ ...imageInput, imageUrl: undefined })).toThrow();
	});
	it("submits once to the documented endpoint and accepts only a valid returned task ID", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 200, data: { taskId: providerTaskId } }),
		);
		expect(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).toEqual({
			status: "ACCEPTED",
			providerTaskId,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toBe(officialFixture.submit.endpoint);
		const init = fetch.mock.calls[0]![1]!;
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		expect(JSON.parse(init.body as string)).toEqual(buildKieVeoFastRequest(textInput));
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture");
		expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
	});
	it.each([401, 402, 404, 422])("recognizes explicit rejection %s without retry", async (code) => {
		for (const status of [200, code]) {
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({ code, data: null }, { status }),
			);
			expect(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).toEqual({
				status: "DEFINITELY_REJECTED",
				reasonCode: `VIDEO_PROVIDER_REJECTED_${code}`,
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		}
	});
	it.each([
		{ data: { taskId: providerTaskId, task_id: "another-task" } },
		{ data: { taskId: providerTaskId, task_id: null } },
		{ taskId: "another-task", data: { taskId: providerTaskId } },
		{ task_id: "another-task", data: { taskId: providerTaskId } },
	])("does not accept contradictory task identity copies: %j", async (body) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: 200, ...body }));
		expect(
			(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).status,
		).toBe("UNCERTAIN");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("accepts additional identity copies only when they all match the canonical task ID", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				code: 200,
				taskId: providerTaskId,
				task_id: providerTaskId,
				data: { taskId: providerTaskId, task_id: providerTaskId },
			}),
		);
		expect(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).toEqual({
			status: "ACCEPTED",
			providerTaskId,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([400, 408, 409, 425, 429, 455, 500, 501, 505])(
		"keeps ambiguous code %s reserved without retrying the paid request",
		async (code) => {
			for (const status of [200, code]) {
				const fetch = vi.fn<typeof globalThis.fetch>(async () =>
					Response.json({ code, data: null }, { status }),
				);
				expect(
					(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).status,
				).toBe("UNCERTAIN");
				expect(fetch).toHaveBeenCalledTimes(1);
			}
		},
	);
	it.each([providerTaskId, "invalid task ID"])(
		"does not release credits for a contradictory rejection carrying task identity %s",
		async (taskId) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({ code: 422, data: { taskId } }),
			);
			expect(
				(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).status,
			).toBe("UNCERTAIN");
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		{ status: 422, body: { code: 500, data: null } },
		{ status: 401, body: { code: 200, data: {} } },
		{ status: 422, body: { data: { taskId: providerTaskId } } },
		{ status: 422, body: { code: "200", data: { taskId: providerTaskId } } },
		{ status: 422, body: { code: 422, data: { task_id: providerTaskId } } },
		{ status: 422, body: { code: 422, taskId: providerTaskId } },
		{ status: 422, body: { code: 422, task_id: providerTaskId } },
		{ status: 500, body: { code: 422, data: null } },
		{ status: 401, body: {} },
	])(
		"preserves uncertainty for contradictory or malformed rejection: %j",
		async ({ status, body }) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
			expect(
				(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).status,
			).toBe("UNCERTAIN");
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		{ code: 200, data: {} },
		{ code: 200, data: { taskId: "bad task" } },
		{ code: 200, data: { task_id: providerTaskId } },
		{ data: { taskId: providerTaskId } },
	])("does not manufacture acceptance from malformed submission responses: %j", async (body) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body));
		expect(
			(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).submit(textInput)).status,
		).toBe("UNCERTAIN");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each(["network", "malformed", "redirect", "oversized"])(
		"does not retry a %s submission failure",
		async (failure) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () => {
				if (failure === "network") throw new Error("Connection lost after upload");
				if (failure === "redirect")
					return new Response(null, { status: 307, headers: { Location: "https://other.test" } });
				if (failure === "oversized") return Response.json({ padding: "x".repeat(64 * 1024) });
				return new Response("not JSON");
			});
			expect(
				(
					await new KieVeoFastAdapter({
						apiKey: "fixture",
						fetch,
						maxResponseBytes: 1_000_000,
					}).submit(textInput)
				).status,
			).toBe("UNCERTAIN");
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps a timed-out POST uncertain and never retries it", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), {
						once: true,
					});
				}),
		);
		expect(
			(await new KieVeoFastAdapter({ apiKey: "fixture", fetch, timeoutMs: 5 }).submit(textInput))
				.status,
		).toBe("UNCERTAIN");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not send a request without provider configuration", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const adapter = new KieVeoFastAdapter({ apiKey: " ", fetch });
		expect(await adapter.submit(textInput)).toEqual({
			status: "DEFINITELY_REJECTED",
			reasonCode: "VIDEO_PROVIDER_CONFIGURATION_ERROR",
		});
		await expect(adapter.retrieve(providerTaskId)).rejects.toThrow(
			"VIDEO_PROVIDER_CONFIGURATION_ERROR",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads the authoritative legacy response without inventing billing or completion time", async () => {
		const fetch = fetchRecord(success);
		expect(
			await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
		).toEqual({
			status: "SUCCEEDED",
			outputUrl,
			providerCostMicros: null,
			providerCreditsConsumed: null,
			providerCompletedAt: null,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			`${officialFixture.retrieve.endpoint}?taskId=${providerTaskId}`,
		);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
	});
	it("returns pending without polling", async () => {
		const fetch = fetchRecord({ taskId: providerTaskId, successFlag: 0, response: null });
		expect(
			await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
		).toEqual({
			status: "PENDING",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it.each([2, 3])(
		"uses authoritative failure flag %s and never copies the provider message",
		async (successFlag) => {
			const fetch = fetchRecord({
				taskId: providerTaskId,
				successFlag,
				errorMessage: "untrusted provider content",
				creditsConsumed: 0,
			});
			expect(
				await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
			).toEqual({
				status: "FAILED",
				reasonCode: "VIDEO_PROVIDER_GENERATION_FAILED",
				providerCostMicros: null,
				providerCreditsConsumed: 0,
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		{ taskId: "another-task" },
		{ successFlag: 4 },
		{ successFlag: "1" },
		{ fallbackFlag: true },
		{ response: { taskId: "another-task", resultUrls: [outputUrl] } },
		{ response: { resultUrls: JSON.stringify([outputUrl]) } },
		{ response: { resultUrls: [] } },
		{ response: { resultUrls: [outputUrl, outputUrl] } },
		{ response: { resultUrls: ["http://media.example.test/output.mp4"] } },
		{ response: null },
		{ paramJson: JSON.stringify({ model: "veo3" }) },
		{ paramJson: JSON.stringify({ model: "veo3_lite" }) },
		{ paramJson: JSON.stringify({ model: null }) },
		{ paramJson: "invalid JSON" },
		{ paramJson: "null" },
		{ paramJson: "[]" },
		{ creditsConsumed: -1 },
		{ creditsConsumed: "60" },
	])("rejects identity, model, result or billing ambiguity: %j", async (extra) => {
		const fetch = fetchRecord({ ...success, ...extra });
		await expect(
			new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("tolerates omitted model metadata and nested identity while requiring the canonical task ID", async () => {
		const fetch = fetchRecord({
			...success,
			paramJson: undefined,
			response: { resultUrls: [outputUrl] },
		});
		expect(
			(await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId)).status,
		).toBe("SUCCEEDED");
	});
	it("preserves returned numeric credits and a timestamp with an explicit timezone", async () => {
		const fetch = fetchRecord({
			...success,
			creditsConsumed: 60,
			completeTime: "2026-10-05T01:00:00+08:00",
		});
		expect(
			await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
		).toMatchObject({
			providerCreditsConsumed: 60,
			providerCompletedAt: "2026-10-04T17:00:00.000Z",
		});
	});
	it.each([
		"2025-06-06 10:30:00",
		1750000000000,
		"invalid",
		"2026-99-99T00:00:00Z",
		"2026-02-31T00:00:00Z",
	])("does not invent a UTC completion time from %s", async (completeTime) => {
		const fetch = fetchRecord({ ...success, completeTime });
		expect(
			await new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
		).toMatchObject({
			providerCompletedAt: null,
		});
	});
	it.each([404, 422, 429, 500])(
		"does not treat query HTTP %s as a failed generation or retry it",
		async (status) => {
			const fetch = fetchRecord(success, status);
			await expect(
				new KieVeoFastAdapter({ apiKey: "fixture", fetch }).retrieve(providerTaskId),
			).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("bounds query responses and rejects malformed task identity before any read", async () => {
		const fetch = fetchRecord({ ...success, padding: "x".repeat(64 * 1024) });
		const adapter = new KieVeoFastAdapter({
			apiKey: "fixture",
			fetch,
			maxResponseBytes: 1_000_000,
		});
		await expect(adapter.retrieve("../another-task")).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		await expect(adapter.retrieve(providerTaskId)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
