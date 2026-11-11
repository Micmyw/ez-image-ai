import { IMAGE_SKU_CREDIT_COSTS, type ImageOutputFormat, type ImageSkuKey } from "./product";

export function isGptImage26Sku(skuKey: string): boolean {
	return /^gpt-image-2-6-(flare|sunburst)-(1k|2k|4k)$/.test(skuKey);
}

/** Relative sprite-sheet area for the supported 512px GIF frames (Kie schema). */
export function imageGifSheetUnits(frameCount = 9): number {
	if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16)
		throw new Error("GIF frame count must be an integer from 2 to 16");
	return frameCount <= 8 ? 2 : frameCount === 9 ? 2.25 : frameCount <= 12 ? 3 : 4;
}

/** Fixed retail credits, frozen at quote time; never a pass-through token bill. */
export function getImageGenerationCredits(input: {
	skuKey: ImageSkuKey;
	outputFormat?: ImageOutputFormat;
	frameCount?: number;
}): number {
	const base = IMAGE_SKU_CREDIT_COSTS[input.skuKey];
	if (!isGptImage26Sku(input.skuKey)) return base;
	if (input.outputFormat === "svg") return base + 20;
	if (input.outputFormat === "gif") return Math.ceil(base * imageGifSheetUnits(input.frameCount));
	return base;
}
