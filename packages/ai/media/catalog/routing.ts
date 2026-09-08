import { createHash } from "node:crypto";

import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	isEzPicProductEnvironmentEnabled,
	parseMediaEnabledProviders,
	parseMediaRecoveryProviders,
} from "@repo/config";
import { z } from "zod";

import type { ProviderKey } from "../types";
import { staticDispatchRouteFor } from "./dispatch-manifest";
export {
	STATIC_DISPATCH_ROUTE_MANIFEST,
	staticDispatchRouteFor,
	type StaticDispatchRoute,
} from "./dispatch-manifest";

export interface CatalogRoute {
	provider: ProviderKey;
	providerModelId: string;
	providerCostMicros: number;
	weight: number;
}

export interface ExecutableRouteGraphOptions {
	enabledProviders: ReadonlySet<ProviderKey>;
	generationEnabled?: boolean;
	disabledProductKeys?: ReadonlySet<string>;
	openRouterImageRoutesCertified?: boolean;
	kieImageCertifiedCatalogVersions?: ReadonlySet<string>;
}

export interface ExecutableCatalogRouteGraphEntry<T extends { routes: readonly CatalogRoute[] }> {
	entry: T;
	routes: readonly CatalogRoute[];
}

export interface RouteGraphSnapshot {
	allowedRoutes: CatalogRoute[];
	graphFingerprint: string;
	maximumRouteCostMicros: number;
}

const catalogRouteSchema = z.object({
	provider: z.enum(["replicate", "fal", "kie", "gemini", "openrouter"]),
	providerModelId: z.string().min(1),
	providerCostMicros: z.number().int().nonnegative(),
	weight: z.number().finite().positive(),
});

const routeGraphSnapshotSchema = z.object({
	allowedRoutes: z.array(catalogRouteSchema).min(1),
	graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	maximumRouteCostMicros: z.number().int().nonnegative(),
});

/** Providers configured for new work. This is safe for API-side catalog and quote admission. */
export function configuredProviderKeysFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ReadonlySet<ProviderKey> {
	return new Set<ProviderKey>(parseMediaEnabledProviders(environment));
}

/**
 * Providers the current worker process can execute. Keep this separate from API admission so
 * web processes never need provider secrets merely to quote a configured stable route.
 */
export function locallyExecutableProviderKeysFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
	candidates: Iterable<ProviderKey> = configuredProviderKeysFromEnvironment(environment),
): ReadonlySet<ProviderKey> {
	return new Set<ProviderKey>(
		[...candidates].filter((provider) => providerHasWorkerCredential(provider, environment)),
	);
}

/** @deprecated Use configuredProviderKeysFromEnvironment for API graph construction. */
export function enabledProviderKeysFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ReadonlySet<ProviderKey> {
	return configuredProviderKeysFromEnvironment(environment);
}

export function recoveryProviderKeysFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ReadonlySet<ProviderKey> {
	return new Set<ProviderKey>(parseMediaRecoveryProviders(environment));
}

export function configuredRouteGraphOptionsFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ExecutableRouteGraphOptions {
	const disabledProductKeys = new Set<string>();
	for (const productKey of EZPIC_PRODUCT_KEYS) {
		if (!isEzPicProductEnvironmentEnabled(productKey, environment)) {
			disabledProductKeys.add(productKey);
		}
	}
	return {
		enabledProviders: configuredProviderKeysFromEnvironment(environment),
		generationEnabled: environment.MEDIA_GENERATION_ENABLED === "true",
		disabledProductKeys,
		openRouterImageRoutesCertified: environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED === "true",
		kieImageCertifiedCatalogVersions: new Set(
			(environment.MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS ?? "")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		),
	};
}

/** @deprecated This API graph helper now intentionally uses configured, not local, providers. */
export function executableRouteGraphOptionsFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ExecutableRouteGraphOptions {
	return configuredRouteGraphOptionsFromEnvironment(environment);
}

export function isStaticDispatchRoute(
	mediaKind: "image" | "video",
	provider: ProviderKey,
	providerModelId: string,
): boolean {
	return Boolean(staticDispatchRouteFor(mediaKind, provider, providerModelId));
}

export function createRouteGraphSnapshot(input: {
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	routes: readonly CatalogRoute[];
}): RouteGraphSnapshot {
	const allowedRoutes = canonicalRoutes(input.routes);
	if (allowedRoutes.length === 0) throw new Error("Route graph cannot be empty");
	const maximumRouteCostMicros = Math.max(
		...allowedRoutes.map((route) => route.providerCostMicros),
	);
	return {
		allowedRoutes,
		maximumRouteCostMicros,
		graphFingerprint: routeGraphFingerprint({
			productKey: input.productKey,
			catalogVersion: input.catalogVersion,
			pricingVersion: input.pricingVersion,
			allowedRoutes,
			maximumRouteCostMicros,
		}),
	};
}

export function parseRouteGraphSnapshot(input: {
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	routeGraph: unknown;
}): RouteGraphSnapshot | null {
	const parsed = routeGraphSnapshotSchema.safeParse(input.routeGraph);
	if (!parsed.success) return null;
	const allowedRoutes = canonicalRoutes(parsed.data.allowedRoutes);
	const maximumRouteCostMicros = Math.max(
		...allowedRoutes.map((route) => route.providerCostMicros),
	);
	if (maximumRouteCostMicros !== parsed.data.maximumRouteCostMicros) return null;
	const graphFingerprint = routeGraphFingerprint({
		productKey: input.productKey,
		catalogVersion: input.catalogVersion,
		pricingVersion: input.pricingVersion,
		allowedRoutes,
		maximumRouteCostMicros,
	});
	if (graphFingerprint !== parsed.data.graphFingerprint) return null;
	return { allowedRoutes, maximumRouteCostMicros, graphFingerprint };
}

export function executableRouteGraph<
	T extends { key: string; mediaKind: "image" | "video"; routes: readonly CatalogRoute[] },
>(
	entries: readonly T[],
	options: ExecutableRouteGraphOptions,
): ExecutableCatalogRouteGraphEntry<T>[] {
	return entries.flatMap((entry) => {
		if (options.generationEnabled === false || options.disabledProductKeys?.has(entry.key)) {
			return [];
		}
		const routes = entry.routes.filter(
			(route) =>
				options.enabledProviders.has(route.provider) &&
				(route.provider !== "openrouter" || options.openRouterImageRoutesCertified === true) &&
				(route.provider !== "kie" ||
					entry.mediaKind !== "image" ||
					options.kieImageCertifiedCatalogVersions?.has(DEFAULT_PRODUCT_CONFIG.catalogVersion) ===
						true) &&
				isStaticDispatchRoute(entry.mediaKind, route.provider, route.providerModelId),
		);
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

function canonicalRoutes(routes: readonly CatalogRoute[]): CatalogRoute[] {
	return routes
		.map((route) => catalogRouteSchema.parse(route))
		.sort((left, right) => {
			const provider = left.provider.localeCompare(right.provider);
			if (provider !== 0) return provider;
			const model = left.providerModelId.localeCompare(right.providerModelId);
			if (model !== 0) return model;
			const cost = left.providerCostMicros - right.providerCostMicros;
			return cost !== 0 ? cost : left.weight - right.weight;
		});
}

function routeGraphFingerprint(input: {
	productKey: string;
	catalogVersion: string;
	pricingVersion: string;
	allowedRoutes: readonly CatalogRoute[];
	maximumRouteCostMicros: number;
}): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function providerHasWorkerCredential(
	provider: ProviderKey,
	environment: Record<string, string | undefined>,
): boolean {
	switch (provider) {
		case "replicate":
			return Boolean(environment.REPLICATE_API_TOKEN);
		case "fal":
			return Boolean(environment.FAL_API_KEY);
		case "kie":
			return Boolean(environment.KIE_API_KEY);
		case "gemini":
			return Boolean(environment.GEMINI_API_KEY);
		case "openrouter":
			return Boolean(environment.OPENROUTER_API_KEY);
	}
}
