import { getCatalogEntry, quoteCatalogInput, type MediaModelInput } from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG, type ProductModelKey } from "@repo/config";

export function buildMediaQuote(input: { productKey: ProductModelKey; input: MediaModelInput }) {
	if (!DEFAULT_PRODUCT_CONFIG.features.mediaGeneration) throw new Error("MODEL_DISABLED");
	const quote = quoteCatalogInput(input);
	const entry = getCatalogEntry(input.productKey);
	const route = entry.routes[0];
	if (!route) throw new Error("PROVIDER_UNAVAILABLE");
	if (route.providerCostMicros > DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros) {
		throw new Error("PROVIDER_UNAVAILABLE");
	}
	return {
		...quote,
		credits: BigInt(quote.credits),
		costMicros: BigInt(route.providerCostMicros),
		pricingSnapshot: {
			credits: quote.credits,
			maximumJobCostMicros: DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros,
		},
	};
}
