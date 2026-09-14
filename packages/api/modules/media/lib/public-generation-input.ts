import { mediaModelInputSchema } from "@repo/ai";
import {
	EZPIC_PRODUCT_KEYS,
	isEzPicProductKey,
	parseImageSelection,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "@repo/config";

export type CurrentEzPicProductKey = (typeof EZPIC_PRODUCT_KEYS)[number];

const currentEzPicProductKeys = new Set<string>(EZPIC_PRODUCT_KEYS);

export interface PublicImageGenerationInput {
	kind: "image-to-image" | "text-to-image";
	prompt: string;
	sourceAssetId: string | null;
	skuKey: ImageSkuKey | null;
	aspectRatio: ImageAspectRatio | null;
	outputFormat: ImageOutputFormat | null;
	background: ImageBackground | null;
}

export function isCurrentEzPicProductKey(value: string): value is CurrentEzPicProductKey {
	return currentEzPicProductKeys.has(value);
}

export function isValidCurrentEzPicImageSelection(productKey: string, value: unknown): boolean {
	if (!isCurrentEzPicProductKey(productKey)) return false;
	const input = mediaModelInputSchema.safeParse(value);
	if (!input.success || !["image-to-image", "text-to-image"].includes(input.data.kind))
		return false;
	if ("strength" in input.data && input.data.strength !== undefined) return false;
	if ("width" in input.data || "height" in input.data) return false;
	return parseImageSelection(productKey, input.data) !== null;
}

/**
 * Projects a durable job input into the small browser-safe image contract.
 * Route snapshots, provider identifiers, costs, and unknown legacy fields are
 * intentionally discarded rather than copied from JSON stored in PostgreSQL.
 */
export function publicImageGenerationInput(
	rawProductKey: string,
	value: unknown,
): PublicImageGenerationInput | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (input.kind !== "image-to-image" && input.kind !== "text-to-image") return null;

	const selection = isEzPicProductKey(rawProductKey)
		? parseImageSelection(rawProductKey, input)
		: null;

	return {
		kind: input.kind,
		prompt: typeof input.prompt === "string" ? input.prompt : "",
		sourceAssetId:
			input.kind === "image-to-image" && typeof input.sourceAssetId === "string"
				? input.sourceAssetId
				: null,
		skuKey: selection?.skuKey ?? null,
		aspectRatio: selection?.aspectRatio ?? null,
		outputFormat: selection?.outputFormat ?? null,
		background: selection?.background ?? null,
	};
}
