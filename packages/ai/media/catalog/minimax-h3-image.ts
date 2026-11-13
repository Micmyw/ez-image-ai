import { IMAGE_PRODUCT_SELECTION_CONTRACTS, IMAGE_SKU_CREDIT_COSTS } from "@repo/config";

import type { ImageSpecMatrix } from "./image-spec-matrices";

/** Kie public image tariff checked 2026-11-13. The first reference is also billed. */
export const MINIMAX_H3_REFERENCE_COST_MICROS = 2_500;

const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS["image-minimax-h3"];

export const MINIMAX_H3_IMAGE_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: contract.defaultSkuKey,
	dimensions: [
		{
			key: "resolution",
			label: "Resolution",
			options: ["1k", "2k", "4k"].map((key) => ({ key, label: key.toUpperCase() })),
		},
	],
	cells: contract.cells.map((cell, index) => ({
		skuKey: cell.skuKey,
		label: ["1K", "2K", "4K"][index]!,
		parameterValues: { resolution: ["1k", "2k", "4k"][index]! },
		credits: IMAGE_SKU_CREDIT_COSTS[cell.skuKey],
		aspectRatios: cell.aspectRatios,
		controls: cell.controls.map((control) => ({
			...control,
			label: "Output format",
			options: control.options.map((key) => ({ key, label: key.toUpperCase() })),
		})),
		routes: [
			{
				provider: "kie",
				providerModelId: "minimax-h3/image-edit",
				providerCostMicros: [9_000, 9_000, 27_500][index]! + MINIMAX_H3_REFERENCE_COST_MICROS,
				weight: 100,
			},
		],
	})),
};
