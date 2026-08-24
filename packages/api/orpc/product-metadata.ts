import { DEFAULT_PRODUCT_CONFIG } from "@repo/config";

export function getOpenApiTitle(): string {
	const siteName =
		process.env.NEXT_PUBLIC_SITE_NAME?.trim() || DEFAULT_PRODUCT_CONFIG.brand.siteName;
	return `${siteName} API`;
}
