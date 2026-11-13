import { describe, expect, it } from "vitest";

import {
	createExecutableRouteGraph,
	getCatalogEntry,
	getPublicProductCatalog,
	quoteCatalogInput,
} from "./catalog";
import { textImageRoutes } from "./image-input-routes";
import {
	configuredRouteGraphOptionsFromEnvironment,
	createRouteGraphSnapshot,
	parseRouteGraphSnapshot,
} from "./routing";

describe("Seedream 5.5 pricing and routing", () => {
	it.each([
		["seedream-5-5-1k", 8, 18_000, 25_200],
		["seedream-5-5-1-5k", 12, 18_000, 25_200],
		["seedream-5-5-2k", 20, 31_500, 38_700],
	] as const)(
		"%s keeps the first reference charge out of text-only quotes",
		(skuKey, credits, textCost, editCost) => {
			const entry = getCatalogEntry("image-seedream-5-5");
			const cell = entry.imageSpecMatrix!.cells.find((candidate) => candidate.skuKey === skuKey)!;
			const originalRoutes = structuredClone(cell.routes);
			expect(cell.routes).toEqual([
				{
					provider: "kie",
					providerModelId: "seedream/5-5-image-to-image",
					providerCostMicros: editCost,
					weight: 100,
				},
			]);
			const textRoutes = textImageRoutes(cell.routes);
			expect(textRoutes).toEqual([
				{
					provider: "kie",
					providerModelId: "seedream/5-5-text-to-image",
					providerCostMicros: textCost,
					weight: 100,
				},
			]);
			expect(cell.routes).toEqual(originalRoutes);
			for (const kind of ["text-to-image", "image-to-image"] as const) {
				expect(
					quoteCatalogInput({
						productKey: entry.key,
						input: {
							kind,
							skuKey,
							prompt: "A bookshop",
							aspectRatio: "auto",
							...(kind === "image-to-image"
								? { sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP" }
								: {}),
						},
					}),
				).toMatchObject({ credits, skuKey });
				const snapshot = createRouteGraphSnapshot({
					productKey: entry.key,
					catalogVersion: "2026-11-13.2",
					pricingVersion: "2026-11-13.2",
					routes: kind === "text-to-image" ? textRoutes : cell.routes,
				});
				expect(
					parseRouteGraphSnapshot({
						routeGraph: snapshot,
						productKey: entry.key,
						catalogVersion: "2026-11-13.2",
						pricingVersion: "2026-11-13.2",
					})?.maximumRouteCostMicros,
				).toBe(kind === "text-to-image" ? textCost : editCost);
			}
		},
	);

	it("registers both execution routes and removes supplier data from the public catalog", () => {
		const options = { enabledProviders: new Set(["kie"] as const), generationEnabled: true };
		const entry = createExecutableRouteGraph(options).getEntry("image-seedream-5-5")!;
		expect(new Set(entry.routes.map((route) => route.providerModelId))).toEqual(
			new Set(["seedream/5-5-image-to-image", "seedream/5-5-text-to-image"]),
		);
		const publicEntry = getPublicProductCatalog(options).products.find(
			(product) => product.key === "image-seedream-5-5",
		);
		expect(publicEntry?.skuMatrix?.cells.map((cell) => cell.credits)).toEqual([8, 12, 20]);
		expect(JSON.stringify(publicEntry)).not.toMatch(
			/providerCostMicros|providerModelId|apiKey|seedream-5-5\//,
		);
	});

	it("requires the explicit model switch and honors its kill switch", () => {
		const environment = {
			NODE_ENV: "production",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
		};
		for (const enabled of [undefined, "false", "true"] as const) {
			const options = configuredRouteGraphOptionsFromEnvironment({
				...environment,
				MEDIA_SEEDREAM_5_5_IMAGE_ENABLED: enabled,
			});
			expect(Boolean(createExecutableRouteGraph(options).getEntry("image-seedream-5-5"))).toBe(
				enabled === "true",
			);
		}
	});
});
