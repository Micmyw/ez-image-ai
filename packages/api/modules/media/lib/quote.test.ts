import { describe, expect, it } from "vitest";

import { assertFrozenQuoteRouteGraphIsCurrent, buildMediaQuote } from "./quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

describe("buildMediaQuote", () => {
	it("persists a deterministic per-output settlement policy in the pricing snapshot", () => {
		const quote = buildMediaQuote({
			productKey: "image-fast",
			input: {
				kind: "image-to-image",
				prompt: "test prompt",
				sourceAssetId: SOURCE_ASSET_ID,
			},
		});

		expect(quote.pricingSnapshot).toMatchObject({
			credits: 4,
			maximumJobCostMicros: 5_000_000,
			settlementPolicy: {
				unitCredits: "4",
				requestedOutputCount: 1,
				maxCharge: "4",
			},
		});
	});

	it("reserves for the highest executable route cost rather than only the first route", () => {
		const quote = buildMediaQuote({
			productKey: "image-fast",
			input: {
				kind: "image-to-image",
				prompt: "A studio product photo",
				sourceAssetId: SOURCE_ASSET_ID,
			},
		});

		expect(quote.costMicros).toBe(3_500n);
	});

	it("locks the quote to the routes enabled by the shared API configuration", () => {
		const previous = process.env.MEDIA_ENABLED_PROVIDERS;
		process.env.MEDIA_ENABLED_PROVIDERS = "replicate";
		try {
			const quote = buildMediaQuote({
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			});

			expect(quote.costMicros).toBe(3_000n);
			expect(quote.pricingSnapshot).toMatchObject({
				routeGraph: {
					graphFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					maximumRouteCostMicros: 3_000,
					allowedRoutes: [
						{
							provider: "replicate",
							providerModelId: "black-forest-labs/flux-schnell",
							providerCostMicros: 3_000,
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
		const previousReplicateToken = process.env.REPLICATE_API_TOKEN;
		process.env.MEDIA_ENABLED_PROVIDERS = "replicate";
		delete process.env.REPLICATE_API_TOKEN;
		try {
			expect(
				buildMediaQuote({
					productKey: "image-fast",
					input: {
						kind: "image-to-image",
						prompt: "A studio product photo",
						sourceAssetId: SOURCE_ASSET_ID,
					},
				}),
			).toMatchObject({ costMicros: 3_000n });
		} finally {
			if (previousEnabledProviders === undefined) delete process.env.MEDIA_ENABLED_PROVIDERS;
			else process.env.MEDIA_ENABLED_PROVIDERS = previousEnabledProviders;
			if (previousReplicateToken === undefined) delete process.env.REPLICATE_API_TOKEN;
			else process.env.REPLICATE_API_TOKEN = previousReplicateToken;
		}
	});

	it("requires a requote when no frozen provider/model route remains executable", () => {
		const frozenQuote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{ enabledProviders: new Set(["replicate"]), generationEnabled: true },
		);

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
