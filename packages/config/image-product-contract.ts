import { z } from "zod";

import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	IMAGE_BACKGROUNDS,
	IMAGE_OUTPUT_FORMATS,
	imageSkuKeySchema,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "./product";

export type EzPicProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];
export type ImageSelectionControlKey = "outputFormat" | "background";

export interface ImageSelectionControlContract {
	key: ImageSelectionControlKey;
	defaultValue: string;
	options: readonly string[];
}

export interface ImageSkuSelectionContract {
	skuKey: ImageSkuKey;
	aspectRatios: readonly ImageAspectRatio[];
	controls: readonly ImageSelectionControlContract[];
}

export interface ImageProductSelectionContract {
	defaultSkuKey: ImageSkuKey;
	defaultAspectRatio: ImageAspectRatio;
	cells: readonly ImageSkuSelectionContract[];
}

export interface ParsedImageSelection {
	skuKey: ImageSkuKey;
	aspectRatio: ImageAspectRatio;
	outputFormat?: ImageOutputFormat;
	background?: ImageBackground;
}

export const imageAspectRatioSchema = z.enum(IMAGE_ASPECT_RATIOS);
export const imageOutputFormatSchema = z.enum(IMAGE_OUTPUT_FORMATS);
export const imageBackgroundSchema = z.enum(IMAGE_BACKGROUNDS);

/**
 * Browser-safe product selection rules. Provider routes, model identifiers,
 * credentials, and upstream costs deliberately do not belong in this module.
 */
export const IMAGE_PRODUCT_SELECTION_CONTRACTS: Readonly<
	Record<EzPicProductKey, ImageProductSelectionContract>
> = {
	"image-nano-banana-2-lite": {
		defaultSkuKey: "nano-banana-2-lite-1k",
		defaultAspectRatio: "auto",
		cells: [
			{
				skuKey: "nano-banana-2-lite-1k",
				aspectRatios: [
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
				controls: [],
			},
		],
	},
	"image-nano-banana": {
		defaultSkuKey: "nano-banana-default",
		defaultAspectRatio: "auto",
		cells: [
			{
				skuKey: "nano-banana-default",
				aspectRatios: [
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
				],
				controls: [{ key: "outputFormat", defaultValue: "png", options: ["png", "jpeg"] }],
			},
		],
	},
	"image-nano-banana-2": {
		defaultSkuKey: "nano-banana-2-1k",
		defaultAspectRatio: "auto",
		cells: [
			...(["nano-banana-2-1k", "nano-banana-2-2k", "nano-banana-2-4k"] as const).map((skuKey) => ({
				skuKey,
				aspectRatios: [
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
				] as const,
				controls: [
					{ key: "outputFormat" as const, defaultValue: "jpeg", options: ["png", "jpeg"] },
				],
			})),
		],
	},
	"image-nano-banana-pro": {
		defaultSkuKey: "nano-banana-pro-1k",
		defaultAspectRatio: "auto",
		cells: [
			...(["nano-banana-pro-1k", "nano-banana-pro-2k", "nano-banana-pro-4k"] as const).map(
				(skuKey) => ({
					skuKey,
					aspectRatios: [
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
					] as const,
					controls: [
						{ key: "outputFormat" as const, defaultValue: "png", options: ["png", "jpeg"] },
					],
				}),
			),
		],
	},
	"image-gpt-image-1-5": {
		defaultSkuKey: "gpt-image-1-5-medium",
		defaultAspectRatio: "1:1",
		cells: [
			...(["gpt-image-1-5-medium", "gpt-image-1-5-high"] as const).map((skuKey) => ({
				skuKey,
				aspectRatios: ["1:1", "2:3", "3:2"] as const,
				controls: [],
			})),
		],
	},
	"image-gpt-image-2": {
		defaultSkuKey: "gpt-image-2-1k",
		defaultAspectRatio: "auto",
		cells: [
			{
				skuKey: "gpt-image-2-1k",
				aspectRatios: [
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
				controls: [
					{
						key: "background",
						defaultValue: "opaque",
						options: ["auto", "opaque", "transparent"],
					},
				],
			},
			{
				skuKey: "gpt-image-2-2k",
				aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "2:1", "1:2", "21:9"],
				controls: [],
			},
			{
				skuKey: "gpt-image-2-4k",
				aspectRatios: [
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
				],
				controls: [],
			},
		],
	},
	"image-seedream-4-5": {
		defaultSkuKey: "seedream-4-5-basic-2k",
		defaultAspectRatio: "1:1",
		cells: [
			...(["seedream-4-5-basic-2k", "seedream-4-5-high-4k"] as const).map((skuKey) => ({
				skuKey,
				aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"] as const,
				controls: [],
			})),
		],
	},
	"image-seedream-5-lite": {
		defaultSkuKey: "seedream-5-lite-basic-2k",
		defaultAspectRatio: "1:1",
		cells: [
			...(
				["seedream-5-lite-basic-2k", "seedream-5-lite-high-3k", "seedream-5-lite-ultra-4k"] as const
			).map((skuKey) => ({
				skuKey,
				aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"] as const,
				controls: [{ key: "outputFormat" as const, defaultValue: "png", options: ["png", "jpeg"] }],
			})),
		],
	},
	"image-seedream-5-pro": {
		defaultSkuKey: "seedream-5-pro-basic-1k",
		defaultAspectRatio: "1:1",
		cells: [
			...(["seedream-5-pro-basic-1k", "seedream-5-pro-high-2k"] as const).map((skuKey) => ({
				skuKey,
				aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"] as const,
				controls: [{ key: "outputFormat" as const, defaultValue: "png", options: ["png", "jpeg"] }],
			})),
		],
	},
};

const currentProductKeys = new Set<string>(EZPIC_PRODUCT_KEYS);

export function isEzPicProductKey(value: string): value is EzPicProductKey {
	return currentProductKeys.has(value);
}

export function getImageProductSelectionContract(
	productKey: string,
): ImageProductSelectionContract | undefined {
	return isEzPicProductKey(productKey) ? IMAGE_PRODUCT_SELECTION_CONTRACTS[productKey] : undefined;
}

export function getImageSkuSelectionContract(
	productKey: string,
	skuKey: string,
): ImageSkuSelectionContract | undefined {
	return getImageProductSelectionContract(productKey)?.cells.find((cell) => cell.skuKey === skuKey);
}

export function parseImageSelection(
	productKey: string,
	value: unknown,
): ParsedImageSelection | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const skuKey = imageSkuKeySchema.safeParse(input.skuKey);
	const aspectRatio = imageAspectRatioSchema.safeParse(input.aspectRatio);
	if (!skuKey.success || !aspectRatio.success) return null;
	const cell = getImageSkuSelectionContract(productKey, skuKey.data);
	if (!cell?.aspectRatios.includes(aspectRatio.data)) return null;

	const selection: ParsedImageSelection = {
		skuKey: skuKey.data,
		aspectRatio: aspectRatio.data,
	};
	if (input.outputFormat !== undefined) {
		const outputFormat = imageOutputFormatSchema.safeParse(input.outputFormat);
		const control = cell.controls.find((candidate) => candidate.key === "outputFormat");
		if (!outputFormat.success || !control?.options.includes(outputFormat.data)) return null;
		selection.outputFormat = outputFormat.data;
	}
	if (input.background !== undefined) {
		const background = imageBackgroundSchema.safeParse(input.background);
		const control = cell.controls.find((candidate) => candidate.key === "background");
		if (!background.success || !control?.options.includes(background.data)) return null;
		selection.background = background.data;
	}
	return selection;
}

export function isValidImageSelection(productKey: string, value: unknown): boolean {
	return parseImageSelection(productKey, value) !== null;
}
