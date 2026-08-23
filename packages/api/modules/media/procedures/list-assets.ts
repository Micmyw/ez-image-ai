import { listReadableMediaAssets } from "@repo/database/media-assets";

import { protectedProcedure } from "../../../orpc/procedures";
import { currentMediaAssetVerificationBoundary } from "../lib/asset-authorization";
import { decodeCursor, encodeCursor, jsonBigInt, listAssetsInputSchema } from "../types";

export const listAssets = protectedProcedure
	.route({ method: "GET", path: "/media/assets", tags: ["Media"] })
	.input(listAssetsInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const cursor = decodeCursor(input.cursor);
		const page = await listReadableMediaAssets({
			ownerType: "USER",
			ownerId: user.id,
			cursor,
			take: input.limit,
			...(input.kind ? { mimeTypePrefix: `${input.kind}/` as "image/" | "video/" } : {}),
			verification: currentMediaAssetVerificationBoundary(),
		});
		const items = page.items;
		const last = items[items.length - 1];
		return {
			items: items.map((asset) => ({
				id: asset.id,
				kind: asset.kind,
				mimeType: asset.mimeType,
				byteSize: jsonBigInt(asset.byteSize),
				createdAt: asset.createdAt.toISOString(),
				sourceJobId: asset.jobBindings[0]?.jobId ?? null,
			})),
			nextCursor: page.hasMore && last ? encodeCursor(last) : null,
		};
	});
