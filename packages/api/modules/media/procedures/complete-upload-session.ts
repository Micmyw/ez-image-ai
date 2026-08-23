import { db } from "@repo/database/client";
import {
	completeMediaUploadSessionTransaction,
	expireMediaUploadSessionTransaction,
	failMediaUploadSessionTransaction,
	MediaUploadSessionExpiredError,
} from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	completeMultipartUpload,
	deleteObject,
	headObject,
	readMediaHeader,
} from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { validateMultipartCompletionParts } from "../lib/upload-parts";
import { assertCompletedObjectMatchesSession, toMediaAssetDto } from "../lib/upload-validation";

const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

export const completeUploadSession = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions/{sessionId}/complete",
		tags: ["Media"],
		summary: "Complete and queue verification for an upload",
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
		if (session.status !== "PENDING") throw new Error("Upload session is not pending");
		const location = { bucket: "media" as const, key: session.asset.objectKey };
		if (session.expiresAt <= new Date()) {
			await expireMediaUploadSessionTransaction(
				{ sessionId: session.id, ownerId: user.id, now: new Date() },
				db,
			);
			if (session.multipartUploadId) {
				await abortMultipartUpload({
					...location,
					uploadId: session.multipartUploadId,
				}).catch(() => undefined);
			} else {
				await deleteObject(location).catch(() => undefined);
			}
			throw new MediaUploadSessionExpiredError();
		}
		let storageFinalized = !session.multipartUploadId;
		if (session.multipartUploadId) {
			if (!input.parts?.length) throw new Error("Multipart completion requires uploaded parts");
			validateMultipartCompletionParts(
				input.parts,
				Number(session.expectedBytes),
				MULTIPART_PART_SIZE,
			);
			await completeMultipartUpload({
				bucket: "media",
				key: session.asset.objectKey,
				uploadId: session.multipartUploadId,
				parts: input.parts,
			});
			storageFinalized = true;
		}
		try {
			const [head, header] = await Promise.all([headObject(location), readMediaHeader(location)]);
			assertCompletedObjectMatchesSession({
				expectedContentType: session.asset.mimeType as Parameters<
					typeof assertCompletedObjectMatchesSession
				>[0]["expectedContentType"],
				expectedBytes: Number(session.expectedBytes),
				head,
				header,
			});
			const asset = await completeMediaUploadSessionTransaction(
				{
					sessionId: session.id,
					ownerId: user.id,
					checksum: head.metadata.sha256 ?? head.etag ?? "pending-sha256",
					expiredCleanup: "DELETE_OBJECT",
				},
				db,
			);
			return toMediaAssetDto(asset);
		} catch (error) {
			if (error instanceof MediaUploadSessionExpiredError) {
				if (storageFinalized) await deleteObject(location).catch(() => undefined);
				else if (session.multipartUploadId) {
					await abortMultipartUpload({
						...location,
						uploadId: session.multipartUploadId,
					}).catch(() => undefined);
				}
			} else if (storageFinalized) {
				try {
					await failMediaUploadSessionTransaction(
						{
							sessionId: session.id,
							ownerId: user.id,
							reason: "UPLOAD_VALIDATION_FAILED",
						},
						db,
					);
				} finally {
					await deleteObject(location).catch(() => undefined);
				}
			}
			throw error;
		}
	});
