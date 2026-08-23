import { randomUUID } from "node:crypto";

import { db } from "@repo/database/client";
import {
	claimMediaUploadSessionFinalizationTransaction,
	clearMediaUploadPromotionMultipartTransaction,
	completeMediaUploadSessionTransaction,
	failMediaUploadSessionFinalizationTransaction,
	MediaUploadSessionExpiredError,
	recordMediaUploadPromotionMultipartTransaction,
} from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	abortIncompleteMultipartUploads,
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
const multipartPartsSchema = z
	.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
	.min(1);

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
			parts: multipartPartsSchema.optional(),
		}),
	)
	.handler(async ({ context: { user }, input }) => {
		const session = await requireOwnedUploadSession(input.sessionId, user.id);
		if (session.status === "COMPLETED") return toMediaAssetDto(session.asset);
		if (!["PENDING", "FINALIZING"].includes(session.status)) {
			throw new Error("Upload session is not pending");
		}
		if (session.status === "PENDING" && session.multipartUploadId) {
			if (!input.parts) throw new Error("Multipart completion requires uploaded parts");
			validateMultipartCompletionParts(
				input.parts,
				Number(session.expectedBytes),
				MULTIPART_PART_SIZE,
			);
		}

		const claimed = await claimMediaUploadSessionFinalizationTransaction(
			{
				sessionId: session.id,
				ownerId: user.id,
				parts: session.status === "PENDING" ? input.parts : undefined,
			},
			db,
		).catch(async (error: unknown) => {
			if (error instanceof MediaUploadSessionExpiredError && session.status === "PENDING") {
				await cleanExpiredStaging(session);
			}
			throw error;
		});
		if (claimed.outcome === "COMPLETED") return toMediaAssetDto(claimed.asset);
		if (claimed.outcome === "IN_PROGRESS") {
			throw new Error("Upload session finalization is in progress");
		}

		const staging = { bucket: "media" as const, key: claimed.stagingObjectKey };
		const final = { bucket: "media" as const, key: claimed.asset.objectKey };
		let promoted: Awaited<ReturnType<typeof promoteStagedObject>>;
		let promotion =
			claimed.promotionMultipartUploadId && claimed.promotionToken
				? {
						multipartUploadId: claimed.promotionMultipartUploadId,
						promotionToken: claimed.promotionToken,
					}
				: undefined;
		let retriedMissingPromotionMultipart = false;
		try {
			if (claimed.multipartUploadId) {
				const parts = storedMultipartParts(claimed.finalizationParts);
				validateMultipartCompletionParts(parts, Number(session.expectedBytes), MULTIPART_PART_SIZE);
				try {
					await completeMultipartUpload({ ...staging, uploadId: claimed.multipartUploadId, parts });
				} catch (error) {
					if (!isNoSuchUpload(error)) throw error;
				}
			}

			for (;;) {
				if (!promotion) await abortIncompleteMultipartUploads(final);
				const promotionToken = randomUUID();
				try {
					promoted = await promoteStagedObject({
						staging,
						final,
						contentLength: Number(session.expectedBytes),
						contentType: claimed.asset.mimeType as
							| "image/jpeg"
							| "image/png"
							| "image/webp"
							| "video/mp4"
							| "video/webm"
							| "video/quicktime",
						promotion: promotion
							? { uploadId: promotion.multipartUploadId }
							: {
									onMultipartUploadCreated: async ({ uploadId }) => {
										promotion = await recordMediaUploadPromotionMultipartTransaction(
											{
												sessionId: session.id,
												ownerId: user.id,
												finalizationToken: claimed.finalizationToken,
												multipartUploadId: uploadId,
												promotionToken,
											},
											db,
										);
									},
								},
					});
					break;
				} catch (error) {
					if (!promotion || !isNoSuchUpload(error) || retriedMissingPromotionMultipart) {
						throw error;
					}
					const missingPromotion = promotion;
					await clearMediaUploadPromotionMultipartTransaction(
						{
							sessionId: session.id,
							ownerId: user.id,
							finalizationToken: claimed.finalizationToken,
							multipartUploadId: missingPromotion.multipartUploadId,
							promotionToken: missingPromotion.promotionToken,
						},
						db,
					);
					promotion = undefined;
					retriedMissingPromotionMultipart = true;
				}
			}
		} catch (error) {
			if (isDeterministicFinalizationFailure(error)) {
				await terminalizeDeterministicFinalizationFailure({
					sessionId: session.id,
					ownerId: user.id,
					finalizationToken: claimed.finalizationToken,
				});
			}
			throw error;
		}
		const asset = await completeMediaUploadSessionTransaction(
			{
				sessionId: session.id,
				ownerId: user.id,
				checksum: promoted.sha256,
				storageEtag: promoted.etag,
				storageVersionId: promoted.versionId,
				finalizationToken: claimed.finalizationToken,
				...(promotion ? { promotion } : {}),
			},
			db,
		);
		await deleteObject(staging).catch(() => undefined);
		return toMediaAssetDto(asset);
	});

function storedMultipartParts(value: unknown): Array<{ partNumber: number; etag: string }> {
	const parsed = multipartPartsSchema.safeParse(value);
	if (!parsed.success) throw new Error("Stored multipart completion parts are invalid");
	return parsed.data;
}

async function cleanExpiredStaging(session: {
	multipartUploadId: string | null;
	stagingObjectKey: string | null;
}): Promise<void> {
	if (!session.stagingObjectKey) return;
	const staging = { bucket: "media" as const, key: session.stagingObjectKey };
	if (session.multipartUploadId) {
		await abortMultipartUpload({ ...staging, uploadId: session.multipartUploadId }).catch(
			() => undefined,
		);
		return;
	}
	await deleteObject(staging).catch(() => undefined);
}

function isNoSuchUpload(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "name" in error && error.name === "NoSuchUpload",
	);
}

async function terminalizeDeterministicFinalizationFailure(input: {
	sessionId: string;
	ownerId: string;
	finalizationToken: string;
}): Promise<void> {
	try {
		await failMediaUploadSessionFinalizationTransaction(
			{ ...input, reason: "UPLOAD_FINALIZATION_VALIDATION_FAILED" },
			db,
		);
	} catch (error) {
		if (!isFinalizationOwnershipLost(error)) throw error;
	}
}

function isDeterministicFinalizationFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as {
		name?: unknown;
		message?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	};
	if (
		details.name === "NoSuchKey" ||
		details.name === "InvalidPart" ||
		details.name === "InvalidPartOrder" ||
		details.name === "EntityTooSmall" ||
		details.name === "InvalidRequest" ||
		details.$metadata?.httpStatusCode === 404
	) {
		return true;
	}
	const message = typeof details.message === "string" ? details.message : "";
	return /^(Multipart completion|Multipart expected|Multipart part|Multipart upload has no parts|Stored multipart completion parts|Staging (and final keys|object (body|metadata|signature|size))|Remote media (byte limit|response was empty)|Stored object|Final object checksum mismatch)/.test(
		message,
	);
}

function isFinalizationOwnershipLost(error: unknown): boolean {
	return Boolean(
		error instanceof Error && /not owned|lease expired|changed concurrently/i.test(error.message),
	);
}
