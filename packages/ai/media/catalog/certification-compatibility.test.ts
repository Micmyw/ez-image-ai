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
	it("keeps the four previously enabled models executable after the catalog expansion", () => {
		expect(catalog(production).products.map((product) => product.key)).toEqual(products);
	});
	it("does not authorize new or other unreviewed models with the old certificate", () => {
		expect(
			catalog({
				...production,
				MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true",
				MEDIA_GPT_IMAGE_2_5_SUNBURST_ENABLED: "true",
				MEDIA_SEEDREAM_4_ENABLED: "true",
				MEDIA_NANO_BANANA_PRO_ENABLED: "true",
			}).products.map((product) => product.key),
		).toEqual(products);
	});
	it("still requires the certificate, model switch and generation switch", () => {
		expect(
			catalog({ ...production, MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "" }).products,
		).toEqual([]);
		expect(catalog({ ...production, MEDIA_GENERATION_ENABLED: "false" }).products).toEqual([]);
		expect(
			catalog({ ...production, MEDIA_SEEDREAM_5_PRO_ENABLED: "false" }).products.map(
				(product) => product.key,
			),
		).toEqual(products.slice(0, 3));
	});
});
