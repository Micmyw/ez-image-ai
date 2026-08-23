import { randomUUID } from "node:crypto";

import type { MediaAssetKind, Prisma } from "../../generated/client";
import type { CursorPageInput, MediaDatabaseClient, MediaTransactionClient } from "./types";
import { getMediaDatabaseClient, runSerializable } from "./types";

export interface CreateMediaAssetInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
	kind: MediaAssetKind;
	objectKey: string;
	mimeType: string;
	byteSize: bigint;
}

export async function createMediaAsset(input: CreateMediaAssetInput, client?: MediaDatabaseClient) {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	return getMediaDatabaseClient(client).mediaAsset.create({ data: input });
}

export async function listMediaAssets(input: CursorPageInput, client?: MediaDatabaseClient) {
	const take = Math.min(Math.max(input.take ?? 20, 1), 100);
	return getMediaDatabaseClient(client).mediaAsset.findMany({
		where: {
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			status: "READY",
			deletedAt: null,
			...(input.cursor
				? {
						OR: [
							{ createdAt: { lt: input.cursor.createdAt } },
							{ createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take,
	});
}

export async function createUploadSession(
	input: {
		assetId: string;
		tokenHash: string;
		expectedBytes: bigint;
		expiresAt: Date;
	},
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).mediaUploadSession.create({ data: input });
}

export interface CreateMediaUploadSessionTransactionInput {
	assetId: string;
	sessionId: string;
	ownerType: "USER";
	ownerId: string;
	kind: MediaAssetKind;
	objectKey: string;
	stagingObjectKey?: string;
	mimeType: string;
	expectedBytes: bigint;
	tokenHash: string;
	expiresAt: Date;
	multipartUploadId: string | null;
	limits: {
		maximumActiveSessions: number;
		maximumReservedBytes: bigint;
	};
}

export async function createMediaUploadSessionTransaction(
	input: CreateMediaUploadSessionTransactionInput,
	client: MediaTransactionClient,
) {
	if (input.ownerType !== "USER") throw new Error("First-release writes support USER owners only");
	if (input.expectedBytes <= BigInt(0)) throw new Error("Expected upload bytes must be positive");
	return runSerializable(client, async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-upload:${input.ownerId}`}))`;
		const [activeSessions, reserved] = await Promise.all([
			tx.mediaUploadSession.count({
				where: {
					status: "PENDING",
					expiresAt: { gt: new Date() },
					asset: { ownerType: input.ownerType, ownerId: input.ownerId },
				},
			}),
			tx.storageUsageReservation.aggregate({
				where: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					status: { in: ["ACTIVE", "COMMITTED"] },
				},
				_sum: { bytes: true },
			}),
		]);
		if (activeSessions >= input.limits.maximumActiveSessions) {
			throw new Error("ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED");
		}
		if ((reserved._sum.bytes ?? 0n) + input.expectedBytes > input.limits.maximumReservedBytes) {
			throw new Error("STORAGE_QUOTA_EXCEEDED");
		}
		const asset = await tx.mediaAsset.create({
			data: {
				id: input.assetId,
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				kind: input.kind,
				objectKey: input.objectKey,
				mimeType: input.mimeType,
				byteSize: input.expectedBytes,
			},
		});
		const session = await tx.mediaUploadSession.create({
			data: {
				id: input.sessionId,
				assetId: input.assetId,
				tokenHash: input.tokenHash,
				expectedBytes: input.expectedBytes,
				expiresAt: input.expiresAt,
				multipartUploadId: input.multipartUploadId,
				stagingObjectKey: input.stagingObjectKey ?? input.objectKey,
			},
		});
		await tx.storageUsageReservation.create({
			data: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				bytes: input.expectedBytes,
				referenceKey: `media-upload:${input.sessionId}`,
				expiresAt: input.expiresAt,
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_UPLOAD_SESSION_CREATED",
				targetType: "MEDIA_UPLOAD_SESSION",
				targetId: input.sessionId,
				after: {
					assetId: input.assetId,
					mimeType: input.mimeType,
					expectedBytes: input.expectedBytes.toString(),
				},
				metadata: {},
			},
		});
		return { asset, session };
	});
}

export async function claimMediaUploadSessionFinalizationTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		parts?: Prisma.InputJsonValue;
		now?: Date;
	},
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		if (session.status === "COMPLETED" || session.status === "FINALIZING") return session;
		if (session.status !== "PENDING") throw new Error("Upload session is not pending");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (session.expiresAt <= now) {
			await expirePendingUploadSession(session, now, "DELETE_OBJECT", tx);
			throw new MediaUploadSessionExpiredError();
		}
		const finalizationToken = randomUUID();
		const claimed = await tx.mediaUploadSession.updateMany({
			where: { id: session.id, status: "PENDING", expiresAt: { gt: now } },
			data: { status: "FINALIZING", finalizationToken, finalizationParts: input.parts },
		});
		if (claimed.count !== 1)
			throw new Error("Upload session changed concurrently before finalization");
		return {
			...session,
			status: "FINALIZING" as const,
			finalizationToken,
			finalizationParts: input.parts ?? null,
		};
	});
}

export async function failMediaUploadSessionTransaction(
	input: { sessionId: string; ownerId: string; reason: string },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		if (session.status === "ABORTED") return session.asset;
		if (!["PENDING", "FINALIZING"].includes(session.status)) {
			throw new Error("Upload session cannot be failed");
		}
		const changed = await tx.mediaUploadSession.updateMany({
			where: { id: session.id, status: { in: ["PENDING", "FINALIZING"] } },
			data: { status: "ABORTED" },
		});
		if (changed.count !== 1) throw new Error("Upload session changed concurrently before failure");
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		await tx.storageUsageReservation.updateMany({
			where: { referenceKey: `media-upload:${session.id}`, status: "ACTIVE" },
			data: { status: "RELEASED", releasedAt: new Date() },
		});
		await tx.outboxEvent.create({
			data: {
				eventType: "MEDIA_OBJECT_DELETE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: session.assetId,
				dedupeKey: `media-upload-invalid-cleanup:${session.id}`,
				payload: {
					assetId: session.assetId,
					objectKey: session.stagingObjectKey ?? session.asset.objectKey,
				},
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_UPLOAD_REJECTED",
				targetType: "MEDIA_UPLOAD_SESSION",
				targetId: session.id,
				before: { status: "PENDING" },
				after: { status: "ABORTED" },
				metadata: { assetId: session.assetId, reason: input.reason },
			},
		});
		return asset;
	});
}

export async function completeMediaUploadSessionTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		checksum: string;
		storageEtag?: string | null;
		storageVersionId?: string | null;
		finalizationToken?: string;
		now?: Date;
		expiredCleanup?: "ABORT_MULTIPART" | "DELETE_OBJECT";
	},
	client: MediaTransactionClient,
) {
	const result = await runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		if (session.status === "COMPLETED") {
			return { outcome: "COMPLETED" as const, asset: session.asset };
		}
		if (input.finalizationToken) {
			if (
				session.status !== "FINALIZING" ||
				session.finalizationToken !== input.finalizationToken
			) {
				throw new Error("Upload session is not finalizing with this token");
			}
		} else if (session.status !== "PENDING") {
			throw new Error("Upload session is not pending");
		}
		const now = input.now ?? (await getDatabaseNow(tx));
		if (session.expiresAt <= now) {
			await expirePendingUploadSession(session, now, input.expiredCleanup ?? "DELETE_OBJECT", tx);
			return { outcome: "EXPIRED" as const, asset: session.asset };
		}
		const completion = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: input.finalizationToken ? "FINALIZING" : "PENDING",
				expiresAt: { gt: now },
				...(input.finalizationToken ? { finalizationToken: input.finalizationToken } : {}),
			},
			data: { status: "COMPLETED", completedAt: now, finalizationToken: null },
		});
		if (completion.count !== 1) {
			throw new Error("Upload session changed concurrently before completion");
		}
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: {
				status: "VERIFYING",
				checksum: input.checksum,
				storageEtag: input.storageEtag ?? null,
				storageVersionId: input.storageVersionId ?? null,
				finalizedAt: now,
			},
		});
		await tx.storageUsageReservation.updateMany({
			where: { referenceKey: `media-upload:${session.id}`, status: "ACTIVE" },
			data: { status: "COMMITTED" },
		});
		await tx.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				dedupeKey: `media-asset-verify:${asset.id}`,
				payload: { assetId: asset.id, ownerType: "USER", ownerId: input.ownerId },
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_UPLOAD_COMPLETED",
				targetType: "MEDIA_ASSET",
				targetId: asset.id,
				before: { status: "UPLOADING" },
				after: { status: "VERIFYING" },
				metadata: { sessionId: session.id },
			},
		});
		return { outcome: "COMPLETED" as const, asset };
	});
	if (result.outcome === "EXPIRED") throw new MediaUploadSessionExpiredError();
	return result.asset;
}

export class MediaUploadSessionExpiredError extends Error {
	constructor() {
		super("Upload session expired");
		this.name = "MediaUploadSessionExpiredError";
	}
}

export async function expireMediaUploadSessionTransaction(
	input: { sessionId: string; ownerId: string; now?: Date },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		if (session.status === "EXPIRED") return session.asset;
		if (session.status !== "PENDING") throw new Error("Upload session is not pending");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (session.expiresAt > now) throw new Error("Upload session has not expired");
		await expirePendingUploadSession(
			session,
			now,
			session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
			tx,
		);
		return session.asset;
	});
}

export async function expirePendingMediaUploadSessions(
	input: { now: Date; limit: number },
	client: MediaTransactionClient,
): Promise<number> {
	const due = await client.mediaUploadSession.findMany({
		where: { status: "PENDING", expiresAt: { lte: input.now } },
		select: { id: true, asset: { select: { ownerId: true } } },
		orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
		take: Math.min(Math.max(input.limit, 1), 500),
	});
	let expired = 0;
	for (const session of due) {
		try {
			await expireMediaUploadSessionTransaction(
				{ sessionId: session.id, ownerId: session.asset.ownerId, now: input.now },
				client,
			);
			expired += 1;
		} catch (error) {
			if (!(error instanceof Error) || !/not pending|concurrently/i.test(error.message))
				throw error;
		}
	}
	return expired;
}

async function getDatabaseNow(client: Prisma.TransactionClient): Promise<Date> {
	const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
	if (!row) throw new Error("Database did not return its current time");
	return row.now;
}

async function expirePendingUploadSession(
	session: {
		id: string;
		assetId: string;
		multipartUploadId: string | null;
		asset: { objectKey: string };
	},
	now: Date,
	cleanup: "ABORT_MULTIPART" | "DELETE_OBJECT",
	tx: Prisma.TransactionClient,
): Promise<void> {
	const expired = await tx.mediaUploadSession.updateMany({
		where: { id: session.id, status: "PENDING", expiresAt: { lte: now } },
		data: { status: "EXPIRED" },
	});
	if (expired.count !== 1) {
		throw new Error("Upload session changed concurrently before expiration");
	}
	await tx.storageUsageReservation.updateMany({
		where: { referenceKey: `media-upload:${session.id}`, status: "ACTIVE" },
		data: { status: "EXPIRED", releasedAt: now },
	});
	await tx.outboxEvent.create({
		data: {
			eventType: cleanup === "ABORT_MULTIPART" ? "MEDIA_MULTIPART_ABORT" : "MEDIA_OBJECT_DELETE",
			aggregateType: "MEDIA_ASSET",
			aggregateId: session.assetId,
			dedupeKey: `media-upload-expire-cleanup:${session.id}`,
			payload: {
				assetId: session.assetId,
				objectKey: session.asset.objectKey,
				...(cleanup === "ABORT_MULTIPART" && session.multipartUploadId
					? { multipartUploadId: session.multipartUploadId }
					: {}),
			},
		},
	});
	await tx.auditLog.create({
		data: {
			action: "MEDIA_UPLOAD_EXPIRED",
			targetType: "MEDIA_UPLOAD_SESSION",
			targetId: session.id,
			before: { status: "PENDING" },
			after: { status: "EXPIRED" },
			metadata: { assetId: session.assetId },
		},
	});
}

export async function abortMediaUploadSessionTransaction(
	input: { sessionId: string; ownerId: string },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		if (session.status === "ABORTED") return session.asset;
		if (session.status !== "PENDING") throw new Error("Upload session cannot be aborted");
		await tx.mediaUploadSession.update({
			where: { id: session.id },
			data: { status: "ABORTED" },
		});
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		await tx.storageUsageReservation.updateMany({
			where: { referenceKey: `media-upload:${session.id}`, status: "ACTIVE" },
			data: { status: "RELEASED", releasedAt: new Date() },
		});
		await tx.outboxEvent.create({
			data: {
				eventType: session.multipartUploadId ? "MEDIA_MULTIPART_ABORT" : "MEDIA_OBJECT_DELETE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: session.assetId,
				dedupeKey: `media-upload-abort-cleanup:${session.id}`,
				payload: {
					assetId: session.assetId,
					objectKey: session.asset.objectKey,
					...(session.multipartUploadId ? { multipartUploadId: session.multipartUploadId } : {}),
				},
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_UPLOAD_ABORTED",
				targetType: "MEDIA_UPLOAD_SESSION",
				targetId: session.id,
				before: { status: "PENDING" },
				after: { status: "ABORTED" },
				metadata: { assetId: session.assetId },
			},
		});
		return asset;
	});
}

export async function markMediaAssetDeletedTransaction(
	input: { assetId: string; ownerId: string; now?: Date },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		const existing = await tx.mediaAsset.findFirst({
			where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId, deletedAt: null },
		});
		if (!existing) throw new Error("Media asset not found for owner");
		const now = input.now ?? new Date();
		const asset = await tx.mediaAsset.update({
			where: { id: existing.id },
			data: { status: "DELETED", deletedAt: now },
		});
		const uploadSession = await tx.mediaUploadSession.findFirst({
			where: { assetId: existing.id },
			select: { id: true },
		});
		if (uploadSession) {
			await tx.storageUsageReservation.updateMany({
				where: {
					referenceKey: `media-upload:${uploadSession.id}`,
					status: { in: ["ACTIVE", "COMMITTED"] },
				},
				data: { status: "RELEASED", releasedAt: now },
			});
		}
		await tx.outboxEvent.create({
			data: {
				eventType: "MEDIA_OBJECT_DELETE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: existing.id,
				dedupeKey: `media-object-delete:${existing.id}`,
				availableAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
				payload: {
					assetId: existing.id,
					objectKey: existing.objectKey,
					deleteBy: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
				},
			},
		});
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_ASSET_DELETED",
				targetType: "MEDIA_ASSET",
				targetId: existing.id,
				before: { status: existing.status },
				after: { status: "DELETED" },
				metadata: {},
			},
		});
		return asset;
	});
}

export async function getOwnedMediaAsset(
	assetId: string,
	ownerId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).mediaAsset.findFirst({
		where: { id: assetId, ownerType: "USER", ownerId },
	});
}

export async function getOwnedMediaUploadSession(
	sessionId: string,
	ownerId: string,
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).mediaUploadSession.findFirst({
		where: { id: sessionId, asset: { ownerType: "USER", ownerId } },
		include: { asset: true },
	});
}

export async function recordAssetModeration(
	input: {
		assetId: string;
		provider: string;
		status: "PENDING" | "APPROVED" | "REJECTED" | "ERROR";
		categories?: Prisma.InputJsonValue;
		rawEnvelope: Prisma.InputJsonValue;
	},
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).assetModerationResult.upsert({
		where: { assetId_provider: { assetId: input.assetId, provider: input.provider } },
		create: { ...input, categories: input.categories ?? {} },
		update: {
			status: input.status,
			categories: input.categories ?? {},
			rawEnvelope: input.rawEnvelope,
		},
	});
}

export async function reserveStorageUsage(
	input: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		bytes: bigint;
		referenceKey: string;
		expiresAt: Date;
	},
	client?: MediaDatabaseClient,
) {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	return getMediaDatabaseClient(client).storageUsageReservation.create({ data: input });
}

export async function finalizeStorageUsageReservation(
	id: string,
	status: "COMMITTED" | "RELEASED" | "EXPIRED",
	client?: MediaDatabaseClient,
) {
	return getMediaDatabaseClient(client).storageUsageReservation.updateMany({
		where: { id, status: "ACTIVE" },
		data: {
			status,
			releasedAt: status === "COMMITTED" ? null : new Date(),
		},
	});
}

export async function upsertGenerationDraft(
	input: {
		id?: string;
		claimTokenHash: string;
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		submittedByUserId: string;
		productKey?: string;
		inputSnapshot: Prisma.InputJsonValue;
		expiresAt: Date;
	},
	client?: MediaDatabaseClient,
) {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	const database = getMediaDatabaseClient(client);
	if (!input.id) return database.generationDraft.create({ data: input });
	const existing = await database.generationDraft.findFirst({
		where: { id: input.id, ownerType: "USER", ownerId: input.ownerId },
	});
	if (!existing) throw new Error("Generation draft not found for owner");
	return database.generationDraft.upsert({
		where: { id: input.id },
		create: input,
		update: {
			productKey: input.productKey,
			inputSnapshot: input.inputSnapshot,
			expiresAt: input.expiresAt,
		},
	});
}
