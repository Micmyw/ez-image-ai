import { randomUUID } from "node:crypto";

import type { MediaAssetKind, Prisma } from "../../generated/client";
import type { CursorPageInput, MediaDatabaseClient, MediaTransactionClient } from "./types";
import { getMediaDatabaseClient, isDatabaseUniqueConflict, runSerializable } from "./types";

const FINALIZATION_LEASE_MS = 5 * 60 * 1_000;
// Keep a terminal session's reservation until durable cleanup runs. This must stay
// at least as long as packages/storage/config.ts signedUploadExpiresSeconds.
const STAGING_WRITE_URL_GRACE_MS = 10 * 60 * 1_000;

const MEDIA_ASSET_READ_INCLUDE = {
	moderationResults: {
		orderBy: [
			{ verificationGeneration: "desc" },
			{ attemptNumber: "desc" },
			{ createdAt: "desc" },
			{ id: "desc" },
		],
		take: 1,
	},
	jobBindings: {
		where: { role: "OUTPUT" },
		take: 1,
		select: { jobId: true },
	},
} satisfies Prisma.MediaAssetInclude;

export type MediaAssetReadRecord = Prisma.MediaAssetGetPayload<{
	include: typeof MEDIA_ASSET_READ_INCLUDE;
}>;

export interface MediaAssetVerificationBoundary {
	provider: string;
	ruleVersion: string;
	policyVersion: string;
	now: Date;
}

export function hasCurrentApprovedMediaAssetEvidence(
	asset: Pick<
		MediaAssetReadRecord,
		| "status"
		| "deletedAt"
		| "kind"
		| "checksum"
		| "verificationGeneration"
		| "verificationAttemptCount"
		| "verificationProvider"
		| "verificationProviderTaskId"
		| "verificationRuleVersion"
		| "verificationPolicyVersion"
		| "verificationValidUntil"
		| "moderationResults"
	>,
	verification: MediaAssetVerificationBoundary,
): boolean {
	if (
		asset.status !== "READY" ||
		asset.deletedAt !== null ||
		!asset.checksum ||
		!/^[a-f0-9]{64}$/i.test(asset.checksum) ||
		asset.verificationAttemptCount < 1 ||
		asset.verificationProvider !== verification.provider ||
		asset.verificationRuleVersion !== verification.ruleVersion ||
		asset.verificationPolicyVersion !== verification.policyVersion ||
		asset.verificationValidUntil === null ||
		asset.verificationValidUntil <= verification.now
	) {
		return false;
	}

	const evidence = asset.moderationResults[0];
	return (
		evidence?.status === "APPROVED" &&
		evidence.assetChecksum === asset.checksum &&
		evidence.verificationGeneration === asset.verificationGeneration &&
		evidence.attemptNumber === asset.verificationAttemptCount &&
		evidence.evidenceKind === asset.kind &&
		evidence.provider === asset.verificationProvider &&
		evidence.providerTaskId === asset.verificationProviderTaskId &&
		evidence.ruleVersion === asset.verificationRuleVersion &&
		evidence.policyVersion === asset.verificationPolicyVersion &&
		evidence.validUntil !== null &&
		evidence.validUntil.getTime() === asset.verificationValidUntil.getTime() &&
		evidence.validUntil > verification.now
	);
}

type CleanupReservationStatus = "EXPIRED" | "RELEASED";

export type MediaUploadFinalizationClaim =
	| {
			outcome: "COMPLETED";
			asset: { id: string; status: string; mimeType: string; byteSize: bigint };
	  }
	| { outcome: "IN_PROGRESS"; asset: { id: string } }
	| {
			outcome: "CLAIMED";
			asset: { id: string; objectKey: string; mimeType: string };
			finalizationToken: string;
			finalizationParts: Prisma.InputJsonValue | null;
			multipartUploadId: string | null;
			stagingObjectKey: string;
	  };

type MediaUploadFinalizationClaimResult =
	| MediaUploadFinalizationClaim
	| {
			outcome: "EXPIRED";
			asset: { id: string; status: string; mimeType: string; byteSize: bigint };
	  };

type UploadSessionCleanupTarget = {
	id: string;
	assetId: string;
	multipartUploadId: string | null;
	stagingObjectKey: string | null;
	expiresAt: Date;
	asset: { objectKey: string };
};

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

export async function listReadableMediaAssets(
	input: CursorPageInput & {
		mimeTypePrefix?: "image/" | "video/";
		verification: MediaAssetVerificationBoundary;
	},
	client?: MediaDatabaseClient,
): Promise<{ items: MediaAssetReadRecord[]; hasMore: boolean }> {
	const take = Math.min(Math.max(input.take ?? 20, 1), 100);
	const targetCount = take + 1;
	const database = getMediaDatabaseClient(client);
	const items: MediaAssetReadRecord[] = [];
	let scanCursor = input.cursor;

	while (items.length < targetCount) {
		const scanTake = Math.min(100, Math.max(20, targetCount - items.length));
		const rows = await database.mediaAsset.findMany({
			where: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				status: "READY",
				deletedAt: null,
				checksum: { not: null },
				verificationAttemptCount: { gt: 0 },
				verificationProvider: input.verification.provider,
				verificationRuleVersion: input.verification.ruleVersion,
				verificationPolicyVersion: input.verification.policyVersion,
				verificationValidUntil: { gt: input.verification.now },
				moderationResults: {
					some: {
						status: "APPROVED",
						provider: input.verification.provider,
						ruleVersion: input.verification.ruleVersion,
						policyVersion: input.verification.policyVersion,
						validUntil: { gt: input.verification.now },
					},
				},
				...(input.mimeTypePrefix ? { mimeType: { startsWith: input.mimeTypePrefix } } : {}),
				...(scanCursor
					? {
							OR: [
								{ createdAt: { lt: scanCursor.createdAt } },
								{ createdAt: scanCursor.createdAt, id: { lt: scanCursor.id } },
							],
						}
					: {}),
			},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			include: MEDIA_ASSET_READ_INCLUDE,
			take: scanTake,
		});
		if (rows.length === 0) break;
		for (const asset of rows) {
			if (hasCurrentApprovedMediaAssetEvidence(asset, input.verification)) items.push(asset);
			if (items.length === targetCount) break;
		}
		const lastScanned = rows[rows.length - 1]!;
		scanCursor = { createdAt: lastScanned.createdAt, id: lastScanned.id };
		if (rows.length < scanTake) break;
	}

	return { items: items.slice(0, take), hasMore: items.length > take };
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
	stagingObjectKey: string;
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
	if (!input.stagingObjectKey || input.stagingObjectKey === input.objectKey) {
		throw new Error("Staging upload key must differ from final asset key");
	}
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
				stagingObjectKey: input.stagingObjectKey,
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
		leaseDurationMs?: number;
	},
	client: MediaTransactionClient,
): Promise<MediaUploadFinalizationClaim> {
	const result = await runSerializable<MediaUploadFinalizationClaimResult>(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
			include: { asset: true },
		});
		if (!session) throw new Error("Upload session not found for owner");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (session.status === "COMPLETED") return { outcome: "COMPLETED", asset: session.asset };
		if (session.asset.deletedAt || session.asset.status !== "UPLOADING") {
			throw new Error("Upload session asset is not active");
		}
		if (session.status === "FINALIZING") {
			if (!session.finalizationLeaseExpiresAt || session.finalizationLeaseExpiresAt > now) {
				return { outcome: "IN_PROGRESS", asset: session.asset };
			}
			if (session.expiresAt <= now) {
				await expireFinalizingUploadSession(
					session,
					now,
					session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
					tx,
				);
				return { outcome: "EXPIRED", asset: session.asset };
			}
			return reclaimMediaUploadFinalizationLease(session, input, now, tx);
		}
		if (session.status !== "PENDING") throw new Error("Upload session is not pending");
		if (!session.stagingObjectKey) {
			throw new Error("Legacy upload session cannot be finalized safely");
		}
		if (session.expiresAt <= now) {
			await expirePendingUploadSession(
				session,
				now,
				session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
				tx,
			);
			return { outcome: "EXPIRED", asset: session.asset };
		}
		const finalizationToken = randomUUID();
		const finalizationLeaseExpiresAt = new Date(
			now.getTime() + normalizeLeaseDuration(input.leaseDurationMs),
		);
		const claimed = await tx.mediaUploadSession.updateMany({
			where: { id: session.id, status: "PENDING", expiresAt: { gt: now } },
			data: {
				status: "FINALIZING",
				finalizationToken,
				finalizationLeaseExpiresAt,
				...(input.parts === undefined ? {} : { finalizationParts: input.parts }),
			},
		});
		if (claimed.count !== 1) return { outcome: "IN_PROGRESS", asset: session.asset };
		return {
			outcome: "CLAIMED" as const,
			asset: session.asset,
			finalizationToken,
			finalizationLeaseExpiresAt,
			finalizationParts: input.parts ?? null,
			multipartUploadId: session.multipartUploadId,
			stagingObjectKey: session.stagingObjectKey,
		};
	});
	if (result.outcome === "EXPIRED") throw new MediaUploadSessionExpiredError();
	return result;
}

async function reclaimMediaUploadFinalizationLease(
	session: {
		id: string;
		asset: { id: string; objectKey: string; mimeType: string };
		multipartUploadId: string | null;
		stagingObjectKey: string | null;
		finalizationParts: Prisma.JsonValue | null;
	},
	input: {
		parts?: Prisma.InputJsonValue;
		leaseDurationMs?: number;
	},
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<MediaUploadFinalizationClaim> {
	if (!session.stagingObjectKey) {
		throw new Error("Legacy upload session cannot be finalized safely");
	}
	const finalizationToken = randomUUID();
	const finalizationLeaseExpiresAt = new Date(
		now.getTime() + normalizeLeaseDuration(input.leaseDurationMs),
	);
	const finalizationParts = session.finalizationParts ?? input.parts ?? null;
	const claimed = await tx.mediaUploadSession.updateMany({
		where: {
			id: session.id,
			status: "FINALIZING",
			finalizationLeaseExpiresAt: { lte: now },
		},
		data: {
			finalizationToken,
			finalizationLeaseExpiresAt,
			legacyFinalizationToken: null,
			...(session.finalizationParts === null && input.parts !== undefined
				? { finalizationParts: input.parts }
				: {}),
		},
	});
	if (claimed.count !== 1) return { outcome: "IN_PROGRESS", asset: session.asset };
	return {
		outcome: "CLAIMED",
		asset: session.asset,
		finalizationToken,
		finalizationParts,
		multipartUploadId: session.multipartUploadId,
		stagingObjectKey: session.stagingObjectKey,
	};
}

function normalizeLeaseDuration(value: number | undefined): number {
	if (!Number.isSafeInteger(value) || !value || value <= 0) return FINALIZATION_LEASE_MS;
	return value;
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
		if (session.status !== "PENDING") {
			throw new Error("Upload session cannot be failed");
		}
		const now = await getDatabaseNow(tx);
		const changed = await tx.mediaUploadSession.updateMany({
			where: { id: session.id, status: "PENDING" },
			data: { status: "ABORTED" },
		});
		if (changed.count !== 1) throw new Error("Upload session changed concurrently before failure");
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: { status: "DELETED", deletedAt: now },
		});
		await queueStagingCleanup(
			session,
			session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
			"media-upload-invalid-cleanup",
			stagingCleanupAvailableAt(now),
			"RELEASED",
			tx,
		);
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

export async function failMediaUploadSessionFinalizationTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		finalizationToken: string;
		reason: string;
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
		if (session.status === "COMPLETED") return session.asset;
		if (session.asset.deletedAt || session.asset.status !== "UPLOADING") {
			throw new Error("Upload session asset is not active");
		}
		if (session.status !== "FINALIZING" || session.finalizationToken !== input.finalizationToken) {
			throw new Error("Upload session finalization is not owned by this token");
		}
		const now = input.now ?? (await getDatabaseNow(tx));
		if (!session.finalizationLeaseExpiresAt || session.finalizationLeaseExpiresAt <= now) {
			throw new Error("Upload session finalization lease expired");
		}
		const changed = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
			},
			data: {
				status: "ABORTED",
				finalizationToken: null,
				finalizationLeaseExpiresAt: null,
			},
		});
		if (changed.count !== 1) {
			throw new Error("Upload session changed concurrently before finalization failure");
		}
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: { status: "DELETED", deletedAt: now },
		});
		await queueStagingCleanup(
			session,
			session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
			"media-upload-finalization-failure-cleanup",
			stagingCleanupAvailableAt(now),
			"RELEASED",
			tx,
			[session.asset.objectKey],
		);
		await tx.auditLog.create({
			data: {
				actorUserId: input.ownerId,
				action: "MEDIA_UPLOAD_REJECTED",
				targetType: "MEDIA_UPLOAD_SESSION",
				targetId: session.id,
				before: { status: "FINALIZING" },
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
		finalizationToken: string;
		now?: Date;
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
		if (session.asset.deletedAt || session.asset.status !== "UPLOADING") {
			throw new Error("Upload session asset is not active");
		}
		if (session.status !== "FINALIZING" || session.finalizationToken !== input.finalizationToken) {
			throw new Error("Upload session is not finalizing with this token");
		}
		const now = input.now ?? (await getDatabaseNow(tx));
		if (!session.finalizationLeaseExpiresAt || session.finalizationLeaseExpiresAt <= now) {
			throw new Error("Upload session finalization lease expired");
		}
		const completion = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
			},
			data: {
				status: "COMPLETED",
				completedAt: now,
				finalizationToken: null,
				finalizationLeaseExpiresAt: null,
			},
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
		await queueStagingCleanup(
			session,
			"DELETE_OBJECT",
			"media-upload-staging-expire-cleanup",
			stagingCleanupAvailableAt(now),
			undefined,
			tx,
		);
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
		const now = input.now ?? (await getDatabaseNow(tx));
		if (session.status === "PENDING") {
			if (session.expiresAt > now) throw new Error("Upload session has not expired");
			await expirePendingUploadSession(
				session,
				now,
				session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
				tx,
			);
			return session.asset;
		}
		if (session.status !== "FINALIZING") throw new Error("Upload session cannot be swept");
		if (!session.finalizationLeaseExpiresAt || session.finalizationLeaseExpiresAt > now) {
			throw new Error("Upload session finalization lease is active");
		}
		if (session.expiresAt <= now) {
			await expireFinalizingUploadSession(
				session,
				now,
				session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
				tx,
			);
			return session.asset;
		}
		await reopenExpiredFinalizationLease(session, now, tx);
		return session.asset;
	});
}

export async function expirePendingMediaUploadSessions(
	input: { now: Date; limit: number },
	client: MediaTransactionClient,
): Promise<number> {
	const due = await client.mediaUploadSession.findMany({
		where: {
			OR: [
				{ status: "PENDING", expiresAt: { lte: input.now } },
				{ status: "FINALIZING", finalizationLeaseExpiresAt: { lte: input.now } },
			],
		},
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
			if (
				!(error instanceof Error) ||
				!/cannot be swept|lease is active|concurrently/i.test(error.message)
			)
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
	session: UploadSessionCleanupTarget,
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
	await queueStagingCleanup(
		session,
		cleanup,
		"media-upload-staging-expire-cleanup",
		stagingCleanupAvailableAt(now),
		"EXPIRED",
		tx,
		[session.asset.objectKey],
	);
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

async function expireFinalizingUploadSession(
	session: UploadSessionCleanupTarget,
	now: Date,
	cleanup: "ABORT_MULTIPART" | "DELETE_OBJECT",
	tx: Prisma.TransactionClient,
): Promise<void> {
	await reopenExpiredFinalizationLease(session, now, tx);
	await expirePendingUploadSession(session, now, cleanup, tx);
}

async function reopenExpiredFinalizationLease(
	session: Pick<UploadSessionCleanupTarget, "id">,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const reopened = await tx.mediaUploadSession.updateMany({
		where: {
			id: session.id,
			status: "FINALIZING",
			finalizationLeaseExpiresAt: { lte: now },
		},
		data: {
			status: "PENDING",
			finalizationToken: null,
			finalizationLeaseExpiresAt: null,
			legacyFinalizationToken: null,
		},
	});
	if (reopened.count !== 1)
		throw new Error("Upload session changed concurrently before lease sweep");
}

async function queueStagingCleanup(
	session: {
		id: string;
		assetId: string;
		multipartUploadId: string | null;
		stagingObjectKey: string | null;
		expiresAt: Date;
	},
	cleanup: "ABORT_MULTIPART" | "DELETE_OBJECT",
	dedupePrefix: string,
	availableAt: Date,
	reservationStatus: CleanupReservationStatus | undefined,
	tx: Prisma.TransactionClient,
	cleanupObjectKeys: string[] = [],
): Promise<void> {
	if (!session.stagingObjectKey) return;
	const additionalObjectKeys = [...new Set(cleanupObjectKeys)].filter(
		(objectKey) => objectKey !== session.stagingObjectKey,
	);
	await tx.outboxEvent.create({
		data: {
			eventType: "MEDIA_UPLOAD_CLEANUP",
			aggregateType: "MEDIA_ASSET",
			aggregateId: session.assetId,
			dedupeKey: `${dedupePrefix}:${session.id}`,
			availableAt,
			payload: {
				assetId: session.assetId,
				objectKey: session.stagingObjectKey,
				...(additionalObjectKeys.length ? { cleanupObjectKeys: additionalObjectKeys } : {}),
				...(reservationStatus ? { uploadSessionId: session.id, reservationStatus } : {}),
				...(cleanup === "ABORT_MULTIPART" && session.multipartUploadId
					? { multipartUploadId: session.multipartUploadId }
					: {}),
			},
		},
	});
}

function stagingCleanupAvailableAt(now: Date): Date {
	return new Date(now.getTime() + STAGING_WRITE_URL_GRACE_MS);
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
		const now = await getDatabaseNow(tx);
		await tx.mediaUploadSession.update({
			where: { id: session.id },
			data: { status: "ABORTED" },
		});
		const asset = await tx.mediaAsset.update({
			where: { id: session.assetId },
			data: { status: "DELETED", deletedAt: now },
		});
		await queueStagingCleanup(
			session,
			session.multipartUploadId ? "ABORT_MULTIPART" : "DELETE_OBJECT",
			"media-upload-abort-cleanup",
			stagingCleanupAvailableAt(now),
			"RELEASED",
			tx,
		);
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
			where: {
				id: input.assetId,
				ownerType: "USER",
				ownerId: input.ownerId,
				deletedAt: null,
				status: { not: "UPLOADING" },
			},
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

export async function getOwnedMediaAssetReadState(
	input: {
		assetId: string;
		ownerId: string;
		verification: MediaAssetVerificationBoundary;
	},
	client?: MediaDatabaseClient,
) {
	const asset = await getMediaDatabaseClient(client).mediaAsset.findFirst({
		where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId },
		include: MEDIA_ASSET_READ_INCLUDE,
	});
	if (!asset) return null;
	return {
		asset,
		readable: hasCurrentApprovedMediaAssetEvidence(asset, input.verification),
	};
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
		validUntil?: Date | null;
		categories?: Prisma.InputJsonValue;
		rawEnvelope: Prisma.InputJsonValue;
	},
	client?: MediaDatabaseClient,
) {
	const database = getMediaDatabaseClient(client);
	if (input.status === "APPROVED" && (!input.validUntil || input.validUntil <= new Date())) {
		throw new Error("APPROVED_MODERATION_EVIDENCE_REQUIRES_FUTURE_EXPIRY");
	}
	for (let appendAttempt = 1; appendAttempt <= 8; appendAttempt += 1) {
		const asset = await database.mediaAsset.findUniqueOrThrow({
			where: { id: input.assetId },
			select: {
				id: true,
				kind: true,
				checksum: true,
				verificationGeneration: true,
				verificationProviderTaskId: true,
			},
		});
		const latest = await database.assetModerationResult.aggregate({
			where: {
				assetId: input.assetId,
				verificationGeneration: asset.verificationGeneration,
			},
			_max: { attemptNumber: true },
		});
		const categories = input.categories ?? {};
		try {
			return await database.assetModerationResult.create({
				data: {
					...input,
					assetChecksum:
						asset.checksum && /^[a-f0-9]{64}$/i.test(asset.checksum) ? asset.checksum : null,
					verificationGeneration: asset.verificationGeneration,
					attemptNumber: (latest._max.attemptNumber ?? 0) + 1,
					evidenceKind: asset.kind,
					providerTaskId: asset.verificationProviderTaskId,
					ruleVersion: moderationCategory(categories, "ruleVersion") ?? "legacy-api",
					policyVersion: moderationCategory(categories, "policyVersion") ?? "legacy-api",
					reasonCode: moderationCategory(categories, "reasonCode") ?? input.status,
					categories,
					validUntil: input.status === "APPROVED" ? input.validUntil : null,
				},
			});
		} catch (error) {
			if (appendAttempt < 8 && isDatabaseUniqueConflict(error)) continue;
			throw error;
		}
	}
	throw new Error("MODERATION_EVIDENCE_APPEND_RETRY_EXHAUSTED");
}

function moderationCategory(value: Prisma.InputJsonValue, key: string): string | undefined {
	if (!value || Array.isArray(value) || typeof value !== "object" || "toJSON" in value) {
		return undefined;
	}
	const selected = (value as Prisma.InputJsonObject)[key];
	return typeof selected === "string" && selected.length > 0 ? selected : undefined;
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
