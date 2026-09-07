import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";
import { describe, expect, it } from "vitest";

import {
	getCatalogEntry,
	getPublicProductCatalog,
	isCatalogInputSupported,
	quoteCatalogInput,
} from "./catalog";
import {
	configuredRouteGraphOptionsFromEnvironment,
	configuredProviderKeysFromEnvironment,
	enabledProviderKeysFromEnvironment,
	locallyExecutableProviderKeysFromEnvironment,
	recoveryProviderKeysFromEnvironment,
} from "./routing";

describe("media product catalog", () => {
	it("quotes every current image SKU only for image-to-image edits", () => {
		for (const [productKey, skuKey, aspectRatio, credits] of [
			["image-nano-banana-2-lite", "nano-banana-2-lite-1k", "auto", 5],
			["image-gpt-image-2", "gpt-image-2-2k", "1:1", 11],
			["image-gpt-image-2", "gpt-image-2-4k", "4:5", 17],
			["image-seedream-5-pro", "seedream-5-pro-basic-1k", "1:1", 8],
			["image-seedream-5-pro", "seedream-5-pro-high-2k", "16:9", 15],
		] as const) {
			expect(
				quoteCatalogInput({
					productKey,
					input: {
						kind: "image-to-image",
						prompt: "Preserve the subject and replace the background",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
						skuKey,
						aspectRatio,
					},
				}),
			).toMatchObject({
				skuKey,
				credits,
				catalogVersion: DEFAULT_PRODUCT_CONFIG.catalogVersion,
				pricingVersion: DEFAULT_PRODUCT_CONFIG.pricingVersion,
			});
			expect(() =>
				quoteCatalogInput({
					productKey,
					input: { kind: "text-to-image", prompt: "Generate without a source image" },
				}),
			).toThrow(`Input text-to-image is not supported by ${productKey}`);
		}

		expect(() =>
			quoteCatalogInput({
				productKey: "video-fast",
				input: {
					kind: "image-to-video",
					prompt: "Animate",
					sourceUrl: "https://attacker.test/secret",
				},
			}),
		).toThrow();
		expect(
			quoteCatalogInput({
				productKey: "video-fast",
				input: {
					kind: "image-to-video",
					prompt: "Animate",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				},
			}),
		).toMatchObject({ credits: 25 });
	});

	it("publishes each model's independent SKU and aspect-ratio matrix", () => {
		const products = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
		}).products;

		const nano = products.find((product) => product.key === "image-nano-banana-2-lite")!;
		const gpt = products.find((product) => product.key === "image-gpt-image-2")!;
		const seedream = products.find((product) => product.key === "image-seedream-5-pro")!;

		expect(nano.skuMatrix).toMatchObject({
			defaultSkuKey: "nano-banana-2-lite-1k",
			dimensions: [{ key: "resolution", options: [{ key: "1k", label: "1K" }] }],
			cells: [{ skuKey: "nano-banana-2-lite-1k", credits: 5 }],
		});
		expect(nano.skuMatrix?.cells[0]?.aspectRatios).toContain("auto");
		expect(nano.skuMatrix?.cells[0]?.aspectRatios).toContain("1:8");

		expect(gpt.skuMatrix).toMatchObject({
			defaultSkuKey: "gpt-image-2-1k",
			dimensions: [
				{
					key: "resolution",
					options: [
						{ key: "1k", label: "1K" },
						{ key: "2k", label: "2K" },
						{ key: "4k", label: "4K" },
					],
				},
			],
			cells: [
				{ skuKey: "gpt-image-2-1k", credits: 7 },
				{ skuKey: "gpt-image-2-2k", credits: 11 },
				{ skuKey: "gpt-image-2-4k", credits: 17 },
			],
		});
		expect(gpt.skuMatrix?.cells[0]?.aspectRatios).toContain("1:1");
		expect(gpt.skuMatrix?.cells[0]?.controls).toContainEqual(
			expect.objectContaining({ key: "background", defaultValue: "opaque" }),
		);
		expect(gpt.skuMatrix?.cells[2]?.aspectRatios).not.toContain("1:1");

		expect(seedream.skuMatrix).toMatchObject({
			defaultSkuKey: "seedream-5-pro-basic-1k",
			dimensions: [{ key: "resolution" }, { key: "quality" }],
			cells: [
				{ skuKey: "seedream-5-pro-basic-1k", credits: 8 },
				{ skuKey: "seedream-5-pro-high-2k", credits: 15 },
			],
		});
		expect(seedream.skuMatrix).not.toEqual(gpt.skuMatrix);
	});

	it("rejects an aspect ratio that is invalid for the selected SKU", () => {
		expect(() =>
			quoteCatalogInput({
				productKey: "image-gpt-image-2",
				input: {
					kind: "image-to-image",
					prompt: "Use a square crop",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					skuKey: "gpt-image-2-4k",
					aspectRatio: "1:1",
				},
			}),
		).toThrow();
	});

	it("keeps provider routing and costs server-only", () => {
		const internal = getCatalogEntry("image-nano-banana-2-lite");
		const publicCatalog = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
		});
		const serialized = JSON.stringify(publicCatalog);

		expect(internal.routes[0]).toMatchObject({ provider: "kie" });
		expect(serialized).not.toContain("kie");
		expect(serialized).not.toContain("providerModelId");
		expect(serialized).not.toContain("providerCostMicros");
		expect(serialized).not.toContain("weight");
	});

	it("registers the exact Kie image routes but requires the catalog-version gate", () => {
		expect(getCatalogEntry("image-nano-banana-2-lite").routes).toEqual([
			{
				provider: "kie",
				providerModelId: "nano-banana-2-lite",
				providerCostMicros: 20_000,
				weight: 100,
			},
		]);
		expect(getCatalogEntry("image-gpt-image-2").routes).toEqual([
			{
				provider: "kie",
				providerModelId: "gpt-image-2-image-to-image",
				providerCostMicros: 30_000,
				weight: 100,
			},
			{
				provider: "kie",
				providerModelId: "gpt-image-2-image-to-image",
				providerCostMicros: 50_000,
				weight: 100,
			},
			{
				provider: "kie",
				providerModelId: "gpt-image-2-image-to-image",
				providerCostMicros: 80_000,
				weight: 100,
			},
		]);
		expect(getCatalogEntry("image-seedream-5-pro").routes).toEqual([
			expect.objectContaining({ provider: "kie", providerCostMicros: 35_000 }),
			expect.objectContaining({ provider: "kie", providerCostMicros: 70_000 }),
		]);

		const uncertified = configuredRouteGraphOptionsFromEnvironment({
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
		});
		expect(getPublicProductCatalog(uncertified).products).toEqual([]);

		const certified = configuredRouteGraphOptionsFromEnvironment({
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		});
		expect(getPublicProductCatalog(certified).products.map((product) => product.key)).toEqual([
			"image-nano-banana-2-lite",
			"image-nano-banana",
			"image-nano-banana-2",
			"image-nano-banana-pro",
			"image-gpt-image-1-5",
			"image-gpt-image-2",
			"image-seedream-4-5",
			"image-seedream-5-lite",
			"image-seedream-5-pro",
		]);
	});

	it("publishes all nine current image products and their twenty legal SKUs", () => {
		const products = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
		}).products;

		expect(products.map((product) => product.key)).toEqual([
			"image-nano-banana-2-lite",
			"image-nano-banana",
			"image-nano-banana-2",
			"image-nano-banana-pro",
			"image-gpt-image-1-5",
			"image-gpt-image-2",
			"image-seedream-4-5",
			"image-seedream-5-lite",
			"image-seedream-5-pro",
		]);
		expect(products.flatMap((product) => product.skuMatrix?.cells ?? [])).toHaveLength(20);
		for (const product of products) {
			expect(product).toEqual(
				expect.objectContaining({
					mediaKind: "image",
					inputKinds: ["image-to-image"],
					fields: expect.arrayContaining([
						expect.objectContaining({ key: "sourceAssetId", required: true }),
					]),
				}),
			);
		}
		expect(JSON.stringify(products)).not.toMatch(
			/image-fast|image-quality|providerCost|openrouter/i,
		);
	});

	it("rejects a malformed durable text input that smuggles a source asset", () => {
		expect(
			isCatalogInputSupported(getCatalogEntry("image-gpt-image-2"), {
				kind: "text-to-image",
				prompt: "Preserve the source composition",
				sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
			}),
		).toBe(false);
	});

	it("retains quality video internally without publishing it to EzPic", () => {
		const internal = getCatalogEntry("video-quality");
		const publicCatalog = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal", "gemini", "kie"]),
			generationEnabled: true,
		});
		expect(internal.routes).toEqual([
			expect.objectContaining({ provider: "kie", providerModelId: "veo3" }),
		]);
		expect(publicCatalog.products.map((product) => product.key)).not.toContain("video-quality");
		expect(JSON.stringify(publicCatalog)).not.toMatch(/kie|veo3|provider/i);
		expect(() =>
			quoteCatalogInput({
				productKey: "video-quality",
				input: { kind: "text-to-video", prompt: "x", durationSeconds: 5 },
			}),
		).toThrow(/4, 6, or 8/);
	});

	it("does not publish a product when none of its routes have an executable adapter", () => {
		const catalog = getPublicProductCatalog({ enabledProviders: new Set() });

		expect(catalog.products).toEqual([]);
	});

	it("keeps configured routes visible to the API without worker credentials", () => {
		const environment = {
			NODE_ENV: "test",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
			FAL_API_KEY: "worker-only-secret",
		};
		const configured = configuredProviderKeysFromEnvironment(environment);
		const local = locallyExecutableProviderKeysFromEnvironment(environment);

		expect(configured).toEqual(new Set(["kie"]));
		expect(local).toEqual(new Set());
		expect(
			getPublicProductCatalog(configuredRouteGraphOptionsFromEnvironment(environment)).products,
		).toContainEqual(expect.objectContaining({ key: "image-nano-banana-2-lite" }));
	});

	it("removes disabled products from the executable public graph", () => {
		const catalog = getPublicProductCatalog({
			enabledProviders: new Set(["kie"]),
			generationEnabled: true,
			disabledProductKeys: new Set(["image-gpt-image-2"]),
			kieImageCertifiedCatalogVersions: new Set([DEFAULT_PRODUCT_CONFIG.catalogVersion]),
		});

		expect(catalog.products.map((product) => product.key)).not.toContain("image-gpt-image-2");
	});

	it("layers each Kie image product switch onto the executable route graph", () => {
		const options = configuredRouteGraphOptionsFromEnvironment({
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "kie",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
			MEDIA_GPT_IMAGE_2_ENABLED: "false",
			MEDIA_SEEDREAM_5_PRO_ENABLED: "true",
		});
		expect(options.disabledProductKeys).toEqual(new Set(["image-gpt-image-2"]));
		expect(getPublicProductCatalog(options).products.map((product) => product.key)).toEqual([
			"image-nano-banana-2-lite",
			"image-nano-banana",
			"image-nano-banana-2",
			"image-nano-banana-pro",
			"image-gpt-image-1-5",
			"image-seedream-4-5",
			"image-seedream-5-lite",
			"image-seedream-5-pro",
		]);
	});

	it("fails closed when production omits all nine Kie product switches", () => {
		const options = configuredRouteGraphOptionsFromEnvironment({
			NODE_ENV: "production",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
		});

		expect(options.disabledProductKeys).toEqual(
			new Set([
				"image-nano-banana-2-lite",
				"image-nano-banana",
				"image-nano-banana-2",
				"image-nano-banana-pro",
				"image-gpt-image-1-5",
				"image-gpt-image-2",
				"image-seedream-4-5",
				"image-seedream-5-lite",
				"image-seedream-5-pro",
			]),
		);
		expect(getPublicProductCatalog(options).products).toEqual([]);
	});

	it("keeps the pre-launch defaults available in development and test", () => {
		for (const nodeEnvironment of ["development", "test"]) {
			const options = configuredRouteGraphOptionsFromEnvironment({
				NODE_ENV: nodeEnvironment,
				MEDIA_GENERATION_ENABLED: "true",
				MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
			});

			expect(options.disabledProductKeys, nodeEnvironment).toEqual(new Set());
		}
	});

	it("does not publish any product when the generation environment gate is disabled", () => {
		const catalog = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal"]),
			generationEnabled: false,
		});

		expect(catalog.products).toEqual([]);
	});

	it("uses the legacy single-provider selector only when the shared list is absent", () => {
		expect(
			enabledProviderKeysFromEnvironment({
				MEDIA_PROVIDER_ADAPTER: "fal",
				REPLICATE_API_TOKEN: "unrelated-secret",
				FAL_API_KEY: "fal-worker-secret",
			}),
		).toEqual(new Set(["fal"]));
	});

	it("keeps disabled providers available only for configured recovery workers", () => {
		const environment = {
			MEDIA_ENABLED_PROVIDERS: "fal",
			MEDIA_RECOVERY_PROVIDERS: "replicate,fal",
			FAL_API_KEY: "fal-worker-secret",
		};

		expect(enabledProviderKeysFromEnvironment(environment)).toEqual(new Set(["fal"]));
		expect(recoveryProviderKeysFromEnvironment(environment)).toEqual(new Set(["replicate", "fal"]));
	});
});
