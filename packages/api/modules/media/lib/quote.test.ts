import { describe, expect, it } from "vitest";

import { assertFrozenQuoteRouteGraphIsCurrent, buildMediaQuote } from "./quote";

const SOURCE_ASSET_ID = "asset_01J5ABCD1234EFGH5678JKLMNP";

describe("buildMediaQuote", () => {
	it("persists a deterministic per-output settlement policy in the pricing snapshot", () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "test prompt",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{
				enabledProviders: new Set(["openrouter"]),
				generationEnabled: true,
				openRouterImageRoutesCertified: true,
			},
		);

		expect(quote.pricingSnapshot).toMatchObject({
			credits: 5,
			maximumJobCostMicros: 5_000_000,
			settlementPolicy: {
				unitCredits: "5",
				requestedOutputCount: 1,
				maxCharge: "5",
			},
		});
	});

	it("reserves for the highest executable route cost rather than only the first route", () => {
		const quote = buildMediaQuote(
			{
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			},
			{
				enabledProviders: new Set(["openrouter"]),
				generationEnabled: true,
				openRouterImageRoutesCertified: true,
			},
		);

		expect(quote.costMicros).toBe(23_000n);
	});

	it("locks the quote to the routes enabled by the shared API configuration", () => {
		const previous = process.env.MEDIA_ENABLED_PROVIDERS;
		const previousCertification = process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED;
		process.env.MEDIA_ENABLED_PROVIDERS = "openrouter";
		process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "true";
		try {
			const quote = buildMediaQuote({
				productKey: "image-fast",
				input: {
					kind: "image-to-image",
					prompt: "A studio product photo",
					sourceAssetId: SOURCE_ASSET_ID,
				},
			});

			expect(quote.costMicros).toBe(23_000n);
			expect(quote.pricingSnapshot).toMatchObject({
				routeGraph: {
					graphFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					maximumRouteCostMicros: 23_000,
					allowedRoutes: [
						{
							provider: "openrouter",
							providerModelId: "sourceful/riverflow-v2.5-fast",
							providerCostMicros: 23_000,
						},
					],
				},
			});
		} finally {
			if (previous === undefined) delete process.env.MEDIA_ENABLED_PROVIDERS;
			else process.env.MEDIA_ENABLED_PROVIDERS = previous;
			if (previousCertification === undefined)
				delete process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED;
			else process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = previousCertification;
		}
	});

	it("quotes a configured provider without requiring the API process to hold its worker credential", () => {
		const previousEnabledProviders = process.env.MEDIA_ENABLED_PROVIDERS;
		const previousCertification = process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED;
		const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
		process.env.MEDIA_ENABLED_PROVIDERS = "openrouter";
		process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = "true";
		delete process.env.OPENROUTER_API_KEY;
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
			).toMatchObject({ costMicros: 23_000n });
		} finally {
			if (previousEnabledProviders === undefined) delete process.env.MEDIA_ENABLED_PROVIDERS;
			else process.env.MEDIA_ENABLED_PROVIDERS = previousEnabledProviders;
			if (previousCertification === undefined)
				delete process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED;
			else process.env.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED = previousCertification;
			if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
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
			{
				enabledProviders: new Set(["openrouter"]),
				generationEnabled: true,
				openRouterImageRoutesCertified: true,
			},
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
