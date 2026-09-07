import { IMAGE_SKU_CREDIT_COSTS, type ImageAspectRatio, type ImageSkuKey } from "@repo/config";

import type { CatalogRoute } from "./routing";

export type ImageSpecDimensionKey = "resolution" | "quality";
export type ImageSpecControlKey = "outputFormat" | "background";

export interface ImageSpecDimension {
	key: ImageSpecDimensionKey;
	label: string;
	options: ReadonlyArray<{ key: string; label: string }>;
}

export interface ImageSpecCell {
	skuKey: ImageSkuKey;
	label: string;
	parameterValues: Partial<Record<ImageSpecDimensionKey, string>>;
	credits: number;
	aspectRatios: readonly ImageAspectRatio[];
	controls?: readonly ImageSpecControl[];
	routes: readonly CatalogRoute[];
}

export interface ImageSpecControl {
	key: ImageSpecControlKey;
	label: string;
	defaultValue: string;
	options: ReadonlyArray<{ key: string; label: string }>;
}

export interface ImageSpecMatrix {
	defaultSkuKey: ImageSkuKey;
	dimensions: readonly ImageSpecDimension[];
	cells: readonly ImageSpecCell[];
}

const NANO_BANANA_2_LITE_ASPECT_RATIOS = [
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
] as const satisfies readonly ImageAspectRatio[];

const NANO_BANANA_2_ASPECT_RATIOS = [
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
] as const satisfies readonly ImageAspectRatio[];

const NANO_BANANA_ASPECT_RATIOS = [
	"auto",
	"1:1",
	"9:16",
	"16:9",
	"3:4",
	"4:3",
	"3:2",
	"2:3",
	"5:4",
	"4:5",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const NANO_PRO_ASPECT_RATIOS = [
	"auto",
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const GPT_IMAGE_1_5_ASPECT_RATIOS = [
	"1:1",
	"2:3",
	"3:2",
] as const satisfies readonly ImageAspectRatio[];

const GPT_2K_ASPECT_RATIOS = [
	"1:1",
	"3:2",
	"2:3",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"2:1",
	"1:2",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const GPT_1K_ASPECT_RATIOS = [
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
] as const satisfies readonly ImageAspectRatio[];

const GPT_4K_ASPECT_RATIOS = [
	"3:2",
	"2:3",
	"4:3",
	"3:4",
	"4:5",
	"5:4",
	"16:9",
	"9:16",
	"2:1",
	"1:2",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const SEEDREAM_4_5_ASPECT_RATIOS = [
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"2:3",
	"3:2",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const SEEDREAM_5_LITE_ASPECT_RATIOS = [
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"2:3",
	"3:2",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const SEEDREAM_5_PRO_ASPECT_RATIOS = [
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"2:3",
	"3:2",
	"21:9",
] as const satisfies readonly ImageAspectRatio[];

const NANO_BANANA_CONTROLS = [
	{
		key: "outputFormat",
		label: "Output format",
		defaultValue: "png",
		options: [
			{ key: "png", label: "PNG" },
			{ key: "jpeg", label: "JPEG" },
		],
	},
] as const satisfies readonly ImageSpecControl[];

const NANO_BANANA_2_CONTROLS = [
	{
		key: "outputFormat",
		label: "Output format",
		defaultValue: "jpeg",
		options: [
			{ key: "png", label: "PNG" },
			{ key: "jpeg", label: "JPEG" },
		],
	},
] as const satisfies readonly ImageSpecControl[];

const NANO_BANANA_PRO_CONTROLS = [
	{
		key: "outputFormat",
		label: "Output format",
		defaultValue: "png",
		options: [
			{ key: "png", label: "PNG" },
			{ key: "jpeg", label: "JPEG" },
		],
	},
] as const satisfies readonly ImageSpecControl[];

const GPT_IMAGE_2_1K_CONTROLS = [
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
] as const satisfies readonly ImageSpecControl[];

const SEEDREAM_5_LITE_CONTROLS = [
	{
		key: "outputFormat",
		label: "Output format",
		defaultValue: "png",
		options: [
			{ key: "png", label: "PNG" },
			{ key: "jpeg", label: "JPEG" },
		],
	},
] as const satisfies readonly ImageSpecControl[];

const SEEDREAM_5_PRO_CONTROLS = [
	{
		key: "outputFormat",
		label: "Output format",
		defaultValue: "png",
		options: [
			{ key: "png", label: "PNG" },
			{ key: "jpeg", label: "JPEG" },
		],
	},
] as const satisfies readonly ImageSpecControl[];

export const NANO_BANANA_2_LITE_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "nano-banana-2-lite-1k",
	dimensions: [{ key: "resolution", label: "Resolution", options: [{ key: "1k", label: "1K" }] }],
	cells: [
		{
			skuKey: "nano-banana-2-lite-1k",
			label: "1K",
			parameterValues: { resolution: "1k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-2-lite-1k"],
			aspectRatios: NANO_BANANA_2_LITE_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-2-lite",
					providerCostMicros: 20_000,
					weight: 100,
				},
			],
		},
	],
};

export const NANO_BANANA_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "nano-banana-default",
	dimensions: [],
	cells: [
		{
			skuKey: "nano-banana-default",
			label: "Default",
			parameterValues: {},
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-default"],
			aspectRatios: NANO_BANANA_ASPECT_RATIOS,
			controls: NANO_BANANA_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "google/nano-banana-edit",
					providerCostMicros: 20_000,
					weight: 100,
				},
			],
		},
	],
};

export const NANO_BANANA_2_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "nano-banana-2-1k",
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
			skuKey: "nano-banana-2-1k",
			label: "1K",
			parameterValues: { resolution: "1k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-2-1k"],
			aspectRatios: NANO_BANANA_2_ASPECT_RATIOS,
			controls: NANO_BANANA_2_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-2",
					providerCostMicros: 40_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "nano-banana-2-2k",
			label: "2K",
			parameterValues: { resolution: "2k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-2-2k"],
			aspectRatios: NANO_BANANA_2_ASPECT_RATIOS,
			controls: NANO_BANANA_2_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-2",
					providerCostMicros: 60_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "nano-banana-2-4k",
			label: "4K",
			parameterValues: { resolution: "4k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-2-4k"],
			aspectRatios: NANO_BANANA_2_ASPECT_RATIOS,
			controls: NANO_BANANA_2_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-2",
					providerCostMicros: 90_000,
					weight: 100,
				},
			],
		},
	],
};

export const NANO_BANANA_PRO_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "nano-banana-pro-1k",
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
			skuKey: "nano-banana-pro-1k",
			label: "1K",
			parameterValues: { resolution: "1k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-pro-1k"],
			aspectRatios: NANO_PRO_ASPECT_RATIOS,
			controls: NANO_BANANA_PRO_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-pro",
					providerCostMicros: 90_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "nano-banana-pro-2k",
			label: "2K",
			parameterValues: { resolution: "2k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-pro-2k"],
			aspectRatios: NANO_PRO_ASPECT_RATIOS,
			controls: NANO_BANANA_PRO_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-pro",
					providerCostMicros: 90_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "nano-banana-pro-4k",
			label: "4K",
			parameterValues: { resolution: "4k" },
			credits: IMAGE_SKU_CREDIT_COSTS["nano-banana-pro-4k"],
			aspectRatios: NANO_PRO_ASPECT_RATIOS,
			controls: NANO_BANANA_PRO_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "nano-banana-pro",
					providerCostMicros: 120_000,
					weight: 100,
				},
			],
		},
	],
};

export const GPT_IMAGE_1_5_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "gpt-image-1-5-medium",
	dimensions: [
		{
			key: "quality",
			label: "Quality",
			options: [
				{ key: "medium", label: "Medium" },
				{ key: "high", label: "High" },
			],
		},
	],
	cells: [
		{
			skuKey: "gpt-image-1-5-medium",
			label: "Medium",
			parameterValues: { quality: "medium" },
			credits: IMAGE_SKU_CREDIT_COSTS["gpt-image-1-5-medium"],
			aspectRatios: GPT_IMAGE_1_5_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "gpt-image/1.5-image-to-image",
					providerCostMicros: 20_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "gpt-image-1-5-high",
			label: "High",
			parameterValues: { quality: "high" },
			credits: IMAGE_SKU_CREDIT_COSTS["gpt-image-1-5-high"],
			aspectRatios: GPT_IMAGE_1_5_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "gpt-image/1.5-image-to-image",
					providerCostMicros: 110_000,
					weight: 100,
				},
			],
		},
	],
};

export const GPT_IMAGE_2_MATRIX: ImageSpecMatrix = {
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
			credits: IMAGE_SKU_CREDIT_COSTS["gpt-image-2-1k"],
			aspectRatios: GPT_1K_ASPECT_RATIOS,
			controls: GPT_IMAGE_2_1K_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "gpt-image-2-image-to-image",
					providerCostMicros: 30_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "gpt-image-2-2k",
			label: "2K",
			parameterValues: { resolution: "2k" },
			credits: IMAGE_SKU_CREDIT_COSTS["gpt-image-2-2k"],
			aspectRatios: GPT_2K_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "gpt-image-2-image-to-image",
					providerCostMicros: 50_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "gpt-image-2-4k",
			label: "4K",
			parameterValues: { resolution: "4k" },
			credits: IMAGE_SKU_CREDIT_COSTS["gpt-image-2-4k"],
			aspectRatios: GPT_4K_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "gpt-image-2-image-to-image",
					providerCostMicros: 80_000,
					weight: 100,
				},
			],
		},
	],
};

export const SEEDREAM_4_5_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "seedream-4-5-basic-2k",
	dimensions: [
		{
			key: "resolution",
			label: "Resolution",
			options: [
				{ key: "2k", label: "2K" },
				{ key: "4k", label: "4K" },
			],
		},
		{
			key: "quality",
			label: "Quality",
			options: [
				{ key: "basic", label: "Basic" },
				{ key: "high", label: "High" },
			],
		},
	],
	cells: [
		{
			skuKey: "seedream-4-5-basic-2k",
			label: "2K · Basic",
			parameterValues: { resolution: "2k", quality: "basic" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-4-5-basic-2k"],
			aspectRatios: SEEDREAM_4_5_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/4.5-edit",
					providerCostMicros: 32_500,
					weight: 100,
				},
			],
		},
		{
			skuKey: "seedream-4-5-high-4k",
			label: "4K · High",
			parameterValues: { resolution: "4k", quality: "high" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-4-5-high-4k"],
			aspectRatios: SEEDREAM_4_5_ASPECT_RATIOS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/4.5-edit",
					providerCostMicros: 32_500,
					weight: 100,
				},
			],
		},
	],
};

export const SEEDREAM_5_LITE_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "seedream-5-lite-basic-2k",
	dimensions: [
		{
			key: "resolution",
			label: "Resolution",
			options: [
				{ key: "2k", label: "2K" },
				{ key: "3k", label: "3K" },
				{ key: "4k", label: "4K" },
			],
		},
		{
			key: "quality",
			label: "Quality",
			options: [
				{ key: "basic", label: "Basic" },
				{ key: "high", label: "High" },
				{ key: "ultra", label: "Ultra" },
			],
		},
	],
	cells: [
		{
			skuKey: "seedream-5-lite-basic-2k",
			label: "2K · Basic",
			parameterValues: { resolution: "2k", quality: "basic" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-5-lite-basic-2k"],
			aspectRatios: SEEDREAM_5_LITE_ASPECT_RATIOS,
			controls: SEEDREAM_5_LITE_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/5-lite-image-to-image",
					providerCostMicros: 27_500,
					weight: 100,
				},
			],
		},
		{
			skuKey: "seedream-5-lite-high-3k",
			label: "3K · High",
			parameterValues: { resolution: "3k", quality: "high" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-5-lite-high-3k"],
			aspectRatios: SEEDREAM_5_LITE_ASPECT_RATIOS,
			controls: SEEDREAM_5_LITE_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/5-lite-image-to-image",
					providerCostMicros: 27_500,
					weight: 100,
				},
			],
		},
		{
			skuKey: "seedream-5-lite-ultra-4k",
			label: "4K · Ultra",
			parameterValues: { resolution: "4k", quality: "ultra" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-5-lite-ultra-4k"],
			aspectRatios: SEEDREAM_5_LITE_ASPECT_RATIOS,
			controls: SEEDREAM_5_LITE_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/5-lite-image-to-image",
					providerCostMicros: 27_500,
					weight: 100,
				},
			],
		},
	],
};

export const SEEDREAM_5_PRO_MATRIX: ImageSpecMatrix = {
	defaultSkuKey: "seedream-5-pro-basic-1k",
	dimensions: [
		{
			key: "resolution",
			label: "Resolution",
			options: [
				{ key: "1k", label: "1K" },
				{ key: "2k", label: "2K" },
			],
		},
		{
			key: "quality",
			label: "Quality",
			options: [
				{ key: "basic", label: "Basic" },
				{ key: "high", label: "High" },
			],
		},
	],
	cells: [
		{
			skuKey: "seedream-5-pro-basic-1k",
			label: "1K · Basic",
			parameterValues: { resolution: "1k", quality: "basic" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-5-pro-basic-1k"],
			aspectRatios: SEEDREAM_5_PRO_ASPECT_RATIOS,
			controls: SEEDREAM_5_PRO_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/5-pro-image-to-image",
					providerCostMicros: 35_000,
					weight: 100,
				},
			],
		},
		{
			skuKey: "seedream-5-pro-high-2k",
			label: "2K · High",
			parameterValues: { resolution: "2k", quality: "high" },
			credits: IMAGE_SKU_CREDIT_COSTS["seedream-5-pro-high-2k"],
			aspectRatios: SEEDREAM_5_PRO_ASPECT_RATIOS,
			controls: SEEDREAM_5_PRO_CONTROLS,
			routes: [
				{
					provider: "kie",
					providerModelId: "seedream/5-pro-image-to-image",
					providerCostMicros: 70_000,
					weight: 100,
				},
			],
		},
	],
};

export function getImageSpecCell(
	matrix: ImageSpecMatrix,
	skuKey: string | undefined,
): ImageSpecCell | undefined {
	return matrix.cells.find((cell) => cell.skuKey === skuKey);
}
