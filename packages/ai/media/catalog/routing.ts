import type { ProviderKey } from "../types";

export interface CatalogRoute {
	provider: ProviderKey;
	providerModelId: string;
	providerCostMicros: number;
	weight: number;
}

export function chooseCatalogRoute(
	routes: readonly CatalogRoute[],
	randomValue = Math.random(),
): CatalogRoute {
	const totalWeight = routes.reduce((sum, route) => sum + route.weight, 0);
	let cursor = randomValue * totalWeight;
	for (const route of routes) {
		cursor -= route.weight;
		if (cursor < 0) return route;
	}
	return routes[routes.length - 1]!;
}
