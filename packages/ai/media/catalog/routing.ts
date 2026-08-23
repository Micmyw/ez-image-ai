import { createHash } from "node:crypto";

import { parseMediaEnabledProviders, parseMediaRecoveryProviders } from "@repo/config";
import { z } from "zod";

import type { ProviderKey } from "../types";

export interface CatalogRoute {
	provider: ProviderKey;
	providerModelId: string;
	providerCostMicros: number;
	weight: number;
}

export interface StaticDispatchRoute {
	mediaKind: "image" | "video";
	provider: ProviderKey;
	providerModelId: string;
	taskId: string;
	queueName: string;
}

export interface ExecutableRouteGraphOptions {
	enabledProviders: ReadonlySet<ProviderKey>;
	generationEnabled?: boolean;
	disabledProductKeys?: ReadonlySet<string>;
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
	provider: z.enum(["replicate", "fal", "kie", "gemini"]),
	providerModelId: z.string().min(1),
	providerCostMicros: z.number().int().nonnegative(),
	weight: z.number().finite().positive(),
});

const routeGraphSnapshotSchema = z.object({
	allowedRoutes: z.array(catalogRouteSchema).min(1),
	graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	maximumRouteCostMicros: z.number().int().nonnegative(),
});

/**
 * Only these tuples have a deployed Trigger task. Keep retired entries here until their
 * outstanding jobs have drained; new submission never fabricates a task identifier.
 */
export const STATIC_DISPATCH_ROUTE_MANIFEST = [
	{
		mediaKind: "image",
		provider: "replicate",
		providerModelId: "black-forest-labs/flux-schnell",
		taskId: "media-dispatch-image-replicate-black-forest-labs_flux-schnell",
		queueName: "media-image-replicate-black-forest-labs_flux-schnell",
	},
	{
		mediaKind: "image",
		provider: "fal",
		providerModelId: "fal-ai/flux/schnell",
		taskId: "media-dispatch-image-fal-fal-ai_flux-schnell",
		queueName: "media-image-fal-fal-ai_flux-schnell",
	},
	{
		mediaKind: "image",
		provider: "gemini",
		providerModelId: "gemini-2.5-flash-image",
		taskId: "media-dispatch-image-gemini-gemini-2.5-flash-image",
		queueName: "media-image-gemini-gemini-2.5-flash-image",
	},
	{
		mediaKind: "video",
		provider: "fal",
		providerModelId: "fal-ai/fast-video",
		taskId: "media-dispatch-video-fal-fal-ai_fast-video",
		queueName: "media-video-fal-fal-ai_fast-video",
	},
	{
		mediaKind: "video",
		provider: "kie",
		providerModelId: "veo3",
		taskId: "media-dispatch-video-kie-veo3",
		queueName: "media-video-kie-veo3",
	},
] as const satisfies readonly StaticDispatchRoute[];

const staticDispatchRoutes = new Map(
	STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => [dispatchRouteKey(route), route]),
);

if (staticDispatchRoutes.size !== STATIC_DISPATCH_ROUTE_MANIFEST.length) {
	throw new Error("Static dispatch route manifest has duplicate tuples");
}
if (
	new Set(STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => route.taskId)).size !==
	staticDispatchRoutes.size
) {
	throw new Error("Static dispatch route manifest has duplicate task IDs");
}

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
	return {
		enabledProviders: configuredProviderKeysFromEnvironment(environment),
		generationEnabled: environment.MEDIA_GENERATION_ENABLED === "true",
	};
}

/** @deprecated This API graph helper now intentionally uses configured, not local, providers. */
export function executableRouteGraphOptionsFromEnvironment(
	environment: Record<string, string | undefined> = process.env,
): ExecutableRouteGraphOptions {
	return configuredRouteGraphOptionsFromEnvironment(environment);
}

export function staticDispatchRouteFor(
	mediaKind: "image" | "video",
	provider: ProviderKey,
	providerModelId: string,
): StaticDispatchRoute | undefined {
	return staticDispatchRoutes.get(dispatchRouteKey({ mediaKind, provider, providerModelId }));
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
	}
}

function dispatchRouteKey(input: {
	mediaKind: "image" | "video";
	provider: ProviderKey;
	providerModelId: string;
}): string {
	return `${input.mediaKind}:${input.provider}:${input.providerModelId}`;
}
