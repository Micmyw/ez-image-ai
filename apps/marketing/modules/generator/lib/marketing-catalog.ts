import { getCatalogEntry } from "@repo/ai";
import { EZPIC_PRODUCT_KEYS } from "@repo/config";

export type MarketingImageModes = Record<
	(typeof EZPIC_PRODUCT_KEYS)[number],
	{ label: string; credits: number }
>;

export function getMarketingImageModes(): MarketingImageModes {
	return Object.fromEntries(
		EZPIC_PRODUCT_KEYS.map((productKey) => {
			const entry = getCatalogEntry(productKey);
			if (entry.mediaKind !== "image" || !entry.inputKinds.includes("image-to-image")) {
				throw new Error(`Invalid marketing image product: ${productKey}`);
			}
			return [productKey, { label: entry.label, credits: entry.credits }];
		}),
	) as MarketingImageModes;
}
