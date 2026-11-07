import { createSignedReadUrl } from "@repo/storage";

/** Caller must select a sealed, decoded, unexpired native-video INPUT owned by this user.
 * Viewing the original does not approve provider use or generated output playback. */
export async function signOwnedVideoInputPreview(asset: {
	id: string;
	objectKey: string;
	deleteAfter: Date | null;
}) {
	const now = Date.now();
	const expiresIn = Math.min(
		300,
		asset.deleteAfter ? Math.floor((asset.deleteAfter.getTime() - now) / 1000) : 300,
	);
	if (expiresIn <= 0) throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
	return {
		assetId: asset.id,
		expiresIn,
		expiresAt: new Date(now + expiresIn * 1000).toISOString(),
		url: await createSignedReadUrl({
			bucket: "media",
			key: asset.objectKey,
			expiresIn,
			responseContentDisposition: "inline",
		}),
	};
}
