import { describe, expect, it } from "vitest";

import { buildMediaQuote } from "./quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

describe("Kie image SKU quotes", () => {
	it.each([
		["image-nano-banana-2-lite", "nano-banana-2-lite-1k", 5n, 20_000n],
		["image-nano-banana", "nano-banana-default", 5n, 20_000n],
		["image-nano-banana-2", "nano-banana-2-1k", 9n, 40_000n],
		["image-nano-banana-2", "nano-banana-2-2k", 13n, 60_000n],
		["image-nano-banana-2", "nano-banana-2-4k", 19n, 90_000n],
		["image-nano-banana-pro", "nano-banana-pro-1k", 19n, 90_000n],
		["image-nano-banana-pro", "nano-banana-pro-2k", 19n, 90_000n],
		["image-nano-banana-pro", "nano-banana-pro-4k", 25n, 120_000n],
		["image-gpt-image-1-5", "gpt-image-1-5-medium", 5n, 20_000n],
		["image-gpt-image-1-5", "gpt-image-1-5-high", 23n, 110_000n],
		["image-gpt-image-2", "gpt-image-2-1k", 7n, 30_000n],
		["image-gpt-image-2", "gpt-image-2-2k", 11n, 50_000n],
		["image-gpt-image-2", "gpt-image-2-4k", 17n, 80_000n],
		["image-seedream-4-5", "seedream-4-5-basic-2k", 8n, 32_500n],
		["image-seedream-4-5", "seedream-4-5-high-4k", 8n, 32_500n],
		["image-seedream-5-lite", "seedream-5-lite-basic-2k", 7n, 27_500n],
		["image-seedream-5-lite", "seedream-5-lite-high-3k", 7n, 27_500n],
		["image-seedream-5-lite", "seedream-5-lite-ultra-4k", 7n, 27_500n],
		["image-seedream-5-pro", "seedream-5-pro-basic-1k", 8n, 35_000n],
		["image-seedream-5-pro", "seedream-5-pro-high-2k", 15n, 70_000n],
	] as const)(
		"freezes exact credits and route cost for %s / %s",
		(productKey, skuKey, credits, costMicros) => {
			const quote = buildMediaQuote(
				{
					productKey,
					input: {
						kind: "image-to-image",
						prompt: "A studio product photo",
						sourceAssetId: SOURCE_ASSET_ID,
						skuKey,
						aspectRatio: "3:2",
					},
				} as never,
				{
					enabledProviders: new Set(["kie"]),
					generationEnabled: true,
					kieImageCertifiedCatalogVersions: new Set(["2026-09-07.2"]),
				} as never,
			);

			expect(quote).toMatchObject({ skuKey, credits, costMicros });
			expect(quote.pricingSnapshot).toMatchObject({
				skuKey,
				credits: Number(credits),
				settlementPolicy: {
					unitCredits: credits.toString(),
					requestedOutputCount: 1,
					maxCharge: credits.toString(),
				},
				routeGraph: {
					maximumRouteCostMicros: Number(costMicros),
					allowedRoutes: [
						expect.objectContaining({ provider: "kie", providerCostMicros: Number(costMicros) }),
					],
				},
			});
		},
	);
});
