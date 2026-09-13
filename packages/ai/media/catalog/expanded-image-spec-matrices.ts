import { IMAGE_PRODUCT_SELECTION_CONTRACTS, IMAGE_SKU_CREDIT_COSTS } from "@repo/config";

import type { ImageSpecMatrix } from "./image-spec-matrices";

const resolutions = ["1k", "2k", "4k"] as const;
type ExpandedModelKey =
	| "image-gpt-image-2-5-flare"
	| "image-gpt-image-2-5-sunburst"
	| "image-seedream-4";

/** Costs and request contracts checked against Kie's published model pages on 2026-09-13. */
function resolutionMatrix(
	productKey: ExpandedModelKey,
	providerModelId: string,
	providerCosts: readonly [number, number, number],
): ImageSpecMatrix {
	const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS[productKey];
	return {
		defaultSkuKey: contract.defaultSkuKey,
		dimensions: [
			{
				key: "resolution",
				label: "Resolution",
				options: resolutions.map((key) => ({ key, label: key.toUpperCase() })),
			},
		],
		cells: contract.cells.map((cell, index) => ({
			skuKey: cell.skuKey,
			label: resolutions[index]!.toUpperCase(),
			parameterValues: { resolution: resolutions[index]! },
			credits: IMAGE_SKU_CREDIT_COSTS[cell.skuKey],
			aspectRatios: cell.aspectRatios,
			controls: cell.controls.map((control) => ({
				key: control.key,
				label: "Background",
				defaultValue: control.defaultValue,
				options: control.options.map((key) => ({
					key,
					label: key === "auto" ? "Automatic" : key === "opaque" ? "Opaque" : "Transparent",
				})),
			})),
			routes: [
				{
					provider: "kie",
					providerModelId,
					providerCostMicros: providerCosts[index]!,
					weight: 100,
				},
			],
		})),
	};
}

export const GPT_IMAGE_2_5_FLARE_MATRIX = resolutionMatrix(
	"image-gpt-image-2-5-flare",
	"gpt-image-2-5-flare-image-to-image",
	[30_000, 50_000, 80_000],
);
export const GPT_IMAGE_2_5_SUNBURST_MATRIX = resolutionMatrix(
	"image-gpt-image-2-5-sunburst",
	"gpt-image-2-5-sunburst-image-to-image",
	[30_000, 50_000, 80_000],
);
export const SEEDREAM_4_MATRIX = resolutionMatrix(
	"image-seedream-4",
	"bytedance/seedream-v4-edit",
	[25_000, 25_000, 25_000],
);
