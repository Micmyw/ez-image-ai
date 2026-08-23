import { db } from "@repo/database/client";
import {
	claimMediaUploadSessionFinalizationTransaction,
	completeMediaUploadSessionTransaction,
	expireMediaUploadSessionTransaction,
	failMediaUploadSessionTransaction,
	MediaUploadSessionExpiredError,
} from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	completeMultipartUpload,
	deleteObject,
	promoteStagedObject,
} from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { validateMultipartCompletionParts } from "../lib/upload-parts";
import { toMediaAssetDto } from "../lib/upload-validation";

const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export const completeUploadSession = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions/{sessionId}/complete",
		tags: ["Media"],
		summary: "Promote a staged upload into an immutable private media asset",
	})
	.input(
		z.object({
			sessionId: z.string().min(1),
			parts: z
				.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
				.optional(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const session = await requireOwnedUploadSession(input.sessionId, user.id);
		if (session.status === "COMPLETED") return toMediaAssetDto(session.asset);
		if (!["PENDING", "FINALIZING"].includes(session.status)) {
			throw new Error("Upload session is not pending");
		}
		const staging = {
			bucket: "media" as const,
			key: session.stagingObjectKey ?? session.asset.objectKey,
		};
		const final = { bucket: "media" as const, key: session.asset.objectKey };
		if (session.expiresAt <= new Date()) {
			await expireMediaUploadSessionTransaction(
				{ sessionId: session.id, ownerId: user.id, now: new Date() },
				db,
			);
			if (session.multipartUploadId) {
				await abortMultipartUpload({ ...staging, uploadId: session.multipartUploadId }).catch(
					() => undefined,
				);
			} else {
				await deleteObject(staging).catch(() => undefined);
			}
			throw new MediaUploadSessionExpiredError();
		}
		if (session.multipartUploadId) {
			if (!input.parts?.length) throw new Error("Multipart completion requires uploaded parts");
			validateMultipartCompletionParts(
				input.parts,
				Number(session.expectedBytes),
				MULTIPART_PART_SIZE,
			);
		}
		const claimed = await claimMediaUploadSessionFinalizationTransaction(
			{ sessionId: session.id, ownerId: user.id, parts: input.parts, now: new Date() },
			db,
		);
		if (claimed.status === "COMPLETED") return toMediaAssetDto(claimed.asset);
		if (!claimed.finalizationToken) throw new Error("Upload session is already finalizing");
		try {
			if (session.multipartUploadId && session.status === "PENDING") {
				await completeMultipartUpload({
					...staging,
					uploadId: session.multipartUploadId,
					parts: input.parts!,
				});
			}
			const promoted = await promoteStagedObject({
				staging,
				final,
				contentLength: Number(session.expectedBytes),
				contentType: session.asset.mimeType as
					| "image/jpeg"
					| "image/png"
					| "image/webp"
					| "video/mp4"
					| "video/webm"
					| "video/quicktime",
			});
			const asset = await completeMediaUploadSessionTransaction(
				{
					sessionId: session.id,
					ownerId: user.id,
					checksum: promoted.sha256,
					storageEtag: promoted.etag,
					storageVersionId: promoted.versionId,
					finalizationToken: claimed.finalizationToken,
					expiredCleanup: "DELETE_OBJECT",
				},
				db,
			);
			await deleteObject(staging).catch(() => undefined);
			return toMediaAssetDto(asset);
		} catch (error) {
			if (error instanceof MediaUploadSessionExpiredError) {
				if (session.multipartUploadId) {
					await abortMultipartUpload({ ...staging, uploadId: session.multipartUploadId }).catch(
						() => undefined,
					);
				} else await deleteObject(staging).catch(() => undefined);
			} else {
				await failMediaUploadSessionTransaction(
					{ sessionId: session.id, ownerId: user.id, reason: "UPLOAD_PROMOTION_FAILED" },
					db,
				).catch(() => undefined);
				await deleteObject(staging).catch(() => undefined);
			}
			throw error;
		}
	});
