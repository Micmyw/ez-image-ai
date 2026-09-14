import { DEFAULT_PRODUCT_CONFIG, isKieImageProductCertified } from "@repo/config";
import { describe, expect, it } from "vitest";

import { getPublicProductCatalog } from "./catalog";
import { configuredRouteGraphOptionsFromEnvironment } from "./routing";

const production = {
	NODE_ENV: "production",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_SEEDREAM_4_5_ENABLED: "true",
	MEDIA_SEEDREAM_5_LITE_ENABLED: "true",
	MEDIA_SEEDREAM_5_PRO_ENABLED: "true",
};
const products = [
	"image-nano-banana-2-lite",
	"image-seedream-4-5",
	"image-seedream-5-lite",
	"image-seedream-5-pro",
];
const catalog = (environment: Record<string, string>) =>
	getPublicProductCatalog(configuredRouteGraphOptionsFromEnvironment(environment));

describe("reviewed production catalog compatibility", () => {
	it("keeps the old compatibility bounded to the reviewed September 13 catalog", () => {
		for (const product of products) {
			expect(isKieImageProductCertified(product, new Set(["2026-09-07.2"]), "2026-09-13.1")).toBe(
				true,
			);
			expect(isKieImageProductCertified(product, new Set(["2026-09-07.2"]))).toBe(false);
		}
		expect(
			isKieImageProductCertified(
				"image-gpt-image-2-5-flare",
				new Set(["2026-09-07.2"]),
				"2026-09-13.1",
			),
		).toBe(false);
	});
	it("does not authorize the new text-capable catalog with an old certificate", () => {
		expect(catalog(production).products).toEqual([]);
		expect(
			catalog({
				...production,
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-13.1",
				MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true",
				MEDIA_GPT_IMAGE_2_5_SUNBURST_ENABLED: "true",
				MEDIA_SEEDREAM_4_ENABLED: "true",
				MEDIA_NANO_BANANA_PRO_ENABLED: "true",
			}).products.map((product) => product.key),
		).toEqual([]);
	});
	it("still requires the certificate, model switch and generation switch", () => {
		const current = {
			...production,
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: DEFAULT_PRODUCT_CONFIG.catalogVersion,
		};
		expect(catalog(current).products.map((product) => product.key)).toEqual(products);
		expect(
			catalog({ ...production, MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "" }).products,
		).toEqual([]);
		expect(catalog({ ...current, MEDIA_GENERATION_ENABLED: "false" }).products).toEqual([]);
		expect(
			catalog({ ...current, MEDIA_SEEDREAM_5_PRO_ENABLED: "false" }).products.map(
				(product) => product.key,
			),
		).toEqual(products.slice(0, 3));
	});
});
