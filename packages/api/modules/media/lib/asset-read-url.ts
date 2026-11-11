import { ORPCError } from "@orpc/server";
import { createSignedReadUrl } from "@repo/storage";

/** Caller must authorize the asset using the current verification boundary first. */
export async function signAuthorizedAssetReadUrl(
	asset: {
		id: string;
		objectKey: string;
		verificationValidUntil: Date | null;
		deleteAfter?: Date | null;
		resultExpiresAt?: Date;
	},
	disposition: "inline" | "attachment" = "inline",
) {
	const now = Date.now();
	const expiresIn = Math.min(
		300,
		Math.floor(((asset.verificationValidUntil?.getTime() ?? now) - now) / 1_000),
		asset.deleteAfter ? Math.floor((asset.deleteAfter.getTime() - now) / 1_000) : 300,
		asset.resultExpiresAt ? Math.floor((asset.resultExpiresAt.getTime() - now) / 1_000) : 300,
	);
	if (expiresIn <= 0) throw new ORPCError("PRECONDITION_FAILED");
	// Only an allowlisted suffix from the authorized immutable object key enters
	// the download name. This preserves real GIF/SVG files instead of extensionless downloads.
	const extension = /\.(png|jpe?g|webp|gif|svg|mp4|webm|mov)$/.exec(asset.objectKey)?.[1];
	return {
		assetId: asset.id,
		expiresIn,
		expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
		url: await createSignedReadUrl({
			bucket: "media",
			key: asset.objectKey,
			expiresIn,
			responseContentDisposition:
				disposition === "inline"
					? "inline"
					: `attachment; filename="${asset.id}${extension ? `.${extension}` : ""}"`,
		}),
	};
}
