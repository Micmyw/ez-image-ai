import { describe, expect, it, vi } from "vitest";

import { buildKieVideoV1Request, KieVideoV1Adapter, verifyKieVideoWebhook } from "./kie-video-v1";

const textInput = {
	mode: "text-to-video",
	prompt: "A quiet mountain",
	duration: 5,
	sound: false,
	aspectRatio: "16:9",
	callbackUrl: "https://example.com/api/webhooks/video/kie/token",
} as const;
describe("video V1 Kie contract", () => {
	it("serializes fixed text parameters and only one image without aspect_ratio", () => {
		expect(buildKieVideoV1Request(textInput)).toEqual({
			model: "kling-2.6/text-to-video",
			callBackUrl: textInput.callbackUrl,
			input: { prompt: textInput.prompt, duration: "5", sound: false, aspect_ratio: "16:9" },
		});
		expect(
			buildKieVideoV1Request({
				mode: "image-to-video",
				prompt: "Move slowly",
				duration: 5,
				sound: false,
				imageUrl: "https://media.example.com/sealed.png",
				callbackUrl: textInput.callbackUrl,
			}).input,
		).toEqual({
			prompt: "Move slowly",
			duration: "5",
			sound: false,
			image_urls: ["https://media.example.com/sealed.png"],
		});
	});
	it.each([
		{ sound: true },
		{ duration: 10 },
		{ videoUrl: "https://example.com/video.mp4" },
		{ prompt: "a".repeat(1001) },
		{ imageUrl: "https://example.com/image.png" },
	])("rejects unsupported parameters before sending %j", (extra) => {
		expect(() => buildKieVideoV1Request({ ...textInput, ...extra })).toThrow();
	});
	it("does not retry ambiguous submission or send invented idempotency headers", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 503 }));
		const result = await new KieVideoV1Adapter({ apiKey: "test", fetch }).submit(textInput);
		expect(result.status).toBe("UNCERTAIN");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Idempotency-Key")).toBe(false);
	});
	it("requires authoritative query matching task identity", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				code: 200,
				data: {
					taskId: "other",
					state: "success",
					resultJson: JSON.stringify({ resultUrls: ["https://media.example.com/video.mp4"] }),
				},
			}),
		);
		await expect(
			new KieVideoV1Adapter({ apiKey: "test", fetch }).retrieve("task1"),
		).rejects.toThrow("VIDEO_PROVIDER_INVALID_RESPONSE");
		expect(fetch.mock.calls[0]?.[0]).toEqual(
			expect.stringContaining("/api/v1/jobs/recordInfo?taskId=task1"),
		);
	});
	it("verifies only taskId.timestamp and rejects stale/future signatures", async () => {
		const secret = "test-secret";
		const timestamp = "1700000000";
		const taskId = "task1";
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const bytes = new Uint8Array(
			await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${taskId}.${timestamp}`)),
		);
		const signature = btoa(String.fromCharCode(...bytes));
		expect(
			await verifyKieVideoWebhook({ taskId, timestamp, secret, signature, nowSeconds: 1700000000 }),
		).toBe(true);
		expect(
			await verifyKieVideoWebhook({ taskId, timestamp, secret, signature, nowSeconds: 1700000301 }),
		).toBe(false);
		expect(
			await verifyKieVideoWebhook({
				taskId: "other",
				timestamp,
				secret,
				signature,
				nowSeconds: 1700000000,
			}),
		).toBe(false);
	});
});
