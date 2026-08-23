import type { ProviderKey } from "../types";

export interface CatalogRoute {
	provider: ProviderKey;
	providerModelId: string;
	providerCostMicros: number;
	weight: number;
}

export interface ExecutableRouteGraphOptions {
	enabledProviders: ReadonlySet<ProviderKey>;
}

export interface ExecutableCatalogRouteGraphEntry<T extends { routes: readonly CatalogRoute[] }> {
	entry: T;
	routes: readonly CatalogRoute[];
}

export function enabledProviderKeysFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ReadonlySet<ProviderKey> {
	if (environment.NODE_ENV === "test") {
		return new Set<ProviderKey>(["replicate", "fal", "kie", "gemini"]);
	}
	const enabled = new Set<ProviderKey>();
	if (environment.REPLICATE_API_TOKEN) enabled.add("replicate");
	if (environment.FAL_API_KEY) enabled.add("fal");
	if (environment.KIE_API_KEY) enabled.add("kie");
	if (environment.GEMINI_API_KEY) enabled.add("gemini");
	return enabled;
}

export function executableRouteGraph<T extends { routes: readonly CatalogRoute[] }>(
	entries: readonly T[],
	options: ExecutableRouteGraphOptions,
): ExecutableCatalogRouteGraphEntry<T>[] {
	return entries.flatMap((entry) => {
		const routes = entry.routes.filter((route) => options.enabledProviders.has(route.provider));
		return routes.length > 0 ? [{ entry, routes }] : [];
	});
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
