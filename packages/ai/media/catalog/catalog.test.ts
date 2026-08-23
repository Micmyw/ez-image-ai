import { describe, expect, it } from "vitest";

import {
	getCatalogEntry,
	getPublicProductCatalog,
	isCatalogInputSupported,
	quoteCatalogInput,
} from "./catalog";
import {
	configuredProviderKeysFromEnvironment,
	enabledProviderKeysFromEnvironment,
	locallyExecutableProviderKeysFromEnvironment,
	recoveryProviderKeysFromEnvironment,
} from "./routing";

describe("media product catalog", () => {
	it("validates discriminated text and asset model inputs", () => {
		expect(
			quoteCatalogInput({
				productKey: "image-fast",
				input: { kind: "text-to-image", prompt: "A glass city at sunrise" },
			}),
		).toMatchObject({ credits: 4, pricingVersion: "2026-08-13.1" });

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
		const publicCatalog = getPublicProductCatalog();
		const serialized = JSON.stringify(publicCatalog);

		expect(internal.routes[0]).toMatchObject({ provider: "replicate" });
		expect(serialized).not.toContain("replicate");
		expect(serialized).not.toContain("providerModelId");
		expect(serialized).not.toContain("providerCostMicros");
		expect(serialized).not.toContain("weight");
	});

	it("does not advertise Gemini quality-image reference input that the provider cannot receive", () => {
		const qualityImage = getPublicProductCatalog({
			enabledProviders: new Set(["gemini"]),
			generationEnabled: true,
		}).products.find((product) => product.key === "image-quality");

		expect(qualityImage).toMatchObject({ inputKinds: ["text-to-image"] });
		expect(qualityImage?.fields).not.toContainEqual(
			expect.objectContaining({ key: "sourceAssetId" }),
		);
		expect(() =>
			quoteCatalogInput({
				productKey: "image-quality",
				input: {
					kind: "image-to-image",
					prompt: "Preserve the lighting",
					sourceAssetId: "asset_01J5ABCD1234EFGH5678JKLMNP",
				},
			}),
		).toThrow("Input image-to-image is not supported by image-quality");
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

	it("publishes quality video while keeping its real Kie Veo route private", () => {
		const internal = getCatalogEntry("video-quality");
		const publicCatalog = getPublicProductCatalog();
		expect(internal.routes).toEqual([
			expect.objectContaining({ provider: "kie", providerModelId: "veo3" }),
		]);
		expect(publicCatalog.products).toContainEqual(
			expect.objectContaining({
				key: "video-quality",
				mediaKind: "video",
				fields: expect.arrayContaining([
					expect.objectContaining({ key: "durationSeconds", min: 4, max: 8, step: 2 }),
				]),
			}),
		);
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
		} as never);

		expect(catalog.products.map((product) => product.key)).not.toContain("image-fast");
	});

	it("does not publish any product when the generation environment gate is disabled", () => {
		const catalog = getPublicProductCatalog({
			enabledProviders: new Set(["replicate", "fal"]),
			generationEnabled: false,
		} as never);

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
