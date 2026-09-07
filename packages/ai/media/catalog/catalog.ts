import {
	DEFAULT_PRODUCT_CONFIG,
	PRODUCT_CREDIT_COSTS,
	productModelKeySchema,
	type ImageSkuKey,
	type ProductModelKey,
} from "@repo/config";
import { z } from "zod";

import {
	getImageSpecCell,
	GPT_IMAGE_1_5_MATRIX,
	GPT_IMAGE_2_MATRIX,
	type ImageSpecCell,
	type ImageSpecMatrix,
	NANO_BANANA_2_MATRIX,
	NANO_BANANA_2_LITE_MATRIX,
	NANO_BANANA_MATRIX,
	NANO_BANANA_PRO_MATRIX,
	SEEDREAM_4_5_MATRIX,
	SEEDREAM_5_LITE_MATRIX,
	SEEDREAM_5_PRO_MATRIX,
} from "./image-spec-matrices";
import {
	executableRouteGraph,
	type CatalogRoute,
	type ExecutableRouteGraphOptions,
} from "./routing";
import { mediaModelInputSchema, type MediaModelInput } from "./schemas";

export { getPublicProductCatalog } from "./public";

export interface CatalogEntry {
	key: ProductModelKey;
	label: string;
	description: string;
	mediaKind: "image" | "video";
	inputKinds: MediaModelInput["kind"][];
	credits: number;
	routes: readonly CatalogRoute[];
	imageSpecMatrix?: ImageSpecMatrix;
}

function matrixRoutes(matrix: ImageSpecMatrix): readonly CatalogRoute[] {
	return matrix.cells.flatMap((cell) => cell.routes);
}

const CATALOG: Record<ProductModelKey, CatalogEntry> = {
	"image-fast": {
		key: "image-fast",
		label: "Standard Edit",
		description: "Private prompt-based image editing at the Standard tier",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-fast"],
		routes: [
			{
				provider: "openrouter",
				providerModelId: "sourceful/riverflow-v2.5-fast",
				providerCostMicros: 23_000,
				weight: 100,
			},
		],
	},
	"image-quality": {
		key: "image-quality",
		label: "Quality Edit",
		description: "Private prompt-based image editing at the Quality tier",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-quality"],
		routes: [
			{
				provider: "openrouter",
				providerModelId: "sourceful/riverflow-v2.5-pro",
				providerCostMicros: 180_000,
				weight: 100,
			},
		],
	},
	"image-nano-banana-2-lite": {
		key: "image-nano-banana-2-lite",
		label: "Nano Banana 2 Lite",
		description: "Fast, credit-efficient image editing with a fixed 1K output",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-nano-banana-2-lite"],
		routes: matrixRoutes(NANO_BANANA_2_LITE_MATRIX),
		imageSpecMatrix: NANO_BANANA_2_LITE_MATRIX,
	},
	"image-nano-banana": {
		key: "image-nano-banana",
		label: "Nano Banana",
		description: "Credit-efficient image editing with a focused standard output",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-nano-banana"],
		routes: matrixRoutes(NANO_BANANA_MATRIX),
		imageSpecMatrix: NANO_BANANA_MATRIX,
	},
	"image-nano-banana-2": {
		key: "image-nano-banana-2",
		label: "Nano Banana 2",
		description: "Flexible image editing with independent 1K, 2K, and 4K output options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-nano-banana-2"],
		routes: matrixRoutes(NANO_BANANA_2_MATRIX),
		imageSpecMatrix: NANO_BANANA_2_MATRIX,
	},
	"image-nano-banana-pro": {
		key: "image-nano-banana-pro",
		label: "Nano Banana Pro",
		description: "Premium image editing with model-specific 1K, 2K, and 4K outputs",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-nano-banana-pro"],
		routes: matrixRoutes(NANO_BANANA_PRO_MATRIX),
		imageSpecMatrix: NANO_BANANA_PRO_MATRIX,
	},
	"image-gpt-image-1-5": {
		key: "image-gpt-image-1-5",
		label: "GPT Image 1.5",
		description: "Image editing with independent Medium and High quality options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-gpt-image-1-5"],
		routes: matrixRoutes(GPT_IMAGE_1_5_MATRIX),
		imageSpecMatrix: GPT_IMAGE_1_5_MATRIX,
	},
	"image-gpt-image-2": {
		key: "image-gpt-image-2",
		label: "GPT Image 2",
		description: "Detailed image editing with independent 1K, 2K, and 4K output options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-gpt-image-2"],
		routes: matrixRoutes(GPT_IMAGE_2_MATRIX),
		imageSpecMatrix: GPT_IMAGE_2_MATRIX,
	},
	"image-seedream-4-5": {
		key: "image-seedream-4-5",
		label: "Seedream 4.5",
		description: "Image editing with independent Basic 2K and High 4K options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-seedream-4-5"],
		routes: matrixRoutes(SEEDREAM_4_5_MATRIX),
		imageSpecMatrix: SEEDREAM_4_5_MATRIX,
	},
	"image-seedream-5-lite": {
		key: "image-seedream-5-lite",
		label: "Seedream 5 Lite",
		description: "Image editing with independent Basic 2K, High 3K, and Ultra 4K options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-seedream-5-lite"],
		routes: matrixRoutes(SEEDREAM_5_LITE_MATRIX),
		imageSpecMatrix: SEEDREAM_5_LITE_MATRIX,
	},
	"image-seedream-5-pro": {
		key: "image-seedream-5-pro",
		label: "Seedream 5 Pro",
		description: "Image editing with independent Basic 1K and High 2K options",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: PRODUCT_CREDIT_COSTS["image-seedream-5-pro"],
		routes: matrixRoutes(SEEDREAM_5_PRO_MATRIX),
		imageSpecMatrix: SEEDREAM_5_PRO_MATRIX,
	},
	"video-fast": {
		key: "video-fast",
		label: "Fast Video",
		description: "Short video generation",
		mediaKind: "video",
		inputKinds: ["text-to-video", "image-to-video"],
		credits: PRODUCT_CREDIT_COSTS["video-fast"],
		routes: [
			{
				provider: "fal",
				providerModelId: "fal-ai/fast-video",
				providerCostMicros: 100_000,
				weight: 100,
			},
		],
	},
	"video-quality": {
		key: "video-quality",
		label: "Quality Video",
		description: "High fidelity video generation",
		mediaKind: "video",
		inputKinds: ["text-to-video", "image-to-video"],
		credits: PRODUCT_CREDIT_COSTS["video-quality"],
		routes: [
			{
				provider: "kie",
				providerModelId: "veo3",
				providerCostMicros: 300_000,
				weight: 100,
			},
		],
	},
};

const quoteInputSchema = z.object({
	productKey: productModelKeySchema,
	input: mediaModelInputSchema,
});

export function getCatalogEntry(key: ProductModelKey): CatalogEntry {
	return CATALOG[key];
}
export function listCatalogEntries(): CatalogEntry[] {
	return Object.values(CATALOG);
}

export function isCatalogInputSupported(
	entry: Pick<CatalogEntry, "inputKinds">,
	input: unknown,
): boolean {
	const parsed = mediaModelInputSchema.safeParse(input);
	return (
		parsed.success &&
		hasNoStrippedInputProperties(input, parsed.data) &&
		entry.inputKinds.includes(parsed.data.kind)
	);
}

function hasNoStrippedInputProperties(input: unknown, parsed: MediaModelInput): boolean {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const rawKeys = Object.keys(input);
	const parsedKeys = Object.keys(parsed);
	return (
		rawKeys.length === parsedKeys.length &&
		rawKeys.every((key) => Object.prototype.hasOwnProperty.call(parsed, key))
	);
}

export function createExecutableRouteGraph(options: ExecutableRouteGraphOptions): {
	entries: Array<CatalogEntry & { routes: readonly CatalogRoute[] }>;
	getEntry(key: ProductModelKey): (CatalogEntry & { routes: readonly CatalogRoute[] }) | undefined;
} {
	const entries = executableRouteGraph(Object.values(CATALOG), options).flatMap(
		({ entry, routes }) => {
			const imageSpecMatrix = executableImageSpecMatrix(entry.imageSpecMatrix, routes);
			if (entry.imageSpecMatrix && !imageSpecMatrix?.cells.length) return [];
			return [{ ...entry, routes, ...(imageSpecMatrix ? { imageSpecMatrix } : {}) }];
		},
	);
	return {
		entries,
		getEntry: (key) => entries.find((entry) => entry.key === key),
	};
}
export function quoteCatalogInput(input: unknown): {
	productKey: ProductModelKey;
	skuKey?: ImageSkuKey;
	credits: number;
	catalogVersion: string;
	pricingVersion: string;
} {
	const parsed = quoteInputSchema.parse(input);
	const entry = getCatalogEntry(parsed.productKey);
	if (!isCatalogInputSupported(entry, parsed.input))
		throw new Error(`Input ${parsed.input.kind} is not supported by ${parsed.productKey}`);
	const cell = selectedImageSpecCell(entry, parsed.input);
	if (entry.imageSpecMatrix && !cell) {
		throw new Error(`Invalid SKU for ${parsed.productKey}`);
	}
	if (cell) {
		assertImageSpecAspectRatio(cell, parsed.input);
		assertImageSpecControls(cell, parsed.input);
	}
	if (
		parsed.productKey === "video-quality" &&
		"durationSeconds" in parsed.input &&
		parsed.input.durationSeconds !== undefined &&
		![4, 6, 8].includes(parsed.input.durationSeconds)
	) {
		throw new Error("Quality video duration must be 4, 6, or 8 seconds");
	}
	return {
		productKey: parsed.productKey,
		...(cell ? { skuKey: cell.skuKey } : {}),
		credits: cell?.credits ?? entry.credits,
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
	};
}

export function getCatalogImageSpecCell(
	entry: Pick<CatalogEntry, "imageSpecMatrix">,
	skuKey: string | undefined,
): ImageSpecCell | undefined {
	return entry.imageSpecMatrix ? getImageSpecCell(entry.imageSpecMatrix, skuKey) : undefined;
}

function selectedImageSpecCell(
	entry: CatalogEntry,
	input: MediaModelInput,
): ImageSpecCell | undefined {
	if (!entry.imageSpecMatrix || input.kind !== "image-to-image") return undefined;
	return getImageSpecCell(entry.imageSpecMatrix, input.skuKey);
}

function assertImageSpecAspectRatio(cell: ImageSpecCell, input: MediaModelInput): void {
	if (
		input.kind !== "image-to-image" ||
		!input.aspectRatio ||
		!cell.aspectRatios.includes(input.aspectRatio)
	) {
		throw new Error(`Invalid aspect ratio for SKU ${cell.skuKey}`);
	}
}

function assertImageSpecControls(cell: ImageSpecCell, input: MediaModelInput): void {
	if (input.kind !== "image-to-image") return;
	if (input.strength !== undefined) {
		throw new Error(`Invalid strength for SKU ${cell.skuKey}`);
	}
	for (const [key, value, label] of [
		["outputFormat", input.outputFormat, "output format"],
		["background", input.background, "background"],
	] as const) {
		if (value === undefined) continue;
		const control = cell.controls?.find((candidate) => candidate.key === key);
		if (!control?.options.some((option) => option.key === value)) {
			throw new Error(`Invalid ${label} for SKU ${cell.skuKey}`);
		}
	}
}

function executableImageSpecMatrix(
	matrix: ImageSpecMatrix | undefined,
	executableRoutes: readonly CatalogRoute[],
): ImageSpecMatrix | undefined {
	if (!matrix) return undefined;
	return {
		...matrix,
		cells: matrix.cells.flatMap((cell) => {
			const routes = cell.routes.filter((route) =>
				executableRoutes.some((candidate) => sameCatalogRoute(route, candidate)),
			);
			return routes.length ? [{ ...cell, routes }] : [];
		}),
	};
}

function sameCatalogRoute(left: CatalogRoute, right: CatalogRoute): boolean {
	return (
		left.provider === right.provider &&
		left.providerModelId === right.providerModelId &&
		left.providerCostMicros === right.providerCostMicros &&
		left.weight === right.weight
	);
}
