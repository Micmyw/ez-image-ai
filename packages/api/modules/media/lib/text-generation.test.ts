import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { describe, expect, it } from "vitest";

import { createQuoteInputSchema } from "../types";
import { publicImageGenerationInput } from "./public-generation-input";
import { assertFrozenQuoteRouteGraphIsCurrent, buildMediaQuote } from "./quote";

const request = {
	productKey: "image-gpt-image-2" as const,
	input: {
		kind: "text-to-image" as const,
		prompt: "A typographic travel poster",
		skuKey: "gpt-image-2-1k" as const,
		aspectRatio: "1:1" as const,
	},
};
const options = {
	enabledProviders: new Set(["kie" as const]),
	generationEnabled: true,
	kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
};

describe("text generation uses the existing quote boundary", () => {
	it("accepts a prompt and SKU without an image", () => {
		expect(createQuoteInputSchema.parse(request)).toEqual(request);
	});
	it("freezes and revalidates the text route in the priced quote", () => {
		const quote = buildMediaQuote(request, options);
		expect(quote.pricingSnapshot).toMatchObject({
			routeGraph: {
				allowedRoutes: [{ provider: "kie", providerModelId: "gpt-image-2-text-to-image" }],
			},
			settlementPolicy: { requestedOutputCount: 1, maxCharge: "7" },
		});
		expect(() => assertFrozenQuoteRouteGraphIsCurrent(quote, options)).not.toThrow();
	});
	it("retains prompt reuse without exposing stored provider details", () => {
		const publicInput = publicImageGenerationInput(request.productKey, {
			...request.input,
			providerModelId: "private",
			providerCostMicros: 100,
		});
		expect(publicInput).toMatchObject({
			kind: "text-to-image",
			sourceAssetId: null,
			prompt: request.input.prompt,
			skuKey: request.input.skuKey,
		});
		expect(JSON.stringify(publicInput)).not.toMatch(/provider|cost/i);
	});
	it("rejects injected assets, provider fields and a mismatched SKU", () => {
		for (const extra of [
			{ sourceAssetId: "asset_abcdefghijklmnop" },
			{ providerModelId: "private" },
			{ skuKey: "nano-banana-pro-1k" },
		]) {
			expect(
				createQuoteInputSchema.safeParse({ ...request, input: { ...request.input, ...extra } })
					.success,
			).toBe(false);
		}
	});
});
