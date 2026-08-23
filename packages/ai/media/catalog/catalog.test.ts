import { describe, expect, it } from "vitest";

import { getCatalogEntry, getPublicProductCatalog, quoteCatalogInput } from "./catalog";

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
});
