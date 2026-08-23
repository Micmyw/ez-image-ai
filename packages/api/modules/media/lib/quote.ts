import {
	createExecutableRouteGraph,
	enabledProviderKeysFromEnvironment,
	quoteCatalogInput,
	type MediaModelInput,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG, type ProductModelKey } from "@repo/config";

export function buildMediaQuote(input: { productKey: ProductModelKey; input: MediaModelInput }) {
	if (!DEFAULT_PRODUCT_CONFIG.features.mediaGeneration) throw new Error("MODEL_DISABLED");
	const quote = quoteCatalogInput(input);
	const entry = createExecutableRouteGraph({
		enabledProviders: enabledProviderKeysFromEnvironment(),
	}).getEntry(input.productKey);
	if (!entry) throw new Error("PROVIDER_UNAVAILABLE");
	const maximumRouteCostMicros = Math.max(...entry.routes.map((route) => route.providerCostMicros));
	if (maximumRouteCostMicros > DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros) {
		throw new Error("PROVIDER_UNAVAILABLE");
	}
	return {
		...quote,
		credits: BigInt(quote.credits),
		costMicros: BigInt(maximumRouteCostMicros),
		pricingSnapshot: {
			credits: quote.credits,
			maximumJobCostMicros: DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros,
			settlementPolicy: {
				unitCredits: quote.credits.toString(),
				requestedOutputCount: 1,
				maxCharge: quote.credits.toString(),
			},
		},
	};
}
