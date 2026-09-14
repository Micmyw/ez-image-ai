import { DEFAULT_PRODUCT_CONFIG } from "./product";

// Reviewed, bounded compatibility for the September 13 catalog expansion.
// These four already-enabled products retain their prior provider contracts.
// See docs/operations/evidence/kie-catalog-compatibility-2026-09-14.md.
// This does not certify new products or carry approval into a future catalog.
const COMPATIBLE_PRODUCTION_PRODUCTS = new Set([
	"image-nano-banana-2-lite",
	"image-seedream-4-5",
	"image-seedream-5-lite",
	"image-seedream-5-pro",
]);

export function isKieImageProductCertified(
	productKey: string,
	certifiedVersions: ReadonlySet<string> | undefined,
	catalogVersion: string = DEFAULT_PRODUCT_CONFIG.catalogVersion,
): boolean {
	if (certifiedVersions?.has(catalogVersion)) return true;
	return (
		catalogVersion === "2026-09-13.1" &&
		certifiedVersions?.has("2026-09-07.2") === true &&
		COMPATIBLE_PRODUCTION_PRODUCTS.has(productKey)
	);
}
