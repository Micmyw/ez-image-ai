import type { CatalogRoute } from "./routing";

// Kie's published text endpoints, reviewed against independent OpenAPI snapshots.
const TEXT_IMAGE_MODELS: Readonly<Record<string, string>> = {
	"nano-banana-2-lite": "nano-banana-2-lite",
	"google/nano-banana-edit": "google/nano-banana",
	"nano-banana-2": "nano-banana-2",
	"nano-banana-pro": "nano-banana-pro",
	"gpt-image/1.5-image-to-image": "gpt-image/1.5-text-to-image",
	"gpt-image-2-image-to-image": "gpt-image-2-text-to-image",
	"gpt-image-2-5-flare-image-to-image": "gpt-image-2-5-flare-text-to-image",
	"gpt-image-2-5-sunburst-image-to-image": "gpt-image-2-5-sunburst-text-to-image",
	"bytedance/seedream-v4-edit": "bytedance/seedream-v4-text-to-image",
	"seedream/4.5-edit": "seedream/4.5-text-to-image",
	"seedream/5-lite-image-to-image": "seedream/5-lite-text-to-image",
	"seedream/5-pro-image-to-image": "seedream/5-pro-text-to-image",
};

export function kieTextImageModel(editModel: string): string | undefined {
	return TEXT_IMAGE_MODELS[editModel];
}

export function textImageRoutes(routes: readonly CatalogRoute[]): CatalogRoute[] {
	return routes.flatMap((route) => {
		const providerModelId =
			route.provider === "kie" ? kieTextImageModel(route.providerModelId) : undefined;
		return providerModelId ? [{ ...route, providerModelId }] : [];
	});
}

export function withTextImageRoutes(routes: readonly CatalogRoute[]): CatalogRoute[] {
	return [
		...routes,
		...textImageRoutes(routes).filter(
			(textRoute) =>
				!routes.some(
					(route) =>
						route.provider === textRoute.provider &&
						route.providerModelId === textRoute.providerModelId &&
						route.providerCostMicros === textRoute.providerCostMicros,
				),
		),
	];
}
