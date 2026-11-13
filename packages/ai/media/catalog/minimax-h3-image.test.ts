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

describe("MiniMax H3 Image pricing and routing", () => {
	it.each([
		["minimax-h3-1k", 5, 9_000, 11_500],
		["minimax-h3-2k", 10, 9_000, 11_500],
		["minimax-h3-4k", 20, 27_500, 30_000],
	] as const)(
		"%s keeps the first reference charge out of text-only quotes",
		(skuKey, credits, textCost, editCost) => {
			const entry = getCatalogEntry("image-minimax-h3");
			const cell = entry.imageSpecMatrix!.cells.find((candidate) => candidate.skuKey === skuKey)!;
			const originalRoutes = structuredClone(cell.routes);
			expect(cell.routes).toEqual([
				{
					provider: "kie",
					providerModelId: "minimax-h3/image-edit",
					providerCostMicros: editCost,
					weight: 100,
				},
			]);
			const textRoutes = textImageRoutes(cell.routes);
			expect(textRoutes).toEqual([
				{
					provider: "kie",
					providerModelId: "minimax-h3/text-to-image",
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
					catalogVersion: "2026-11-13.1",
					pricingVersion: "2026-11-13.1",
					routes: kind === "text-to-image" ? textRoutes : cell.routes,
				});
				expect(
					parseRouteGraphSnapshot({
						routeGraph: snapshot,
						productKey: entry.key,
						catalogVersion: "2026-11-13.1",
						pricingVersion: "2026-11-13.1",
					})?.maximumRouteCostMicros,
				).toBe(kind === "text-to-image" ? textCost : editCost);
			}
		},
	);

	it("registers both execution routes and removes supplier data from the public catalog", () => {
		const options = { enabledProviders: new Set(["kie"] as const), generationEnabled: true };
		const entry = createExecutableRouteGraph(options).getEntry("image-minimax-h3")!;
		expect(new Set(entry.routes.map((route) => route.providerModelId))).toEqual(
			new Set(["minimax-h3/image-edit", "minimax-h3/text-to-image"]),
		);
		const publicEntry = getPublicProductCatalog(options).products.find(
			(product) => product.key === "image-minimax-h3",
		);
		expect(publicEntry?.skuMatrix?.cells.map((cell) => cell.credits)).toEqual([5, 10, 20]);
		expect(JSON.stringify(publicEntry)).not.toMatch(
			/providerCostMicros|providerModelId|apiKey|minimax-h3\//,
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
				MEDIA_MINIMAX_H3_IMAGE_ENABLED: enabled,
			});
			expect(Boolean(createExecutableRouteGraph(options).getEntry("image-minimax-h3"))).toBe(
				enabled === "true",
			);
		}
	});
});
