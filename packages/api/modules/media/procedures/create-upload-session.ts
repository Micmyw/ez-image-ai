import { createHash, randomUUID } from "node:crypto";

import { db } from "@repo/database/client";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import {
	createFinalAssetObjectKey,
	createMultipartUpload,
	createSignedUpload,
	createStagingObjectKey,
} from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { loadUserPlanEntitlement } from "../lib/plan-entitlement";
import { enforceMediaRateLimit } from "../lib/rate-limit";
import { mediaUploadLimits } from "../lib/storage-limits";
import { parseUploadRequest } from "../lib/upload-validation";

export const createUploadSession = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions",
		tags: ["Media"],
		summary: "Create a private media upload session",
	})
	.input(z.object({ contentType: z.string(), byteSize: z.number().int().positive() }))
	.handler(async ({ context: { user }, input }) => {
		const entitlement = await loadUserPlanEntitlement(user.id);
		const parsed = parseUploadRequest(input, {
			maximumImageBytes: entitlement.maximumInputBytes,
		});
		await enforceMediaRateLimit(user.id, "media:upload-session");
		const assetId = randomUUID();
		const sessionId = randomUUID();
		const versionId = randomUUID();
		const objectKey = createFinalAssetObjectKey(user.id, assetId, versionId, parsed.contentType);
		const stagingObjectKey = createStagingObjectKey(
			user.id,
			sessionId,
			randomUUID(),
			parsed.contentType,
		);
		const multipart = parsed.multipart
			? await createMultipartUpload({
					bucket: "media",
					key: stagingObjectKey,
					contentType: parsed.contentType,
				})
			: null;
		const signedUploadUrl = !parsed.multipart
			? await createSignedUpload({
					bucket: "media",
					key: stagingObjectKey,
					contentType: parsed.contentType,
					contentLength: parsed.byteSize,
				})
			: null;
		const tokenHash = createHash("sha256").update(`${sessionId}:${randomUUID()}`).digest("hex");
		const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
		try {
			await createMediaUploadSessionTransaction(
				{
					assetId,
					sessionId,
					ownerType: "USER",
					ownerId: user.id,
					kind: "INPUT",
					objectKey,
					stagingObjectKey,
					mimeType: parsed.contentType,
					expectedBytes: BigInt(parsed.byteSize),
					tokenHash,
					expiresAt,
					multipartUploadId: multipart?.uploadId ?? null,
					limits: mediaUploadLimits(process.env),
				},
				db,
			);
		} catch (error) {
			if (multipart) {
				const { abortMultipartUpload } = await import("@repo/storage");
				await abortMultipartUpload({
					bucket: "media",
					key: stagingObjectKey,
					uploadId: multipart.uploadId,
				}).catch(() => undefined);
			}
			throw error;
		}
		return parsed.multipart
			? {
					assetId,
					sessionId,
					method: "MULTIPART" as const,
					partSize: 8 * 1024 * 1024,
					expiresAt: expiresAt.toISOString(),
				}
			: {
					assetId,
					sessionId,
					method: "PUT" as const,
					expiresAt: expiresAt.toISOString(),
					uploadUrl: signedUploadUrl!,
				};
	});
