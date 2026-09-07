import { IMAGE_PRODUCT_SELECTION_CONTRACTS, type EzPicProductKey } from "@repo/config";
import { describe, expect, it } from "vitest";

import {
	getCatalogEntry,
	getPublicProductCatalog,
	isCatalogInputSupported,
	quoteCatalogInput,
} from "./catalog";
import {
	GPT_IMAGE_1_5_MATRIX,
	GPT_IMAGE_2_MATRIX,
	type ImageSpecMatrix,
	NANO_BANANA_2_LITE_MATRIX,
	NANO_BANANA_2_MATRIX,
	NANO_BANANA_MATRIX,
	NANO_BANANA_PRO_MATRIX,
	SEEDREAM_4_5_MATRIX,
	SEEDREAM_5_LITE_MATRIX,
	SEEDREAM_5_PRO_MATRIX,
} from "./image-spec-matrices";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

const expectedSkus = [
	["image-nano-banana-2-lite", "nano-banana-2-lite-1k", 5],
	["image-nano-banana", "nano-banana-default", 5],
	["image-nano-banana-2", "nano-banana-2-1k", 9],
	["image-nano-banana-2", "nano-banana-2-2k", 13],
	["image-nano-banana-2", "nano-banana-2-4k", 19],
	["image-nano-banana-pro", "nano-banana-pro-1k", 19],
	["image-nano-banana-pro", "nano-banana-pro-2k", 19],
	["image-nano-banana-pro", "nano-banana-pro-4k", 25],
	["image-gpt-image-1-5", "gpt-image-1-5-medium", 5, "1:1"],
	["image-gpt-image-1-5", "gpt-image-1-5-high", 23, "1:1"],
	["image-gpt-image-2", "gpt-image-2-1k", 7],
	["image-gpt-image-2", "gpt-image-2-2k", 11],
	["image-gpt-image-2", "gpt-image-2-4k", 17],
	["image-seedream-4-5", "seedream-4-5-basic-2k", 8],
	["image-seedream-4-5", "seedream-4-5-high-4k", 8],
	["image-seedream-5-lite", "seedream-5-lite-basic-2k", 7],
	["image-seedream-5-lite", "seedream-5-lite-high-3k", 7],
	["image-seedream-5-lite", "seedream-5-lite-ultra-4k", 7],
	["image-seedream-5-pro", "seedream-5-pro-basic-1k", 8],
	["image-seedream-5-pro", "seedream-5-pro-high-2k", 15],
] as const;

const matricesByProduct: Record<EzPicProductKey, ImageSpecMatrix> = {
	"image-nano-banana-2-lite": NANO_BANANA_2_LITE_MATRIX,
	"image-nano-banana": NANO_BANANA_MATRIX,
	"image-nano-banana-2": NANO_BANANA_2_MATRIX,
	"image-nano-banana-pro": NANO_BANANA_PRO_MATRIX,
	"image-gpt-image-1-5": GPT_IMAGE_1_5_MATRIX,
	"image-gpt-image-2": GPT_IMAGE_2_MATRIX,
	"image-seedream-4-5": SEEDREAM_4_5_MATRIX,
	"image-seedream-5-lite": SEEDREAM_5_LITE_MATRIX,
	"image-seedream-5-pro": SEEDREAM_5_PRO_MATRIX,
};

function imageInput(skuKey: string, aspectRatio = "16:9") {
	return {
		kind: "image-to-image" as const,
		prompt: "Preserve the subject and replace the background",
		sourceAssetId: SOURCE_ASSET_ID,
		skuKey,
		aspectRatio,
	};
}

describe("Kie image SKU catalog", () => {
	it("keeps the server matrix aligned with the browser-safe product contract", () => {
		for (const productKey of Object.keys(IMAGE_PRODUCT_SELECTION_CONTRACTS) as EzPicProductKey[]) {
			const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS[productKey];
			const matrix = matricesByProduct[productKey];

			expect(matrix.defaultSkuKey, productKey).toBe(contract.defaultSkuKey);
			expect(
				matrix.cells.map((cell) => ({
					skuKey: cell.skuKey,
					aspectRatios: cell.aspectRatios,
					controls: (cell.controls ?? []).map((control) => ({
						key: control.key,
						defaultValue: control.defaultValue,
						options: control.options.map((option) => option.key),
					})),
				})),
				productKey,
			).toEqual(contract.cells);
		}
	});

	it("derives every SKU credit price from its Kie route cost", () => {
		for (const [productKey, matrix] of Object.entries(matricesByProduct)) {
			for (const cell of matrix.cells) {
				expect(cell.routes, `${productKey}/${cell.skuKey}`).toHaveLength(1);
				const route = cell.routes[0]!;
				expect(route.provider, `${productKey}/${cell.skuKey}`).toBe("kie");
				expect(cell.credits, `${productKey}/${cell.skuKey}`).toBe(
					Math.ceil(route.providerCostMicros / 5_000) + 1,
				);
			}
		}
	});

	it("quotes each model-owned SKU with exact EzPic credits", () => {
		for (const [productKey, skuKey, credits, aspectRatio] of expectedSkus) {
			expect(
				quoteCatalogInput({ productKey, input: imageInput(skuKey, aspectRatio) }),
			).toMatchObject({
				productKey,
				skuKey,
				credits,
				catalogVersion: "2026-09-07.2",
				pricingVersion: "2026-09-07.2",
			});
		}
	});

	it("rejects legacy strength from every current Kie SKU quote", () => {
		for (const [productKey, skuKey, , aspectRatio] of expectedSkus) {
			expect(() =>
				quoteCatalogInput({
					productKey,
					input: {
						...imageInput(skuKey, aspectRatio),
						strength: 0.42,
					},
				}),
			).toThrow(/strength/i);
		}
	});

	it("keeps legacy matrixless image records with strength parseable", () => {
		expect(
			isCatalogInputSupported(getCatalogEntry("image-fast"), {
				kind: "image-to-image",
				prompt: "Preserve a historical edit snapshot",
				sourceAssetId: SOURCE_ASSET_ID,
				strength: 0.42,
			}),
		).toBe(true);
	});

	it("rejects a SKU borrowed from another model", () => {
		expect(() =>
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: imageInput("seedream-5-pro-high-2k"),
			}),
		).toThrow(/SKU|sku/i);
	});

	it("enforces the aspect-ratio allowlist of the selected SKU", () => {
		expect(() =>
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: imageInput("gpt-image-2-4k", "1:1"),
			}),
		).toThrow(/aspect ratio/i);
		expect(() =>
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: imageInput("gpt-image-2-2k", "auto"),
			}),
		).toThrow(/aspect ratio/i);
	});

	it("matches Kie's resolution-specific GPT Image 2 ratio contract", () => {
		for (const aspectRatio of ["auto", "1:1", "5:4", "4:5", "3:1", "1:3", "9:21"] as const) {
			expect(() =>
				quoteCatalogInput({
					productKey: "image-gpt-image-2",
					input: imageInput("gpt-image-2-1k", aspectRatio),
				}),
			).not.toThrow();
		}
		for (const aspectRatio of ["4:5", "5:4", "3:1", "1:3", "9:21"] as const) {
			expect(() =>
				quoteCatalogInput({
					productKey: "image-gpt-image-2",
					input: imageInput("gpt-image-2-2k", aspectRatio),
				}),
			).toThrow(/aspect ratio/i);
		}

		for (const aspectRatio of ["4:5", "5:4"] as const) {
			expect(() =>
				quoteCatalogInput({
					productKey: "image-gpt-image-2",
					input: imageInput("gpt-image-2-4k", aspectRatio),
				}),
			).not.toThrow();
		}
		for (const aspectRatio of ["3:1", "1:3", "9:21"] as const) {
			expect(() =>
				quoteCatalogInput({
					productKey: "image-gpt-image-2",
					input: imageInput("gpt-image-2-4k", aspectRatio),
				}),
			).toThrow(/aspect ratio/i);
		}
	});

	it("keeps every model's aspect-ratio allowlist independently owned", () => {
		const modelRatios = [
			NANO_BANANA_2_LITE_MATRIX.cells[0]!.aspectRatios,
			NANO_BANANA_MATRIX.cells[0]!.aspectRatios,
			NANO_BANANA_2_MATRIX.cells[0]!.aspectRatios,
			NANO_BANANA_PRO_MATRIX.cells[0]!.aspectRatios,
			GPT_IMAGE_1_5_MATRIX.cells[0]!.aspectRatios,
			GPT_IMAGE_2_MATRIX.cells[0]!.aspectRatios,
			SEEDREAM_4_5_MATRIX.cells[0]!.aspectRatios,
			SEEDREAM_5_LITE_MATRIX.cells[0]!.aspectRatios,
			SEEDREAM_5_PRO_MATRIX.cells[0]!.aspectRatios,
		];

		expect(new Set(modelRatios)).toHaveLength(9);
		expect(modelRatios).toEqual([
			[
				"auto",
				"1:1",
				"1:4",
				"1:8",
				"2:3",
				"3:2",
				"3:4",
				"4:1",
				"4:3",
				"4:5",
				"5:4",
				"8:1",
				"9:16",
				"16:9",
				"21:9",
			],
			["auto", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9"],
			[
				"auto",
				"1:1",
				"1:4",
				"1:8",
				"2:3",
				"3:2",
				"3:4",
				"4:1",
				"4:3",
				"4:5",
				"5:4",
				"8:1",
				"9:16",
				"16:9",
				"21:9",
			],
			["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
			["1:1", "2:3", "3:2"],
			[
				"auto",
				"1:1",
				"3:2",
				"2:3",
				"4:3",
				"3:4",
				"5:4",
				"4:5",
				"16:9",
				"9:16",
				"2:1",
				"1:2",
				"3:1",
				"1:3",
				"21:9",
				"9:21",
			],
			["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
			["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
			["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
		]);
	});

	it("publishes nine independent model matrices with twenty priced SKUs", () => {
		const products = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set(["2026-09-07.2"]),
		} as never).products;

		expect(
			products.map((product) => ({
				key: product.key,
				defaultSkuKey: product.skuMatrix?.defaultSkuKey,
				dimensions: product.skuMatrix?.dimensions.map(({ key }) => key),
				skus: product.skuMatrix?.cells.map(({ skuKey, credits }) => [skuKey, credits]),
			})),
		).toEqual([
			{
				key: "image-nano-banana-2-lite",
				defaultSkuKey: "nano-banana-2-lite-1k",
				dimensions: ["resolution"],
				skus: [["nano-banana-2-lite-1k", 5]],
			},
			{
				key: "image-nano-banana",
				defaultSkuKey: "nano-banana-default",
				dimensions: [],
				skus: [["nano-banana-default", 5]],
			},
			{
				key: "image-nano-banana-2",
				defaultSkuKey: "nano-banana-2-1k",
				dimensions: ["resolution"],
				skus: [
					["nano-banana-2-1k", 9],
					["nano-banana-2-2k", 13],
					["nano-banana-2-4k", 19],
				],
			},
			{
				key: "image-nano-banana-pro",
				defaultSkuKey: "nano-banana-pro-1k",
				dimensions: ["resolution"],
				skus: [
					["nano-banana-pro-1k", 19],
					["nano-banana-pro-2k", 19],
					["nano-banana-pro-4k", 25],
				],
			},
			{
				key: "image-gpt-image-1-5",
				defaultSkuKey: "gpt-image-1-5-medium",
				dimensions: ["quality"],
				skus: [
					["gpt-image-1-5-medium", 5],
					["gpt-image-1-5-high", 23],
				],
			},
			{
				key: "image-gpt-image-2",
				defaultSkuKey: "gpt-image-2-1k",
				dimensions: ["resolution"],
				skus: [
					["gpt-image-2-1k", 7],
					["gpt-image-2-2k", 11],
					["gpt-image-2-4k", 17],
				],
			},
			{
				key: "image-seedream-4-5",
				defaultSkuKey: "seedream-4-5-basic-2k",
				dimensions: ["resolution", "quality"],
				skus: [
					["seedream-4-5-basic-2k", 8],
					["seedream-4-5-high-4k", 8],
				],
			},
			{
				key: "image-seedream-5-lite",
				defaultSkuKey: "seedream-5-lite-basic-2k",
				dimensions: ["resolution", "quality"],
				skus: [
					["seedream-5-lite-basic-2k", 7],
					["seedream-5-lite-high-3k", 7],
					["seedream-5-lite-ultra-4k", 7],
				],
			},
			{
				key: "image-seedream-5-pro",
				defaultSkuKey: "seedream-5-pro-basic-1k",
				dimensions: ["resolution", "quality"],
				skus: [
					["seedream-5-pro-basic-1k", 8],
					["seedream-5-pro-high-2k", 15],
				],
			},
		]);
		expect(products.flatMap((product) => product.skuMatrix?.cells ?? [])).toHaveLength(20);
	});

	it("publishes only the non-priced controls supported by each selected SKU", () => {
		const products = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set(["2026-09-07.2"]),
		} as never).products;
		const controlsBySku = Object.fromEntries(
			products.flatMap((product) =>
				(product.skuMatrix?.cells ?? []).map((cell) => [cell.skuKey, cell.controls]),
			),
		);

		expect(controlsBySku).toMatchObject({
			"nano-banana-2-lite-1k": [],
			"nano-banana-default": [
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
			"nano-banana-2-1k": [
				{
					key: "outputFormat",
					defaultValue: "jpeg",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
			"nano-banana-pro-4k": [
				{
					key: "outputFormat",
					defaultValue: "png",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
			"gpt-image-1-5-high": [],
			"gpt-image-2-1k": [
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
			"gpt-image-2-2k": [],
			"seedream-4-5-high-4k": [],
			"seedream-5-lite-ultra-4k": [
				{
					key: "outputFormat",
					defaultValue: "png",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
			"seedream-5-pro-high-2k": [
				{
					key: "outputFormat",
					defaultValue: "png",
					options: [
						{ key: "png", label: "PNG" },
						{ key: "jpeg", label: "JPEG" },
					],
				},
			],
		});
	});

	it("accepts supported non-priced controls without changing the SKU quote", () => {
		expect(
			quoteCatalogInput({
				productKey: "image-nano-banana",
				input: { ...imageInput("nano-banana-default"), outputFormat: "jpeg" },
			}),
		).toMatchObject({ skuKey: "nano-banana-default", credits: 5 });
		expect(
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: {
					...imageInput("gpt-image-2-1k", "1:1"),
					background: "transparent",
				},
			}),
		).toMatchObject({ skuKey: "gpt-image-2-1k", credits: 7 });
	});

	it("rejects a non-priced control that the selected SKU does not support", () => {
		expect(() =>
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: {
					...imageInput("gpt-image-2-2k", "1:1"),
					background: "transparent",
				},
			}),
		).toThrow(/background/i);
		expect(() =>
			quoteCatalogInput({
				productKey: "image-seedream-4-5",
				input: { ...imageInput("seedream-4-5-basic-2k"), outputFormat: "jpeg" },
			}),
		).toThrow(/output format/i);
	});

	it("keeps Kie routing, raw model IDs, and provider costs server-only", () => {
		const publicCatalog = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set(["2026-09-07.2"]),
		} as never);
		const serialized = JSON.stringify(publicCatalog);

		expect(serialized).not.toMatch(
			/kie|providerModelId|providerCostMicros|creditsConsumed|createTask|seedream\/5-pro-image-to-image/i,
		);
	});
});
