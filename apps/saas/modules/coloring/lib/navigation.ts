export const COLORING_PAGE_PATH = "/photo-to-coloring-page";

/** Carry opaque IDs only. The destination rechecks access to the selected image. */
export function coloringPageHref(assetId: string, guestJobId?: string): string {
	const query = new URLSearchParams(
		guestJobId ? { guestAsset: assetId, guestJob: guestJobId } : { asset: assetId },
	);
	return `${COLORING_PAGE_PATH}?${query}#image-editor`;
}
