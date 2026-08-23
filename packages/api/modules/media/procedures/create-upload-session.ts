import { createHash, randomUUID } from "node:crypto";

import { db } from "@repo/database/client";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { createAssetObjectKey, createMultipartUpload, createSignedUpload } from "@repo/storage";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { enforceMediaRateLimit } from "../lib/rate-limit";
import { parseUploadRequest } from "../lib/upload-validation";

const DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS = 5;
const DEFAULT_MAXIMUM_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

export const createUploadSession = protectedProcedure
	.route({
		method: "POST",
		path: "/media/upload-sessions",
		tags: ["Media"],
		summary: "Create a private media upload session",
	})
	.input(z.object({ contentType: z.string(), byteSize: z.number().int().positive() }))
	.handler(async ({ context: { user }, input }) => {
		const parsed = parseUploadRequest(input);
		await enforceMediaRateLimit(user.id, "media:upload-session");
		const assetId = randomUUID();
		const sessionId = randomUUID();
		const objectKey = createAssetObjectKey(user.id, assetId, parsed.contentType);
		const multipart = parsed.multipart
			? await createMultipartUpload({
					bucket: "media",
					key: objectKey,
					contentType: parsed.contentType,
				})
			: null;
		const signedUploadUrl = !parsed.multipart
			? await createSignedUpload({
					bucket: "media",
					key: objectKey,
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
					mimeType: parsed.contentType,
					expectedBytes: BigInt(parsed.byteSize),
					tokenHash,
					expiresAt,
					multipartUploadId: multipart?.uploadId ?? null,
					limits: uploadLimits(process.env),
				},
				db,
			);
		} catch (error) {
			if (multipart) {
				const { abortMultipartUpload } = await import("@repo/storage");
				await abortMultipartUpload({
					bucket: "media",
					key: objectKey,
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

function uploadLimits(environment: NodeJS.ProcessEnv) {
	return {
		maximumActiveSessions: positiveInteger(
			environment.MEDIA_MAX_ACTIVE_UPLOAD_SESSIONS,
			DEFAULT_MAXIMUM_ACTIVE_UPLOAD_SESSIONS,
		),
		maximumReservedBytes: BigInt(
			positiveInteger(environment.MEDIA_MAX_STORAGE_BYTES, DEFAULT_MAXIMUM_STORAGE_BYTES),
		),
	};
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
