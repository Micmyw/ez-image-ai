import { parseRouteGraphSnapshot, type ExecutableRouteGraphOptions } from "@repo/ai";
import {
	IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
	IMAGE_PASS_LEGACY_OFFER,
	IMAGE_PASS_PUBLIC_OFFER,
	IMAGE_PASS_STANDARD_OFFER,
	type ProductModelKey,
} from "@repo/config";
import { describe, expect, it } from "vitest";

import { buildMediaQuote } from "./quote";

const routes: ExecutableRouteGraphOptions = {
	enabledProviders: new Set(["kie"]),
	generationEnabled: true,
};

function quote(
	variant: "flare" | "sunburst" = "flare",
	properties: Record<string, unknown> = {},
	fundingSource: "CREDITS" | "IMAGE_PASS" = "CREDITS",
) {
	return buildMediaQuote(
		{
			productKey: `image-gpt-image-2-6-${variant}`,
			fundingSource,
			input: {
				kind: "text-to-image",
				prompt: "A looping paper boat",
				skuKey: `gpt-image-2-6-${variant}-1k`,
				aspectRatio: "1:1",
				...properties,
			} as never,
		},
		routes,
	);
}

describe("GPT Image 2.6 fixed credit quotes", () => {
	it.each([
		["flare", "1k", 20, 90_000],
		["flare", "2k", 40, 180_000],
		["flare", "4k", 80, 360_000],
		["sunburst", "1k", 25, 115_000],
		["sunburst", "2k", 50, 240_000],
		["sunburst", "4k", 100, 490_000],
	] as const)(
		"freezes %s %s retail credits separately from estimated upstream allowance",
		(variant, size, credits, allowance) => {
			const result = quote(variant, { skuKey: `gpt-image-2-6-${variant}-${size}` });
			expect(result).toMatchObject({ credits: BigInt(credits), costMicros: BigInt(allowance) });
			expect(result.pricingSnapshot).toMatchObject({
				retailPolicy: "fixed-image-format-credits-v1",
				providerCostBasis: {
					version: "kie-gpt-image-26-estimate-2026-11-11",
					kind: "token-cost-estimate",
					textInputUsdPerMillion: 4.5,
					imageInputUsdPerMillion: 7.2,
					imageOutputUsdPerMillion: 27,
					svgAuthor: "gpt-5.6-luna",
					svgInputUsdPerMillion: 0.18,
					svgOutputUsdPerMillion: 1.08,
				},
				settlementPolicy: {
					unitCredits: String(credits),
					requestedOutputCount: 1,
					maxCharge: String(credits),
				},
			});
			expect(
				parseRouteGraphSnapshot({ ...result, routeGraph: result.pricingSnapshot.routeGraph }),
			).toMatchObject({
				maximumRouteCostMicros: allowance,
				allowedRoutes: [
					{
						provider: "kie",
						providerModelId: `gpt-image-2-6/${variant}-text-to-image`,
						providerCostMicros: allowance,
						weight: 100,
					},
				],
			});
		},
	);

	it.each([
		[2, 40, 50, 180_000, 230_000],
		[8, 40, 50, 180_000, 230_000],
		[9, 45, 57, 202_500, 258_750],
		[10, 60, 75, 270_000, 345_000],
		[12, 60, 75, 270_000, 345_000],
		[13, 80, 100, 360_000, 460_000],
		[16, 80, 100, 360_000, 460_000],
	] as const)(
		"quotes GIF %i-frame boundaries without billing each frame as a separate output",
		(frameCount, flareCredits, sunburstCredits, flareAllowance, sunburstAllowance) => {
			for (const [variant, credits, allowance] of [
				["flare", flareCredits, flareAllowance],
				["sunburst", sunburstCredits, sunburstAllowance],
			] as const) {
				const result = quote(variant, { outputFormat: "gif", frameCount });
				expect(result).toMatchObject({ credits: BigInt(credits), costMicros: BigInt(allowance) });
				expect(result.pricingSnapshot.settlementPolicy).toEqual({
					unitCredits: String(credits),
					requestedOutputCount: 1,
					maxCharge: String(credits),
				});
			}
		},
	);

	it("defaults GIF quotes to nine frames and holds the same charge across legal playback speeds", () => {
		expect(quote("flare", { outputFormat: "gif" }).credits).toBe(45n);
		expect(quote("flare", { outputFormat: "gif", frameDurationMs: 20 }).credits).toBe(45n);
		expect(quote("flare", { outputFormat: "gif", frameDurationMs: 2000 }).credits).toBe(45n);
	});

	it.each([
		["flare", 40, 190_000],
		["sunburst", 45, 215_000],
	] as const)(
		"includes the fixed SVG authoring allowance for %s",
		(variant, credits, allowance) => {
			expect(quote(variant, { outputFormat: "svg" })).toMatchObject({
				credits: BigInt(credits),
				costMicros: BigInt(allowance),
			});
		},
	);

	it("freezes the reference-image route without exposing a client provider selector", () => {
		const result = quote("sunburst", {
			kind: "image-to-image",
			sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			outputFormat: "svg",
		});
		expect(result.pricingSnapshot.routeGraph).toMatchObject({
			allowedRoutes: [
				expect.objectContaining({ providerModelId: "gpt-image-2-6/sunburst-image-to-image" }),
			],
		});
	});

	it.each([
		["GIF in a 2K SKU", { skuKey: "gpt-image-2-6-flare-2k", outputFormat: "gif" }],
		["SVG in a 4K SKU", { skuKey: "gpt-image-2-6-flare-4k", outputFormat: "svg" }],
		["rectangular GIF", { outputFormat: "gif", aspectRatio: "16:9" }],
		["Economy frame count", { outputFormat: "gif", frameCount: 64 }],
		["fractional frame count", { outputFormat: "gif", frameCount: 2.5 }],
		["string frame count", { outputFormat: "gif", frameCount: "9" }],
		["invalid frame duration", { outputFormat: "gif", frameDurationMs: 205 }],
		["animation controls on PNG", { outputFormat: "png", frameCount: 9 }],
		["animation controls on SVG", { outputFormat: "svg", frameDurationMs: 200 }],
		["transparent JPEG", { outputFormat: "jpeg", background: "transparent" }],
		["transparent GIF", { outputFormat: "gif", background: "transparent" }],
		["transparent SVG", { outputFormat: "svg", background: "transparent" }],
		["too-long prompt", { prompt: "a".repeat(4001) }],
		["client provider model", { providerModelId: "unreviewed-model" }],
		["client SVG author", { svg: { model: "gpt-6-sol" } }],
		["client remote reference", { input_urls: ["https://untrusted.test/image.png"] }],
		["client quality override", { quality: "max" }],
	] as const)("rejects %s before a payable quote exists", (_label, properties) => {
		expect(() => quote("flare", properties)).toThrow();
	});
});

describe("GPT Image 2.6 preserves historical funding contracts", () => {
	it.each(["flare", "sunburst"] as const)(
		"extends %s static 2K/4K through a separate policy",
		(variant) => {
			for (const size of ["2k", "4k"]) {
				const result = quote(variant, { skuKey: `gpt-image-2-6-${variant}-${size}` }, "IMAGE_PASS");
				expect(result.pricingSnapshot.imagePassBenefitPolicy).toEqual(
					IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
				);
				expect(result.pricingSnapshot.imagePassUnits).toBe(1);
			}
		},
	);
	it.each([undefined, null, { version: "unknown" }])(
		"does not upgrade a missing/forged frozen pass policy %j",
		(imagePassBenefitPolicy) => {
			expect(() =>
				buildMediaQuote(
					{
						productKey: "image-gpt-image-2-6-flare",
						fundingSource: "IMAGE_PASS",
						imagePassBenefitPolicy,
						input: {
							kind: "text-to-image",
							prompt: "A vase",
							skuKey: "gpt-image-2-6-flare-1k",
							aspectRatio: "1:1",
						},
					},
					routes,
				),
			).toThrow("IMAGE_PASS_SELECTION_INVALID");
		},
	);

	it.each(["flare", "sunburst"] as const)("does not add %s to any frozen image pass", (variant) => {
		for (const offer of [
			IMAGE_PASS_LEGACY_OFFER,
			IMAGE_PASS_STANDARD_OFFER,
			IMAGE_PASS_PUBLIC_OFFER,
		]) {
			expect(
				offer.allowedSkuKeys.some((key: string) => key.startsWith(`gpt-image-2-6-${variant}`)),
			).toBe(false);
		}
		for (const outputFormat of ["png", "jpeg", "svg", "gif"] as const) {
			expect(quote(variant, { outputFormat }, "IMAGE_PASS").pricingSnapshot).toMatchObject({
				fundingSource: "IMAGE_PASS",
				imagePassUnits: 1,
				imagePassBenefitPolicy: IMAGE_PASS_GPT_IMAGE_26_BENEFIT_POLICY,
				settlementPolicy: { requestedOutputCount: 1 },
			});
		}
	});

	it.each([
		["image-nano-banana-2-lite", "nano-banana-2-lite-1k", 5, 20_000],
		["image-gpt-image-2-5-flare", "gpt-image-2-5-flare-1k", 7, 30_000],
		["image-gpt-image-2-5-sunburst", "gpt-image-2-5-sunburst-2k", 11, 50_000],
	] as const)(
		"keeps %s existing prices and refuses new format fields",
		(productKey, skuKey, credits, allowance) => {
			const input = {
				kind: "text-to-image" as const,
				prompt: "A paper boat",
				skuKey,
				aspectRatio: "1:1" as const,
			};
			const result = buildMediaQuote({ productKey: productKey as ProductModelKey, input }, routes);
			expect(result).toMatchObject({ credits: BigInt(credits), costMicros: BigInt(allowance) });
			expect(result.pricingSnapshot).not.toHaveProperty("providerCostBasis");
			for (const properties of [
				{ outputFormat: "gif" },
				{ outputFormat: "svg" },
				{ frameCount: 9 },
				{ frameDurationMs: 200 },
			]) {
				expect(() =>
					buildMediaQuote({ productKey, input: { ...input, ...properties } as never }, routes),
				).toThrow();
			}
		},
	);
});
