/** Physical image retention is independent of signed-reference and access expiry. */
export function isImageAutomaticDeletionEnabled(
	environment: Record<string, string | undefined> = process.env,
): boolean {
	return environment.MEDIA_IMAGE_AUTO_DELETE_ENABLED === "true";
}

export function isImageAutomaticDeletionPaused(
	asset: { mimeType: string; verificationEngine: string },
	environment: Record<string, string | undefined> = process.env,
): boolean {
	return (
		asset.verificationEngine === "legacy" &&
		asset.mimeType.startsWith("image/") &&
		!isImageAutomaticDeletionEnabled(environment)
	);
}

/** Never accept a reservation belonging to another asset from a cleanup payload. */
export function isMediaAssetStorageReservationReference(
	value: unknown,
	assetId: string,
): value is string {
	return ["generation-output", "media-draft", "temporary-reference"].some(
		(prefix) => value === `${prefix}:${assetId}`,
	);
}
