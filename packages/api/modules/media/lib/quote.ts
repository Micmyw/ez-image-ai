import {
	createExecutableRouteGraph,
	createRouteGraphSnapshot,
	executableRouteGraphOptionsFromEnvironment,
	parseRouteGraphSnapshot,
	quoteCatalogInput,
	type ExecutableRouteGraphOptions,
	type MediaModelInput,
} from "@repo/ai";
import { DEFAULT_PRODUCT_CONFIG, type ProductModelKey } from "@repo/config";
import type { Prisma } from "@repo/database";

export function buildMediaQuote(
	input: { productKey: ProductModelKey; input: MediaModelInput },
	routeGraphOptions: ExecutableRouteGraphOptions = executableRouteGraphOptionsFromEnvironment(),
) {
	if (!DEFAULT_PRODUCT_CONFIG.features.mediaGeneration) throw new Error("MODEL_DISABLED");
	const quote = quoteCatalogInput(input);
	const entry = createExecutableRouteGraph(routeGraphOptions).getEntry(input.productKey);
	if (!entry) throw new Error("PROVIDER_UNAVAILABLE");
	const maximumRouteCostMicros = Math.max(...entry.routes.map((route) => route.providerCostMicros));
	if (maximumRouteCostMicros > DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros) {
		throw new Error("PROVIDER_UNAVAILABLE");
	}
	const routeGraph = createRouteGraphSnapshot({
		productKey: quote.productKey,
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		routes: entry.routes,
	});
	const routeGraphSnapshot: Prisma.InputJsonObject = {
		allowedRoutes: routeGraph.allowedRoutes.map((route) => ({
			provider: route.provider,
			providerModelId: route.providerModelId,
			providerCostMicros: route.providerCostMicros,
			weight: route.weight,
		})),
		graphFingerprint: routeGraph.graphFingerprint,
		maximumRouteCostMicros: routeGraph.maximumRouteCostMicros,
	};
	const pricingSnapshot: Prisma.InputJsonObject = {
		credits: quote.credits,
		maximumJobCostMicros: DEFAULT_PRODUCT_CONFIG.budgets.maximumJobCostMicros,
		routeGraph: routeGraphSnapshot,
		settlementPolicy: {
			unitCredits: quote.credits.toString(),
			requestedOutputCount: 1,
			maxCharge: quote.credits.toString(),
		},
	};
	return {
		...quote,
		credits: BigInt(quote.credits),
		costMicros: BigInt(maximumRouteCostMicros),
		pricingSnapshot,
	};
}

/**
 * A quote freezes its provider/model routes. If configuration removes every frozen route,
 * the user must requote rather than reserve credits for a later manual-recovery job.
 */
export function assertFrozenQuoteRouteGraphIsCurrent(
	quote: {
		productKey: ProductModelKey;
		catalogVersion: string;
		pricingVersion: string;
		pricingSnapshot: unknown;
	},
	routeGraphOptions: ExecutableRouteGraphOptions,
): void {
	const pricingSnapshot = objectRecord(quote.pricingSnapshot);
	const routeGraph = parseRouteGraphSnapshot({
		productKey: quote.productKey,
		catalogVersion: quote.catalogVersion,
		pricingVersion: quote.pricingVersion,
		routeGraph: pricingSnapshot?.routeGraph,
	});
	const currentEntry = createExecutableRouteGraph(routeGraphOptions).getEntry(quote.productKey);
	if (!routeGraph || !currentEntry) throw new Error("PRICE_CHANGED");
	const hasCurrentFrozenRoute = routeGraph.allowedRoutes.some((frozenRoute) =>
		currentEntry.routes.some(
			(currentRoute) =>
				currentRoute.provider === frozenRoute.provider &&
				currentRoute.providerModelId === frozenRoute.providerModelId,
		),
	);
	if (!hasCurrentFrozenRoute) throw new Error("PRICE_CHANGED");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
