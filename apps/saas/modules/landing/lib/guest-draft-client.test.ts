import { describe, expect, it, vi } from "vitest";

import {
	completeGuestDraftUpload,
	createGuestDraftUploadIntent,
	getGuestCapability,
} from "./guest-draft-client";

describe("same-origin landing guest client", () => {
	it("loads public capability from the SaaS origin", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [nanoProduct(), gptProduct()],
				queueEstimate: { kind: "capacity" },
			}),
		);

		const result = await getGuestCapability(fetcher as typeof fetch);

		expect(result.products.map((product) => product.key)).toEqual([
			"image-nano-banana-2-lite",
			"image-gpt-image-2",
		]);
		expect(result.products[0]?.aspectRatios).toContain("16:9");
		expect(result.products[1]?.skuMatrix.cells[0]?.controls).toEqual([
			expect.objectContaining({ key: "background", defaultValue: "opaque" }),
		]);
		expect(JSON.stringify(result)).not.toMatch(/provider|modelId|costMicros|weight/i);
		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/guest-capability",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("rejects malformed or sensitive fields inside public cell controls", async () => {
		const product = nanoBananaProduct();
		const cell = product.skuMatrix.cells[0]!;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [
					{
						...product,
						skuMatrix: {
							...product.skuMatrix,
							cells: [
								{
									...cell,
									controls: [
										{
											...cell.controls[0],
											providerModelId: "private-model-id",
										},
									],
								},
							],
						},
					},
				],
				queueEstimate: { kind: "capacity" },
			}),
		);

		await expect(getGuestCapability(fetcher as typeof fetch)).rejects.toThrow(
			"GUEST_CAPABILITY_INVALID",
		);

		const invalidDefaultFetcher = vi.fn(async () =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [
					{
						...product,
						skuMatrix: {
							...product.skuMatrix,
							cells: [
								{
									...cell,
									controls: [{ ...cell.controls[0], defaultValue: "webp" }],
								},
							],
						},
					},
				],
				queueEstimate: { kind: "capacity" },
			}),
		);
		await expect(getGuestCapability(invalidDefaultFetcher as typeof fetch)).rejects.toThrow(
			"GUEST_CAPABILITY_INVALID",
		);
	});

	it("rejects non-canonical credit values in the public capability", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [{ ...nanoProduct(), credits: 5 }],
				queueEstimate: { kind: "capacity" },
			}),
		);

		await expect(getGuestCapability(fetcher as typeof fetch)).rejects.toThrow(
			"GUEST_CAPABILITY_INVALID",
		);
	});

	it("accepts a newly configured product and its own fixed-output SKU matrix", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				version: "capability-v1",
				enabled: true,
				reason: null,
				upload: {
					mimeTypes: ["image/jpeg", "image/png", "image/webp"],
					maximumBytes: 10 * 1024 * 1024,
				},
				products: [nanoBananaProduct()],
				queueEstimate: { kind: "capacity" },
			}),
		);

		const result = await getGuestCapability(fetcher as typeof fetch);

		expect(result.products[0]).toMatchObject({
			key: "image-nano-banana",
			credits: "5",
			skuMatrix: {
				defaultSkuKey: "nano-banana-default",
				dimensions: [],
			},
		});
	});

	it("creates private upload intents without a second application origin", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				sessionId: "session-1",
				assetId: "asset-1",
				uploadUrl: "https://storage.example.com/private-upload",
				completionToken: "c".repeat(43),
				expiresAt: "2026-09-01T00:00:00.000Z",
			}),
		);

		await createGuestDraftUploadIntent(
			{
				capabilityVersion: "capability-v1",
				productKey: "image-gpt-image-2",
				contentType: "image/png",
				bytes: 128,
				sha256: "a".repeat(64),
				turnstileToken: "local-token",
			},
			fetcher as typeof fetch,
		);

		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/guest-drafts/upload-intents",
			expect.objectContaining({ credentials: "same-origin", method: "POST" }),
		);
		const requestBody = fetcher.mock.calls[0]?.[1]?.body;
		expect(typeof requestBody).toBe("string");
		expect(JSON.parse(requestBody as string)).toMatchObject({
			productKey: "image-gpt-image-2",
		});
	});

	it("keeps the server-authorized paid product and SKU in the account handoff", async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({
				status: "READY",
				claimToken: "c".repeat(43),
				continueUrl: "/draft/continue",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				accessHint: "paid-account",
			}),
		);

		const result = await completeGuestDraftUpload(
			{
				sessionId: "session-1",
				completionToken: "d".repeat(43),
				capabilityVersion: "capability-v1",
				productKey: "image-gpt-image-2",
				skuKey: "gpt-image-2-1k",
				sha256: "a".repeat(64),
				prompt: "Preserve the product details",
				aspectRatio: "16:9",
				background: "transparent",
			},
			{ fetcher: fetcher as typeof fetch },
		);

		expect(result).toEqual({
			action: "/draft/continue",
			claimToken: "c".repeat(43),
			productKey: "image-gpt-image-2",
			skuKey: "gpt-image-2-1k",
			accessHint: "paid-account",
		});
		const requestBody = fetcher.mock.calls[0]?.[1]?.body;
		expect(typeof requestBody).toBe("string");
		expect(JSON.parse(requestBody as string)).toMatchObject({
			skuKey: "gpt-image-2-1k",
			background: "transparent",
		});
	});
});

function nanoProduct() {
	return {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Everyday private edits",
		credits: "5",
		accessHint: "guest-trial",
		aspectRatios: ["auto", "1:1", "16:9"],
		skuMatrix: {
			defaultSkuKey: "nano-banana-2-lite-1k",
			dimensions: [
				{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] },
			],
			cells: [
				{
					skuKey: "nano-banana-2-lite-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 5,
					aspectRatios: ["auto", "1:1", "16:9"],
					controls: [],
				},
			],
		},
	};
}

function gptProduct() {
	return {
		key: "image-gpt-image-2",
		label: "GPT Image 2",
		description: "Detailed private edits",
		credits: "7",
		accessHint: "paid-account",
		aspectRatios: ["auto", "1:1", "16:9"],
		skuMatrix: {
			defaultSkuKey: "gpt-image-2-1k",
			dimensions: [
				{
					key: "resolution",
					label: "Resolution",
					options: [
						{ key: "1k", label: "1K" },
						{ key: "2k", label: "2K" },
						{ key: "4k", label: "4K" },
					],
				},
			],
			cells: [
				{
					skuKey: "gpt-image-2-1k",
					label: "1K",
					parameterValues: { resolution: "1k" },
					credits: 7,
					aspectRatios: ["auto", "1:1", "16:9"],
					controls: [
						{
							key: "background",
							label: "Background",
							defaultValue: "opaque",
							options: [
								{ key: "auto", label: "Automatic" },
								{ key: "opaque", label: "Opaque" },
								{ key: "transparent", label: "Transparent" },
							],
						},
					],
				},
				{
					skuKey: "gpt-image-2-2k",
					label: "2K",
					parameterValues: { resolution: "2k" },
					credits: 11,
					aspectRatios: ["1:1", "16:9"],
					controls: [],
				},
				{
					skuKey: "gpt-image-2-4k",
					label: "4K",
					parameterValues: { resolution: "4k" },
					credits: 17,
					aspectRatios: ["16:9"],
					controls: [],
				},
			],
		},
	};
}

function nanoBananaProduct() {
	return {
		key: "image-nano-banana",
		label: "Nano Banana",
		description: "Focused fixed-output image editing",
		credits: "5",
		accessHint: "paid-account",
		aspectRatios: ["auto", "1:1", "16:9"],
		skuMatrix: {
			defaultSkuKey: "nano-banana-default",
			dimensions: [],
			cells: [
				{
					skuKey: "nano-banana-default",
					label: "Default",
					parameterValues: {},
					credits: 5,
					aspectRatios: ["auto", "1:1", "16:9"],
					controls: [
						{
							key: "outputFormat",
							label: "Output format",
							defaultValue: "png",
							options: [
								{ key: "png", label: "PNG" },
								{ key: "jpeg", label: "JPEG" },
							],
						},
					],
				},
			],
		},
	};
}
