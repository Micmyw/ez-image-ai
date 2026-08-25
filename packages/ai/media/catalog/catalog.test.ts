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
	it("quotes both public products only for image-to-image edits", () => {
		for (const [productKey, credits] of [
			["image-fast", 4],
			["image-quality", 10],
		] as const) {
			expect(
				quoteCatalogInput({
					productKey,
					input: {
						kind: "image-to-image",
						prompt: "Preserve the subject and replace the background",
						sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
					},
				}),
			).toMatchObject({ credits, pricingVersion: "2026-08-25.1" });
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

	it("keeps provider routing and costs server-only", () => {
		const internal = getCatalogEntry("image-fast");
		const publicCatalog = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal", "gemini", "kie"]),
			generationEnabled: true,
		});
		const serialized = JSON.stringify(publicCatalog);

		expect(internal.routes[0]).toMatchObject({ provider: "replicate" });
		expect(serialized).not.toContain("replicate");
		expect(serialized).not.toContain("providerModelId");
		expect(serialized).not.toContain("providerCostMicros");
		expect(serialized).not.toContain("weight");
	});

	it("publishes only the two named image editing modes", () => {
		const products = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal", "gemini", "kie"]),
			generationEnabled: true,
		}).products;

		expect(products).toEqual([
			expect.objectContaining({
				key: "image-fast",
				label: "Standard Edit",
				mediaKind: "image",
				inputKinds: ["image-to-image"],
				credits: 4,
				fields: expect.arrayContaining([
					expect.objectContaining({ key: "sourceAssetId", required: true }),
				]),
			}),
			expect.objectContaining({
				key: "image-quality",
				label: "Quality Edit",
				mediaKind: "image",
				inputKinds: ["image-to-image"],
				credits: 10,
				fields: expect.arrayContaining([
					expect.objectContaining({ key: "sourceAssetId", required: true }),
				]),
			}),
		]);
		expect(products.map((product) => product.fields.map((field) => field.key))).toEqual([
			["prompt", "sourceAssetId"],
			["prompt", "sourceAssetId"],
		]);
	});

	it("rejects a malformed durable text input that smuggles a source asset", () => {
		expect(
			isCatalogInputSupported(getCatalogEntry("image-quality"), {
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
			MEDIA_ENABLED_PROVIDERS: "replicate",
			FAL_API_KEY: "worker-only-secret",
		};
		const configured = configuredProviderKeysFromEnvironment(environment);
		const local = locallyExecutableProviderKeysFromEnvironment(environment);

		expect(configured).toEqual(new Set(["replicate"]));
		expect(local).toEqual(new Set());
		expect(
			getPublicProductCatalog({ enabledProviders: configured, generationEnabled: true }).products,
		).toContainEqual(expect.objectContaining({ key: "image-fast" }));
	});

	it("removes disabled products from the executable public graph", () => {
		const catalog = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal"]),
			generationEnabled: true,
			disabledProductKeys: new Set(["image-fast"]),
		});

		expect(catalog.products.map((product) => product.key)).not.toContain("image-fast");
	});

	it("layers the Standard and Quality launch switches onto the executable route graph", () => {
		const options = configuredRouteGraphOptionsFromEnvironment({
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
			MEDIA_STANDARD_EDIT_ENABLED: "true",
			MEDIA_QUALITY_EDIT_ENABLED: "false",
		});
		expect(options.disabledProductKeys).toEqual(new Set(["image-quality"]));
		expect(getPublicProductCatalog(options).products.map((product) => product.key)).toEqual([
			"image-fast",
		]);
	});

	it("fails closed when production omits the Standard and Quality launch switches", () => {
		const options = configuredRouteGraphOptionsFromEnvironment({
			NODE_ENV: "production",
			EZPIC_DEPLOYMENT_ENVIRONMENT: "production",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,gemini",
		});

		expect(options.disabledProductKeys).toEqual(new Set(["image-fast", "image-quality"]));
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
