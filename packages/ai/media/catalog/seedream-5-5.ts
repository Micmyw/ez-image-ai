import { IMAGE_PRODUCT_SELECTION_CONTRACTS, IMAGE_SKU_CREDIT_COSTS } from "@repo/config";

import type { ImageSpecMatrix } from "./image-spec-matrices";

/** Kie image tariff checked 2026-11-13; every input image is billed separately. */
export const SEEDREAM_5_5_REFERENCE_COST_MICROS = 7_200;

const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS["image-seedream-5-5"];
const resolutions = ["1k", "1.5k", "2k"] as const;

export const SEEDREAM_5_5_IMAGE_MATRIX: ImageSpecMatrix = {
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
			...control,
			label: control.key === "outputFormat" ? "Output format" : "Background",
			options: control.options.map((key) => ({
				key,
				label:
					control.key === "outputFormat" ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1),
			})),
		})),
		routes: [
			{
				provider: "kie",
				providerModelId: "seedream/5-5-image-to-image",
				providerCostMicros: [18_000, 18_000, 31_500][index]! + SEEDREAM_5_5_REFERENCE_COST_MICROS,
				weight: 100,
			},
		],
	})),
};
