import {
	DEFAULT_PRODUCT_CONFIG,
	IMAGE_PRODUCT_SELECTION_CONTRACTS,
	type ImageSkuKey,
	type ProductModelKey,
} from "@repo/config";
import { describe, expect, it, vi } from "vitest";

import { KieProviderAdapter } from "../providers/kie";
import { getCatalogEntry, getPublicProductCatalog, quoteCatalogInput } from "./catalog";
import { configuredRouteGraphOptionsFromEnvironment } from "./routing";

const newModels = [
	[
		"image-gpt-image-2-5-flare",
		"gpt-image-2-5-flare",
		"gpt-image-2-5-flare-image-to-image",
		[7, 11, 17],
	],
	[
		"image-gpt-image-2-5-sunburst",
		"gpt-image-2-5-sunburst",
		"gpt-image-2-5-sunburst-image-to-image",
		[7, 11, 17],
	],
	["image-seedream-4", "seedream-4", "bytedance/seedream-v4-edit", [6, 8, 10]],
] as const;
const sourceAsset = {
	assetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
	transferUrl: "https://transfer.test/source.png",
};
const imageInput = (skuKey: string, aspectRatio = "16:9") => ({
	kind: "image-to-image",
	prompt: "Keep the subject and replace its background",
	sourceAssetId: sourceAsset.assetId,
	skuKey,
	aspectRatio,
});

describe("expanded image model catalog", () => {
	it("lists twelve real image products with three model families and no provider data", () => {
		const catalog = getPublicProductCatalog({
			generationEnabled: true,
			enabledProviders: new Set(["kie"]),
			kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
		});
		expect(catalog.products).toHaveLength(12);
		for (const [key] of newModels)
			expect(catalog.products.some((product) => product.key === key)).toBe(true);
		expect(JSON.stringify(catalog)).not.toMatch(
			/providerModelId|providerCostMicros|bytedance|apiKey/,
		);
	});

	for (const [productKey, skuPrefix, model, credits] of newModels) {
		it.each(["1k", "2k", "4k"] as const)(
			`${productKey} quotes and submits its documented %s output`,
			async (resolution) => {
				const skuKey = `${skuPrefix}-${resolution}` as ImageSkuKey;
				expect(quoteCatalogInput({ productKey, input: imageInput(skuKey) }).credits).toBe(
					credits[["1k", "2k", "4k"].indexOf(resolution)],
				);
				const entry = getCatalogEntry(productKey as ProductModelKey);
				const cell = entry.imageSpecMatrix!.cells.find((candidate) => candidate.skuKey === skuKey)!;
				expect(cell.routes).toEqual([
					{
						provider: "kie",
						providerModelId: model,
						providerCostMicros:
							productKey === "image-seedream-4"
								? 25_000
								: { "1k": 30_000, "2k": 50_000, "4k": 80_000 }[resolution],
						weight: 100,
					},
				]);
				const fetch = vi.fn<typeof globalThis.fetch>(
					async () =>
						new Response(JSON.stringify({ code: 200, data: { taskId: "new-model-task" } }), {
							headers: { "content-type": "application/json" },
						}),
				);
				const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
				await adapter.submit({
					attemptId: "attempt-new-model",
					providerModelId: model,
					input: {
						kind: "image-to-image",
						prompt: "Restyle this image",
						sourceAsset,
						skuKey,
						aspectRatio: "16:9",
					},
				});
				const requestBody = fetch.mock.calls[0]?.[1]?.body;
				expect(typeof requestBody).toBe("string");
				const body = JSON.parse(requestBody as string);
				expect(body).toEqual({
					model,
					input:
						productKey === "image-seedream-4"
							? {
									image_urls: [sourceAsset.transferUrl],
									prompt: "Restyle this image",
									image_size: "landscape_16_9",
									image_resolution: resolution.toUpperCase(),
									max_images: 1,
									nsfw_checker: true,
								}
							: {
									input_urls: [sourceAsset.transferUrl],
									prompt: "Restyle this image",
									aspect_ratio: "16:9",
									resolution: resolution.toUpperCase(),
									background: "opaque",
								},
				});
			},
		);
	}

	it("limits the extra GPT 2.5 aspect ratios to 1K and keeps selection recovery aligned", () => {
		for (const [productKey, skuPrefix] of newModels.slice(0, 2)) {
			for (const ratio of ["27:16", "16:27", "9:8", "8:9"]) {
				expect(() =>
					quoteCatalogInput({ productKey, input: imageInput(`${skuPrefix}-1k`, ratio) }),
				).not.toThrow();
				for (const resolution of ["2k", "4k"])
					expect(() =>
						quoteCatalogInput({
							productKey,
							input: imageInput(`${skuPrefix}-${resolution}`, ratio),
						}),
					).toThrow(/aspect ratio/i);
			}
			const entry = getCatalogEntry(productKey as ProductModelKey);
			const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS[productKey];
			expect(contract.defaultSkuKey).toBe(entry.imageSpecMatrix!.defaultSkuKey);
			for (const cell of contract.cells)
				expect(cell.aspectRatios).toEqual(
					entry.imageSpecMatrix!.cells.find((candidate) => candidate.skuKey === cell.skuKey)!
						.aspectRatios,
				);
		}
	});

	it("rejects unsupported Seedream 4 input before quoting or sending a provider request", async () => {
		expect(() =>
			quoteCatalogInput({
				productKey: "image-seedream-4",
				input: { ...imageInput("seedream-4-1k"), prompt: "x".repeat(5001) },
			}),
		).toThrow();
		const fetch = vi.fn();
		const adapter = new KieProviderAdapter({ apiKey: "test-key", fetch });
		await expect(
			adapter.submit({
				attemptId: "bad-ratio",
				providerModelId: "bytedance/seedream-v4-edit",
				input: {
					kind: "image-to-image",
					prompt: "Restyle",
					sourceAsset,
					skuKey: "seedream-4-1k" as ImageSkuKey,
					aspectRatio: "auto",
				},
			}),
		).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("requires each new model's own production enablement flag", () => {
		const environment = {
			NODE_ENV: "production",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		};
		const closed = getPublicProductCatalog(configuredRouteGraphOptionsFromEnvironment(environment));
		for (const [key] of newModels)
			expect(closed.products.some((product) => product.key === key)).toBe(false);
		const enabled = getPublicProductCatalog(
			configuredRouteGraphOptionsFromEnvironment({
				...environment,
				MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true",
				MEDIA_GPT_IMAGE_2_5_SUNBURST_ENABLED: "true",
				MEDIA_SEEDREAM_4_ENABLED: "true",
			}),
		);
		expect(enabled.products.map((product) => product.key).sort()).toEqual(
			newModels.map(([key]) => key).sort(),
		);
	});
});
