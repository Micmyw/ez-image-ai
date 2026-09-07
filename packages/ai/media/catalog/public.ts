import { DEFAULT_PRODUCT_CONFIG, IMAGE_ASPECT_RATIOS } from "@repo/config";

import { createExecutableRouteGraph, type CatalogEntry } from "./catalog";
import type { ImageSpecControlKey, ImageSpecDimensionKey } from "./image-spec-matrices";
import {
	executableRouteGraphOptionsFromEnvironment,
	type ExecutableRouteGraphOptions,
} from "./routing";

export interface PublicCatalogEntry {
	key: string;
	label: string;
	description: string;
	mediaKind: "image" | "video";
	inputKinds: string[];
	credits: number;
	skuMatrix?: {
		defaultSkuKey: string;
		dimensions: Array<{
			key: ImageSpecDimensionKey;
			label: string;
			options: Array<{ key: string; label: string }>;
		}>;
		cells: Array<{
			skuKey: string;
			label: string;
			parameterValues: Partial<Record<ImageSpecDimensionKey, string>>;
			credits: number;
			aspectRatios: string[];
			controls: Array<{
				key: ImageSpecControlKey;
				label: string;
				defaultValue: string;
				options: Array<{ key: string; label: string }>;
			}>;
		}>;
	};
	fields: Array<{
		type: "text" | "slider" | "aspect-ratio" | "image-asset";
		key: string;
		label: string;
		required?: boolean;
		min?: number;
		max?: number;
		step?: number;
		options?: Array<{ value: string; label: string }>;
	}>;
}
export function getPublicProductCatalog(
	options: ExecutableRouteGraphOptions = executableRouteGraphOptionsFromEnvironment(),
): {
	catalogVersion: string;
	pricingVersion: string;
	products: PublicCatalogEntry[];
} {
	return {
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
		products: createExecutableRouteGraph(options)
			.entries.filter(({ key }) => DEFAULT_PRODUCT_CONFIG.productKeys.includes(key))
			.map((entry) => ({
				key: entry.key,
				label: entry.label,
				description: entry.description,
				mediaKind: entry.mediaKind,
				inputKinds: [...entry.inputKinds],
				credits: entry.credits,
				...(entry.imageSpecMatrix
					? {
							skuMatrix: {
								defaultSkuKey: entry.imageSpecMatrix.defaultSkuKey,
								dimensions: entry.imageSpecMatrix.dimensions.map((dimension) => ({
									key: dimension.key,
									label: dimension.label,
									options: dimension.options.map((option) => ({ ...option })),
								})),
								cells: entry.imageSpecMatrix.cells.map((cell) => ({
									skuKey: cell.skuKey,
									label: cell.label,
									parameterValues: { ...cell.parameterValues },
									credits: cell.credits,
									aspectRatios: [...cell.aspectRatios],
									controls: (cell.controls ?? []).map((control) => ({
										...control,
										options: control.options.map((option) => ({ ...option })),
									})),
								})),
							},
						}
					: {}),
				fields: publicFields(entry),
			})),
	};
}

function publicFields(entry: CatalogEntry): PublicCatalogEntry["fields"] {
	const { key: productKey, mediaKind, inputKinds } = entry;
	const imageAspectRatios = entry.imageSpecMatrix
		? [...new Set(entry.imageSpecMatrix.cells.flatMap((cell) => cell.aspectRatios))]
		: IMAGE_ASPECT_RATIOS;
	return [
		{ type: "text", key: "prompt", label: "Prompt", required: true },
		...(inputKinds.some((kind) => kind.startsWith("image-to-"))
			? [
					{
						type: "image-asset" as const,
						key: "sourceAssetId",
						label: "Source image",
						required: true,
					},
				]
			: []),
		...(mediaKind === "image" && inputKinds.some((kind) => kind.endsWith("-to-image"))
			? [
					{
						type: "aspect-ratio" as const,
						key: "aspectRatio",
						label: "Aspect ratio",
						required: true,
						options: imageAspectRatios.map((value) => ({
							value,
							label: value === "auto" ? "Automatic" : value,
						})),
					},
				]
			: mediaKind === "video"
				? [
						{
							type: "slider" as const,
							key: "durationSeconds",
							label: "Length",
							min: productKey === "video-quality" ? 4 : 1,
							max: productKey === "video-quality" ? 8 : 30,
							step: productKey === "video-quality" ? 2 : 1,
						},
					]
				: []),
	];
}
