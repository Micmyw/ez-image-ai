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
	it.each([
		["seedream-5-5-1k", 8n, 18_000n, 25_200n],
		["seedream-5-5-1-5k", 12n, 18_000n, 25_200n],
		["seedream-5-5-2k", 20n, 31_500n, 38_700n],
		["minimax-h3-1k", 5n, 9_000n, 11_500n],
		["minimax-h3-2k", 10n, 9_000n, 11_500n],
		["minimax-h3-4k", 20n, 27_500n, 30_000n],
	] as const)(
		"freezes %s retail and the exact text/reference cost",
		(skuKey, credits, textCost, editCost) => {
			for (const kind of ["text-to-image", "image-to-image"] as const) {
				const input =
					kind === "text-to-image"
						? { kind, prompt: "A ceramic vase", skuKey, aspectRatio: "1:1" as const }
						: {
								kind,
								prompt: "A ceramic vase",
								skuKey,
								aspectRatio: "1:1" as const,
								sourceAssetId: SOURCE_ASSET_ID,
							};
				const isSeedream55 = skuKey.startsWith("seedream-5-5-");
				const quote = buildMediaQuote(
					{ productKey: isSeedream55 ? "image-seedream-5-5" : "image-minimax-h3", input },
					KIE_ROUTE_OPTIONS,
				);
				expect(quote).toMatchObject({
					credits,
					costMicros: kind === "text-to-image" ? textCost : editCost,
				});
				expect(quote.pricingSnapshot).toMatchObject({
					skuKey,
					credits: Number(credits),
					routeGraph: {
						allowedRoutes: [
							{
								provider: "kie",
								providerModelId: isSeedream55
									? kind === "text-to-image"
										? "seedream/5-5-text-to-image"
										: "seedream/5-5-image-to-image"
									: kind === "text-to-image"
										? "minimax-h3/text-to-image"
										: "minimax-h3/image-edit",
							},
						],
					},
				});
			}
		},
	);
	it("freezes explicit image-pass funding without replacing the ordinary catalog price", () => {
		const quote = buildMediaQuote(
			{ ...NANO_QUOTE_INPUT, fundingSource: "IMAGE_PASS" },
			KIE_ROUTE_OPTIONS,
		);
		expect(quote.credits).toBe(5n);
		expect(quote.pricingSnapshot).toMatchObject({
			fundingSource: "IMAGE_PASS",
			imagePassUnits: 1,
			settlementPolicy: { requestedOutputCount: 1 },
		});
	});
	it("freezes the disclosed first-block-free output billing policy for new jobs", () => {
		expect(buildMediaQuote(NANO_QUOTE_INPUT, KIE_ROUTE_OPTIONS).pricingSnapshot).toMatchObject({
			outputModerationBillingPolicy: "first-block-free-v1",
			kiePolicyRejectionBillingPolicy: "charge-quoted-credits-v1",
		});
	});
	it("keeps independent image passes outside the credit rejection charge policy", () => {
		const quote = buildMediaQuote(
			{ ...NANO_QUOTE_INPUT, fundingSource: "IMAGE_PASS" },
			KIE_ROUTE_OPTIONS,
		);
		expect(quote.pricingSnapshot).not.toHaveProperty("kiePolicyRejectionBillingPolicy");
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
