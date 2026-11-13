import { readFileSync } from "node:fs";

import { IMAGE_PRODUCT_SELECTION_CONTRACTS } from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { staticDispatchRouteFor } from "../catalog/dispatch-manifest";
import type { ProviderSubmitInput } from "../types";
import { KieProviderAdapter } from "./kie";

const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/private-reference.png",
	width: 1024,
	height: 1024,
};
const callbackUrl = "https://app.test/api/webhooks/ai/kie?token=server-signed";
const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/kie-minimax-h3-image-contracts-2026-11-13.json", import.meta.url),
		"utf8",
	),
) as {
	contracts: Array<{
		model: string;
		requestSchema: {
			properties: {
				input: {
					required: string[];
					properties: Record<
						string,
						{ enum?: string[]; maxLength?: number; maxItems?: number; default?: unknown }
					>;
				};
			};
		};
	}>;
};

function request(
	kind: "text-to-image" | "image-to-image",
	size = "1k",
	overrides: Record<string, unknown> = {},
): ProviderSubmitInput {
	return {
		attemptId: "h3-attempt",
		providerModelId:
			kind === "text-to-image" ? "minimax-h3/text-to-image" : "minimax-h3/image-edit",
		webhookUrl: callbackUrl,
		input: {
			kind,
			prompt: "A cozy bookstore cafe on a rainy evening",
			skuKey: `minimax-h3-${size}`,
			aspectRatio: "auto",
			...(kind === "image-to-image" ? { sourceAsset } : {}),
			...overrides,
		},
	} as ProviderSubmitInput;
}

describe("MiniMax H3 Image Kie contracts", () => {
	for (const kind of ["text-to-image", "image-to-image"] as const) {
		it.each(["1k", "2k", "4k"] as const)(
			`${kind} submits the documented %s fields once`,
			async (size) => {
				const fetch = vi.fn<typeof globalThis.fetch>(async () =>
					Response.json({ code: 200, data: { taskId: "h3-task" } }),
				);
				const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
				const input = request(kind, size);
				const submission = await adapter.submit(input);
				expect(fetch).toHaveBeenCalledTimes(1);
				expect(fetch.mock.calls[0]![0]).toBe("https://api.kie.ai/api/v1/jobs/createTask");
				const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
				expect(body).toEqual({
					model: kind === "text-to-image" ? "minimax-h3/text-to-image" : "minimax-h3/image-edit",
					callBackUrl: callbackUrl,
					input: {
						prompt: "A cozy bookstore cafe on a rainy evening",
						aspect_ratio: "auto",
						resolution: size.toUpperCase(),
						expand_prompt: true,
						output_format: size === "4k" ? "jpeg" : "png",
						...(kind === "image-to-image" ? { image_urls: [sourceAsset.transferUrl] } : {}),
					},
				});
				const schema = fixture.contracts.find((contract) => contract.model === body.model)!
					.requestSchema.properties.input;
				for (const field of Object.keys(body.input))
					expect(schema.properties).toHaveProperty(field);
				for (const field of schema.required) expect(body.input).toHaveProperty(field);
				for (const [field, value] of Object.entries(body.input)) {
					const allowed = schema.properties[field]?.enum;
					if (allowed) expect(allowed).toContain(value);
				}
				expect(submission).toMatchObject({
					outcome: "accepted",
					providerTaskId: "h3-task",
					idempotency: { providerSupported: false, replayed: false },
					reconciliation: {
						submissionToken: "h3-attempt",
						statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=h3-task",
					},
				});
				expect(staticDispatchRouteFor("image", "kie", input.providerModelId)).toBeDefined();
			},
		);

		it.each(["png", "jpeg"] as const)(
			`${kind} sends an explicit %s format at 4K`,
			async (outputFormat) => {
				const fetch = vi.fn<typeof globalThis.fetch>(async () =>
					Response.json({ code: 200, data: { taskId: "h3-task" } }),
				);
				await new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(
					request(kind, "4k", { outputFormat }),
				);
				expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input.output_format).toBe(
					outputFormat,
				);
			},
		);
	}

	it("keeps its public input choices inside both retrieved schemas", () => {
		const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS["image-minimax-h3"];
		expect(contract.maximumInputBytes).toBe(20_000_000);
		expect(contract.maximumInputPixels).toBe(64_000_000);
		for (const source of fixture.contracts) {
			const properties = source.requestSchema.properties.input.properties;
			expect(contract.maximumPromptLength).toBe(properties.prompt!.maxLength);
			for (const cell of contract.cells) {
				expect(cell.aspectRatios).toEqual(properties.aspect_ratio!.enum);
				expect(cell.controls[0]!.options).toEqual(properties.output_format!.enum);
			}
		}
		expect(
			fixture.contracts[0]!.requestSchema.properties.input.properties.image_urls!.maxItems,
		).toBe(16);
	});

	it.each([
		{ aspectRatio: "1:8" },
		{ skuKey: "nano-banana-2-lite-1k" },
		{ outputFormat: "gif" },
		{ outputFormat: "svg" },
		{ background: "transparent" },
		{ frameCount: 9 },
		{ prompt: "x".repeat(5001) },
	])("rejects unsupported options before provider work: %j", async (overrides) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(
				request("text-to-image", "1k", overrides),
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not retry an uncertain submission", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError("Connection reset after send");
		});
		await expect(
			new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(request("text-to-image")),
		).rejects.toMatchObject({ code: "HTTP_ERROR" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("accepts an inspected reference at the 64 megapixel boundary", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 200, data: { taskId: "h3-task" } }),
		);
		await new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(
			request("image-to-image", "1k", {
				sourceAsset: { ...sourceAsset, width: 8000, height: 8000 },
			}),
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		{ width: 8000, height: 8001 },
		{ width: undefined, height: undefined },
		{ width: null, height: 1024 },
		{ width: 1024, height: 0 },
		{ width: -1, height: 1024 },
		{ width: Number.NaN, height: 1024 },
		{ width: 1024.5, height: 1024 },
		{ width: 1024, height: Number.POSITIVE_INFINITY },
	])("rejects an oversized or uninspected H3 reference before send: %j", async (dimensions) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			new KieProviderAdapter({ apiKey: "test-key", fetch }).submit(
				request("image-to-image", "1k", { sourceAsset: { ...sourceAsset, ...dimensions } }),
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", retryable: false });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("retains historical Nano Banana submissions without inspection dimensions", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ code: 200, data: { taskId: "historical-task" } }),
		);
		await new KieProviderAdapter({ apiKey: "test-key", fetch }).submit({
			...request("image-to-image"),
			providerModelId: "nano-banana-2-lite",
			input: {
				kind: "image-to-image",
				prompt: "Keep the subject",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
				sourceAsset: { assetId: sourceAsset.assetId, transferUrl: sourceAsset.transferUrl },
			},
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		[1.8, 9_000],
		[2.3, 11_500],
		[5.5, 27_500],
		[6, 30_000],
	])(
		"retains actual %s Kie credits separately from retail credits",
		async (creditsConsumed, providerCostMicros) => {
			const fetch = vi.fn<typeof globalThis.fetch>(async () =>
				Response.json({
					code: 200,
					data: {
						taskId: "h3-task",
						state: "success",
						model: "minimax-h3/image-edit",
						creditsConsumed,
						resultJson: JSON.stringify({ resultUrls: ["https://provider.test/result.jpeg"] }),
					},
				}),
			);
			const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
			const task = await adapter.retrieve({
				providerTaskId: "h3-task",
				statusUrl: "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=h3-task",
			});
			expect(await adapter.normalizeResult(task)).toMatchObject({
				providerCostMicros,
				providerCharged: true,
			});
		},
	);
});
