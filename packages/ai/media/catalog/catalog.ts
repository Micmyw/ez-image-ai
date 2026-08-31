import { DEFAULT_PRODUCT_CONFIG, type ProductModelKey } from "@repo/config";
import { z } from "zod";

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
}

const CATALOG: Record<ProductModelKey, CatalogEntry> = {
	"image-fast": {
		key: "image-fast",
		label: "Standard Edit",
		description: "Private prompt-based image editing for everyday changes",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: 4,
		routes: [
			{
				provider: "replicate",
				providerModelId: "black-forest-labs/flux-schnell",
				providerCostMicros: 3_000,
				weight: 80,
			},
			{
				provider: "fal",
				providerModelId: "fal-ai/flux/schnell",
				providerCostMicros: 3_500,
				weight: 20,
			},
			{
				provider: "openrouter",
				providerModelId: "sourceful/riverflow-v2.5-fast",
				providerCostMicros: 21_000,
				weight: 100,
			},
		],
	},
	"image-quality": {
		key: "image-quality",
		label: "Quality Edit",
		description: "Higher-fidelity private image editing for detailed changes",
		mediaKind: "image",
		inputKinds: ["image-to-image"],
		credits: 10,
		routes: [
			{
				provider: "gemini",
				providerModelId: "gemini-2.5-flash-image",
				providerCostMicros: 8_000,
				weight: 100,
			},
			{
				provider: "openrouter",
				providerModelId: "sourceful/riverflow-v2.5-pro",
				providerCostMicros: 170_000,
				weight: 100,
			},
		],
	},
	"video-fast": {
		key: "video-fast",
		label: "Fast Video",
		description: "Short video generation",
		mediaKind: "video",
		inputKinds: ["text-to-video", "image-to-video"],
		credits: 25,
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
		credits: 60,
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
	productKey: z.enum(["image-fast", "image-quality", "video-fast", "video-quality"]),
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
	const entries = executableRouteGraph(Object.values(CATALOG), options).map(
		({ entry, routes }) => ({
			...entry,
			routes,
		}),
	);
	return {
		entries,
		getEntry: (key) => entries.find((entry) => entry.key === key),
	};
}
export function quoteCatalogInput(input: unknown): {
	productKey: ProductModelKey;
	credits: number;
	catalogVersion: string;
	pricingVersion: string;
} {
	const parsed = quoteInputSchema.parse(input);
	const entry = getCatalogEntry(parsed.productKey);
	if (!isCatalogInputSupported(entry, parsed.input))
		throw new Error(`Input ${parsed.input.kind} is not supported by ${parsed.productKey}`);
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
		credits: entry.credits,
		catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
	};
}
