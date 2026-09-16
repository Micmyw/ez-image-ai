import { getCatalogEntry } from "@repo/ai";
import type { ProductModelKey } from "@repo/config";
import { describe, expect, it } from "vitest";

import officialContracts from "../../../../ai/media/providers/fixtures/kie-official-image-contracts-2026-09-14.json";
import { assertFrozenQuoteRouteGraphIsCurrent, buildMediaQuote } from "./quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";
const NANO_QUOTE_INPUT = {
	productKey: "image-nano-banana-2-lite" as const,
	input: {
		kind: "image-to-image" as const,
		prompt: "A studio product photo",
		sourceAssetId: SOURCE_ASSET_ID,
		skuKey: "nano-banana-2-lite-1k" as const,
		aspectRatio: "auto" as const,
	},
};
const KIE_ROUTE_OPTIONS = {
	enabledProviders: new Set(["kie" as const]),
	generationEnabled: true,
};

describe("buildMediaQuote", () => {
	it("freezes the disclosed first-block-free output billing policy for new jobs", () => {
		expect(buildMediaQuote(NANO_QUOTE_INPUT, KIE_ROUTE_OPTIONS).pricingSnapshot).toMatchObject({
			outputModerationBillingPolicy: "first-block-free-v1",
		});
	});
	it("freezes the exact documented Kie model and selected SKU for all 29 image outputs", () => {
		let count = 0;
		for (const official of officialContracts.products) {
			const productKey = official.productKey as ProductModelKey;
			for (const cell of getCatalogEntry(productKey).imageSpecMatrix!.cells) {
				const quote = buildMediaQuote(
					{
						productKey,
						input: {
							...NANO_QUOTE_INPUT.input,
							skuKey: cell.skuKey,
							aspectRatio: cell.aspectRatios[0]!,
						},
					},
					KIE_ROUTE_OPTIONS,
				);
				expect(quote.pricingSnapshot).toMatchObject({
					skuKey: cell.skuKey,
					credits: cell.credits,
					routeGraph: {
						allowedRoutes: [{ provider: "kie", providerModelId: official.providerModelId }],
					},
					settlementPolicy: { requestedOutputCount: 1, maxCharge: cell.credits.toString() },
				});
				count++;
			}
		}
		expect(count).toBe(29);
	});

	it("persists a deterministic per-output settlement policy in the pricing snapshot", () => {
		const quote = buildMediaQuote(NANO_QUOTE_INPUT, KIE_ROUTE_OPTIONS);

		expect(quote.pricingSnapshot).toMatchObject({
			skuKey: "nano-banana-2-lite-1k",
			credits: 5,
			maximumJobCostMicros: 5_000_000,
			settlementPolicy: {
				unitCredits: "5",
				requestedOutputCount: 1,
				maxCharge: "5",
			},
		});
	});

	it("reserves the selected SKU provider ceiling", () => {
		const quote = buildMediaQuote(NANO_QUOTE_INPUT, KIE_ROUTE_OPTIONS);

		expect(quote.costMicros).toBe(20_000n);
	});

	it("locks the quote to the routes enabled by the shared API configuration", () => {
		const previous = process.env.MEDIA_ENABLED_PROVIDERS;
		process.env.MEDIA_ENABLED_PROVIDERS = "kie";
		try {
			const quote = buildMediaQuote(NANO_QUOTE_INPUT);

			expect(quote.costMicros).toBe(20_000n);
			expect(quote.pricingSnapshot).toMatchObject({
				routeGraph: {
					graphFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					maximumRouteCostMicros: 20_000,
					allowedRoutes: [
						{
							provider: "kie",
							providerModelId: "nano-banana-2-lite",
							providerCostMicros: 20_000,
						},
					],
				},
			});
		} finally {
			if (previous === undefined) delete process.env.MEDIA_ENABLED_PROVIDERS;
			else process.env.MEDIA_ENABLED_PROVIDERS = previous;
		}
	});

	it("quotes a configured provider without requiring the API process to hold its worker credential", () => {
		const previousEnabledProviders = process.env.MEDIA_ENABLED_PROVIDERS;
		const previousKieKey = process.env.KIE_API_KEY;
		process.env.MEDIA_ENABLED_PROVIDERS = "kie";
		delete process.env.KIE_API_KEY;
		try {
			expect(buildMediaQuote(NANO_QUOTE_INPUT)).toMatchObject({ costMicros: 20_000n });
		} finally {
			if (previousEnabledProviders === undefined) delete process.env.MEDIA_ENABLED_PROVIDERS;
			else process.env.MEDIA_ENABLED_PROVIDERS = previousEnabledProviders;
			if (previousKieKey === undefined) delete process.env.KIE_API_KEY;
			else process.env.KIE_API_KEY = previousKieKey;
		}
	});

	it("requires a requote when no frozen provider/model route remains executable", () => {
		const frozenQuote = buildMediaQuote(NANO_QUOTE_INPUT, KIE_ROUTE_OPTIONS);

		expect(() =>
			assertFrozenQuoteRouteGraphIsCurrent(
				{
					productKey: frozenQuote.productKey,
					catalogVersion: frozenQuote.catalogVersion,
					pricingVersion: frozenQuote.pricingVersion,
					pricingSnapshot: frozenQuote.pricingSnapshot,
				},
				{ enabledProviders: new Set(["fal"]), generationEnabled: true },
			),
		).toThrow("PRICE_CHANGED");
	});
});
