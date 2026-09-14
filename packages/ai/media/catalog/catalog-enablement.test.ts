import { describe, expect, it } from "vitest";

import { getPublicProductCatalog } from "./catalog";
import { configuredRouteGraphOptionsFromEnvironment } from "./routing";

const production = {
	NODE_ENV: "production",
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
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
const catalog = (environment: Record<string, string | undefined>) =>
	getPublicProductCatalog(configuredRouteGraphOptionsFromEnvironment(environment));

describe("image catalog enablement", () => {
	it.each([undefined, "", "2026-09-07.2", "2026-09-13.1"])(
		"advertises enabled models without depending on legacy certificate versions: %s",
		(versions) => {
			const result = catalog({
				...production,
				MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: versions,
			});
			expect(result.products.map((product) => product.key)).toEqual(products);
			for (const product of result.products) {
				expect(product.inputKinds).toEqual(["text-to-image", "image-to-image"]);
			}
		},
	);
	it("enables an additional model through its model switch", () => {
		expect(
			catalog({ ...production, MEDIA_GPT_IMAGE_2_5_FLARE_ENABLED: "true" }).products.map(
				(product) => product.key,
			),
		).toEqual([
			"image-nano-banana-2-lite",
			"image-gpt-image-2-5-flare",
			"image-seedream-4-5",
			"image-seedream-5-lite",
			"image-seedream-5-pro",
		]);
	});
	it("still requires the generation switch, model switch and configured provider", () => {
		expect(catalog({ ...production, MEDIA_GENERATION_ENABLED: "false" }).products).toEqual([]);
		expect(catalog({ ...production, MEDIA_ENABLED_PROVIDERS: "" }).products).toEqual([]);
		expect(
			catalog({ ...production, MEDIA_SEEDREAM_5_PRO_ENABLED: "false" }).products.map(
				(product) => product.key,
			),
		).toEqual(products.slice(0, 3));
	});
});
