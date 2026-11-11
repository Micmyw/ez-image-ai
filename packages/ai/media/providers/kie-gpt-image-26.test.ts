import { describe, expect, it, vi } from "vitest";

import { staticDispatchRouteFor } from "../catalog/dispatch-manifest";
import type { ProviderSubmitInput } from "../types";
import { KieProviderAdapter } from "./kie";

const callbackUrl = "https://app.test/api/webhooks/ai/kie?token=server-signed";
const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/private-reference.png",
};

function request(
	variant: "flare" | "sunburst" = "flare",
	kind: "text-to-image" | "image-to-image" = "text-to-image",
	properties: Record<string, unknown> = {},
): ProviderSubmitInput {
	return {
		attemptId: "gpt-26-existing-attempt",
		providerModelId: `gpt-image-2-6/${variant}-${kind}`,
		webhookUrl: callbackUrl,
		input: {
			kind,
			prompt: "A paper boat sailing in a gentle looping motion",
			skuKey: `gpt-image-2-6-${variant}-1k`,
			aspectRatio: "1:1",
			...(kind === "image-to-image" ? { sourceAsset } : {}),
			...properties,
		},
	} as ProviderSubmitInput;
}

function adapterFixture(response = { code: 200, data: { taskId: "gpt-26-task" } }) {
	const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response));
	return { fetch, adapter: new KieProviderAdapter({ apiKey: "test-key", fetch }) };
}

// Expectations derive from the Kie schemas verified 2026-11-11, including the
// deliberate application limits documented in the provider evidence note.
describe("GPT Image 2.6 Kie request contracts", () => {
	for (const variant of ["flare", "sunburst"] as const) {
		for (const kind of ["text-to-image", "image-to-image"] as const) {
			it.each(["png", "jpeg", "gif", "svg"] as const)(
				`${variant} ${kind} sends the exact %s schema`,
				async (format) => {
					const { adapter, fetch } = adapterFixture();
					const input = request(variant, kind, { outputFormat: format });
					const submitted = await adapter.submit(input);
					expect(fetch).toHaveBeenCalledTimes(1);
					expect(fetch.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
					expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
						model: `gpt-image-2-6/${variant}-${kind}`,
						callBackUrl: callbackUrl,
						input: {
							prompt:
								format === "svg"
									? `${input.input.prompt}\n\nCreate a static, self-contained SVG using vector shapes and paths. Convert all lettering to outline paths; do not use text or tspan elements, embedded images, external resources, scripts, animation, or stylesheets.`
									: input.input.prompt,
							quality: variant === "flare" ? "medium" : "high",
							complexity: "high",
							moderation: "auto",
							background: "opaque",
							output_format: format,
							...(kind === "image-to-image" ? { input_urls: [sourceAsset.transferUrl] } : {}),
							...(format === "gif"
								? {
										frame_count: 9,
										frame_duration_ms: 200,
										...(kind === "text-to-image" ? { size: "512x512" } : {}),
									}
								: { aspect_ratio: "1:1", resolution: "1K" }),
							...(format === "svg" ? { svg: { model: "gpt-5.6-luna" } } : {}),
						},
					});
					expect(submitted).toMatchObject({
						outcome: "accepted",
						providerTaskId: "gpt-26-task",
						idempotency: { providerSupported: false, replayed: false },
						reconciliation: {
							submissionToken: "gpt-26-existing-attempt",
							statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=gpt-26-task",
						},
					});
					expect(staticDispatchRouteFor("image", "kie", input.providerModelId)).toBeDefined();
				},
			);
		}
	}

	it.each([
		["flare", "2k", "2K", "medium"],
		["flare", "4k", "4K", "medium"],
		["sunburst", "2k", "2K", "high"],
		["sunburst", "4k", "4K", "high"],
	] as const)(
		"%s %s retains its fixed quality and resolution",
		async (variant, skuSize, resolution, quality) => {
			const { adapter, fetch } = adapterFixture();
			await adapter.submit(
				request(variant, "text-to-image", {
					skuKey: `gpt-image-2-6-${variant}-${skuSize}`,
					aspectRatio: "9:21",
				}),
			);
			expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input).toEqual({
				prompt: "A paper boat sailing in a gentle looping motion",
				aspect_ratio: "9:21",
				resolution,
				quality,
				complexity: "high",
				moderation: "auto",
				output_format: "png",
			});
		},
	);

	it.each([
		[2, 20],
		[16, 2000],
	] as const)("sends exact GIF boundary settings %i / %i", async (frameCount, frameDurationMs) => {
		const { adapter, fetch } = adapterFixture();
		await adapter.submit(
			request("sunburst", "image-to-image", { outputFormat: "gif", frameCount, frameDurationMs }),
		);
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input).toMatchObject({
			frame_count: frameCount,
			frame_duration_ms: frameDurationMs,
		});
	});

	it("keeps PNG transparency without adding a legacy prompt suffix", async () => {
		const { adapter, fetch } = adapterFixture();
		await adapter.submit(
			request("sunburst", "image-to-image", { outputFormat: "png", background: "transparent" }),
		);
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input).toMatchObject({
			prompt: "A paper boat sailing in a gentle looping motion",
			background: "transparent",
		});
	});

	it.each([
		["unknown SKU", { skuKey: "gpt-image-2-6-flare-8k" }],
		["another variant's SKU", { skuKey: "gpt-image-2-6-sunburst-1k" }],
		["unknown format", { outputFormat: "html" }],
		["unoffered WebP", { outputFormat: "webp" }],
		["HD SVG", { skuKey: "gpt-image-2-6-flare-2k", outputFormat: "svg" }],
		["HD GIF", { skuKey: "gpt-image-2-6-flare-4k", outputFormat: "gif" }],
		["rectangular GIF", { outputFormat: "gif", aspectRatio: "16:9" }],
		["one frame", { outputFormat: "gif", frameCount: 1 }],
		["64 frames from Economy", { outputFormat: "gif", frameCount: 64 }],
		["fractional frames", { outputFormat: "gif", frameCount: 9.5 }],
		["string frame count", { outputFormat: "gif", frameCount: "9" }],
		["too-short frame duration", { outputFormat: "gif", frameDurationMs: 10 }],
		["too-long frame duration", { outputFormat: "gif", frameDurationMs: 2010 }],
		["unrounded frame duration", { outputFormat: "gif", frameDurationMs: 205 }],
		["GIF fields on PNG", { outputFormat: "png", frameCount: 9 }],
		["GIF fields on SVG", { outputFormat: "svg", frameDurationMs: 200 }],
		["transparent JPEG", { outputFormat: "jpeg", background: "transparent" }],
		["transparent SVG", { outputFormat: "svg", background: "transparent" }],
		["transparent GIF", { outputFormat: "gif", background: "transparent" }],
		["excess prompt", { prompt: "a".repeat(4001) }],
		["unknown aspect ratio", { aspectRatio: "27:16" }],
	] as const)("rejects %s before contacting Kie", async (_label, properties) => {
		const { adapter, fetch } = adapterFixture();
		await expect(
			adapter.submit(request("flare", "text-to-image", properties)),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects an unverified model ID before contacting Kie", async () => {
		const { adapter, fetch } = adapterFixture();
		await expect(
			adapter.submit({ ...request(), providerModelId: "gpt-image-2.6-flare" }),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("GPT Image 2.6 uses existing Kie uncertainty and result contracts", () => {
	it.each([429, 500, 503])("does not retry ambiguous HTTP %i", async (status) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ message: "Temporarily unavailable" }, { status }),
		);
		const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
		expect(await adapter.submit(request())).toMatchObject({
			outcome: "uncertain",
			uncertainty: { classification: "ambiguous_http", phase: "post_send", statusCode: status },
			failure: { retryable: false },
			reconciliation: { submissionToken: "gpt-26-existing-attempt" },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not reinterpret a Kie error envelope as a task", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 422, msg: "Invalid frame count", data: null }),
		);
		const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
		expect(await adapter.submit(request())).toMatchObject({
			outcome: "rejected",
			failure: { retryable: false },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("propagates transport uncertainty without issuing a second paid request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError("Connection reset after send");
		});
		const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
		await expect(adapter.submit(request())).rejects.toMatchObject({ code: "HTTP_ERROR" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["gif", "svg"])(
		"retains actual Kie consumption and untrusted %s URLs for private transfer",
		async (format) => {
			const outputUrl = `https://provider.test/result.${format}`;
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({
					code: 200,
					data: {
						taskId: "gpt-26-task",
						model: "gpt-image-2-6/flare-text-to-image",
						state: "success",
						creditsConsumed: 12.5,
						resultJson: JSON.stringify({ resultUrls: [outputUrl] }),
					},
				}),
			);
			const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
			const snapshot = await adapter.retrieve({
				providerTaskId: "gpt-26-task",
				statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=gpt-26-task",
			});
			expect(snapshot.retrieval?.source).toBe("kie-record-info");
			expect(await adapter.normalizeResult(snapshot)).toMatchObject({
				providerCostMicros: 62_500,
				providerCharged: true,
				outputs: [{ kind: "remote-url", url: outputUrl, trust: "untrusted-transfer-candidate" }],
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
