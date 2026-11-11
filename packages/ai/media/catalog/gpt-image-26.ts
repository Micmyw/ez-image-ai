import {
	IMAGE_PRODUCT_SELECTION_CONTRACTS,
	IMAGE_SKU_CREDIT_COSTS,
	imageGifSheetUnits,
	isGptImage26Sku,
} from "@repo/config";

import type { ImageSpecMatrix } from "./image-spec-matrices";
import type { MediaModelInput } from "./schemas";

/** Token rates checked 2026-11-11. Planning allowances are NOT upstream price caps. */
export const GPT_IMAGE_26_COST_BASIS = {
	version: "kie-gpt-image-26-estimate-2026-11-11",
	kind: "token-cost-estimate",
	textInputUsdPerMillion: 4.5,
	imageInputUsdPerMillion: 7.2,
	imageOutputUsdPerMillion: 27,
	svgAuthor: "gpt-5.6-luna",
	svgInputUsdPerMillion: 0.18,
	svgOutputUsdPerMillion: 1.08,
} as const;

export function gptImage26Matrix(variant: "flare" | "sunburst"): ImageSpecMatrix {
	const contract = IMAGE_PRODUCT_SELECTION_CONTRACTS[`image-gpt-image-2-6-${variant}`];
	return {
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
				label: control.key === "outputFormat" ? "Output format" : "Background",
				options: control.options.map((key) => ({
					key,
					label: control.key === "outputFormat" ? key.toUpperCase() : key,
				})),
			})),
			routes: [
				{
					provider: "kie",
					providerModelId: `gpt-image-2-6/${variant}-image-to-image`,
					providerCostMicros: (variant === "flare"
						? [90_000, 180_000, 360_000]
						: [115_000, 240_000, 490_000])[index]!,
					weight: 100,
				},
			],
		})),
	};
}

export function imageFormatCostAllowance(baseMicros: number, input: MediaModelInput): number {
	if (!("skuKey" in input) || !input.skuKey || !isGptImage26Sku(input.skuKey)) return baseMicros;
	if (input.outputFormat === "svg") return baseMicros + 100_000;
	if (input.outputFormat === "gif")
		return Math.ceil(baseMicros * imageGifSheetUnits(input.frameCount));
	return baseMicros;
}
