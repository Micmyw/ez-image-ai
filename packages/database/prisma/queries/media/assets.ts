import { randomUUID } from "node:crypto";

import type { MediaAssetKind, Prisma } from "../../generated/client";
import {
	LIVE_GENERATION_JOB_STATUSES,
	lockMediaAssetGenerationBindings,
} from "./asset-binding-locks";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
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
			promotionMultipartUploadId: string | null;
			promotionToken: string | null;
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
	stagedTerminalizationToken: string | null;
	promotionMultipartUploadId: string | null;
	promotionToken: string | null;
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
		await lockOwnerStorageUsage(input, tx);
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
				stagedTerminalizationToken: randomUUID(),
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
			where: {
				id: session.id,
				status: "PENDING",
				expiresAt: { gt: now },
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
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
			promotionMultipartUploadId: null,
			promotionToken: null,
			stagingObjectKey: session.stagingObjectKey,
		};
	});
	if (result.outcome === "EXPIRED") throw new MediaUploadSessionExpiredError();
	return result;
}

async function reclaimMediaUploadFinalizationLease(
	session: {
		id: string;
		assetId: string;
		asset: { id: string; objectKey: string; mimeType: string };
		multipartUploadId: string | null;
		stagingObjectKey: string | null;
		finalizationParts: Prisma.JsonValue | null;
		promotionMultipartUploadId: string | null;
		promotionToken: string | null;
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
	assertPromotionMultipartPair(session);
	if (session.promotionMultipartUploadId && session.promotionToken) {
		await queuePromotionAbortOnly(session, tx);
	}
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
			promotionMultipartUploadId: null,
			promotionToken: null,
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
		promotionMultipartUploadId: null,
		promotionToken: null,
		stagingObjectKey: session.stagingObjectKey,
	};
}

export async function recordMediaUploadPromotionMultipartTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		finalizationToken: string;
		multipartUploadId: string;
		promotionToken: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ multipartUploadId: string; promotionToken: string }> {
	if (!input.multipartUploadId || !input.promotionToken) {
		throw new Error("Promotion multipart upload ID and token are required");
	}
	return runSerializable(client, async (tx) => {
		const session = await tx.mediaUploadSession.findFirst({
			where: { id: input.sessionId, asset: { ownerType: "USER", ownerId: input.ownerId } },
		});
		if (!session) throw new Error("Upload session not found for owner");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (
			session.status !== "FINALIZING" ||
			session.finalizationToken !== input.finalizationToken ||
			!session.finalizationLeaseExpiresAt ||
			session.finalizationLeaseExpiresAt <= now
		) {
			throw new Error("Upload session finalization is not owned by this token");
		}
		assertPromotionMultipartPair(session);
		if (session.promotionMultipartUploadId && session.promotionToken) {
			if (
				session.promotionMultipartUploadId === input.multipartUploadId &&
				session.promotionToken === input.promotionToken
			) {
				return {
					multipartUploadId: session.promotionMultipartUploadId,
					promotionToken: session.promotionToken,
				};
			}
			throw new Error("Upload session already has a durable promotion multipart");
		}
		const recorded = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
			data: {
				promotionMultipartUploadId: input.multipartUploadId,
				promotionToken: input.promotionToken,
			},
		});
		if (recorded.count !== 1) {
			throw new Error("Upload session changed concurrently before promotion registration");
		}
		return { multipartUploadId: input.multipartUploadId, promotionToken: input.promotionToken };
	});
}

/**
 * Extends the active finalization lease before a caller performs destructive
 * storage recovery. The token CAS is a fencing point: callers must snapshot
 * candidate multipart IDs before this operation and never list again after it.
 */
export async function renewMediaUploadSessionFinalizationLeaseTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		finalizationToken: string;
		now?: Date;
		leaseDurationMs?: number;
	},
	client: MediaTransactionClient,
): Promise<{ finalizationLeaseExpiresAt: Date }> {
	return runSerializable(client, async (tx) => {
		const now = input.now ?? (await getDatabaseNow(tx));
		const finalizationLeaseExpiresAt = new Date(
			now.getTime() + normalizeLeaseDuration(input.leaseDurationMs),
		);
		const renewed = await tx.mediaUploadSession.updateMany({
			where: {
				id: input.sessionId,
				asset: { ownerType: "USER", ownerId: input.ownerId },
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
			data: { finalizationLeaseExpiresAt },
		});
		if (renewed.count !== 1) {
			throw new Error("Upload session finalization is not owned by this token");
		}
		return { finalizationLeaseExpiresAt };
	});
}

export async function clearMediaUploadPromotionMultipartTransaction(
	input: {
		sessionId: string;
		ownerId: string;
		finalizationToken: string;
		multipartUploadId: string;
		promotionToken: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<void> {
	return runSerializable(client, async (tx) => {
		const now = input.now ?? (await getDatabaseNow(tx));
		const cleared = await tx.mediaUploadSession.updateMany({
			where: {
				id: input.sessionId,
				asset: { ownerType: "USER", ownerId: input.ownerId },
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
				promotionMultipartUploadId: input.multipartUploadId,
				promotionToken: input.promotionToken,
			},
			data: { promotionMultipartUploadId: null, promotionToken: null },
		});
		if (cleared.count !== 1) {
			throw new Error("Upload session final promotion multipart is not owned by this token");
		}
	});
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
		if (!session.stagedTerminalizationToken) {
			throw new Error("Upload session staged terminalization token is missing");
		}
		const changed = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "PENDING",
				stagedTerminalizationToken: session.stagedTerminalizationToken,
			},
			data: {
				status: "ABORTED",
				stagedTerminalizationToken: null,
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
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
			[session.asset.objectKey],
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
				stagedTerminalizationToken: null,
				promotionMultipartUploadId: null,
				promotionToken: null,
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
		promotion?: { multipartUploadId: string; promotionToken: string };
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
		assertPromotionMultipartPair(session);
		if (session.promotionMultipartUploadId && session.promotionToken) {
			if (
				input.promotion?.multipartUploadId !== session.promotionMultipartUploadId ||
				input.promotion?.promotionToken !== session.promotionToken
			) {
				throw new Error("Upload session final promotion multipart is not owned by this token");
			}
		} else if (input.promotion) {
			throw new Error("Upload session has no durable final promotion multipart");
		}
		const completion = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "FINALIZING",
				finalizationToken: input.finalizationToken,
				finalizationLeaseExpiresAt: { gt: now },
				...(session.promotionMultipartUploadId && session.promotionToken
					? {
							promotionMultipartUploadId: session.promotionMultipartUploadId,
							promotionToken: session.promotionToken,
						}
					: { promotionMultipartUploadId: null, promotionToken: null }),
			},
			data: {
				status: "COMPLETED",
				completedAt: now,
				finalizationToken: null,
				finalizationLeaseExpiresAt: null,
				stagedTerminalizationToken: null,
				promotionMultipartUploadId: null,
				promotionToken: null,
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
		orderBy: [
			{ finalizationLeaseExpiresAt: { sort: "asc", nulls: "last" } },
			{ expiresAt: "asc" },
			{ id: "asc" },
		],
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
	if (!session.stagedTerminalizationToken) {
		throw new Error("Upload session staged terminalization token is missing");
	}
	const expired = await tx.mediaUploadSession.updateMany({
		where: {
			id: session.id,
			status: "PENDING",
			expiresAt: { lte: now },
			stagedTerminalizationToken: session.stagedTerminalizationToken,
		},
		data: {
			status: "EXPIRED",
			stagedTerminalizationToken: null,
			promotionMultipartUploadId: null,
			promotionToken: null,
		},
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
	const reopened = await reopenExpiredFinalizationLease(session, now, tx);
	await expirePendingUploadSession(
		{ ...session, stagedTerminalizationToken: reopened.stagedTerminalizationToken },
		now,
		cleanup,
		tx,
	);
}

async function reopenExpiredFinalizationLease(
	session: Pick<
		UploadSessionCleanupTarget,
		| "id"
		| "assetId"
		| "stagingObjectKey"
		| "stagedTerminalizationToken"
		| "promotionMultipartUploadId"
		| "promotionToken"
		| "asset"
	>,
	now: Date,
	tx: Prisma.TransactionClient,
): Promise<{ stagedTerminalizationToken: string | null }> {
	assertPromotionMultipartPair(session);
	if (session.promotionMultipartUploadId && session.promotionToken) {
		await queuePromotionAbortOnly(session, tx);
	}
	const stagedTerminalizationToken = session.stagingObjectKey
		? (session.stagedTerminalizationToken ?? randomUUID())
		: session.stagedTerminalizationToken;
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
			...(stagedTerminalizationToken ? { stagedTerminalizationToken } : {}),
			promotionMultipartUploadId: null,
			promotionToken: null,
		},
	});
	if (reopened.count !== 1)
		throw new Error("Upload session changed concurrently before lease sweep");
	return { stagedTerminalizationToken };
}

async function queueStagingCleanup(
	session: {
		id: string;
		assetId: string;
		multipartUploadId: string | null;
		stagingObjectKey: string | null;
		promotionMultipartUploadId?: string | null;
		promotionToken?: string | null;
		asset?: { objectKey: string };
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
	assertPromotionMultipartPair(session);
	const promotionObjectKey = session.asset?.objectKey;
	const shouldCleanPromotion = Boolean(
		promotionObjectKey && additionalObjectKeys.includes(promotionObjectKey),
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
				...(shouldCleanPromotion && promotionObjectKey ? { promotionObjectKey } : {}),
				...(shouldCleanPromotion && session.promotionMultipartUploadId && session.promotionToken
					? {
							promotionMultipartUploadId: session.promotionMultipartUploadId,
							promotionToken: session.promotionToken,
						}
					: {}),
				...(cleanup === "ABORT_MULTIPART" && session.multipartUploadId
					? { multipartUploadId: session.multipartUploadId }
					: {}),
			},
		},
	});
}

function assertPromotionMultipartPair(session: {
	promotionMultipartUploadId?: string | null;
	promotionToken?: string | null;
}): void {
	const hasMultipartUploadId = session.promotionMultipartUploadId != null;
	const hasPromotionToken = session.promotionToken != null;
	if (hasMultipartUploadId !== hasPromotionToken) {
		throw new Error("Upload session promotion multipart state is incomplete");
	}
}

async function queuePromotionAbortOnly(
	session: {
		id: string;
		assetId: string;
		promotionMultipartUploadId: string | null;
		promotionToken: string | null;
		asset: { objectKey: string };
	},
	tx: Prisma.TransactionClient,
): Promise<void> {
	if (!session.promotionMultipartUploadId || !session.promotionToken) return;
	await tx.outboxEvent.create({
		data: {
			eventType: "MEDIA_UPLOAD_CLEANUP",
			aggregateType: "MEDIA_ASSET",
			aggregateId: session.assetId,
			dedupeKey: `media-upload-promotion-abort:${session.id}:${session.promotionToken}`,
			payload: {
				assetId: session.assetId,
				objectKey: session.asset.objectKey,
				multipartUploadId: session.promotionMultipartUploadId,
				promotionAbortOnly: true,
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
		if (!session.stagedTerminalizationToken) {
			throw new Error("Upload session staged terminalization token is missing");
		}
		const aborted = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				status: "PENDING",
				stagedTerminalizationToken: session.stagedTerminalizationToken,
			},
			data: {
				status: "ABORTED",
				stagedTerminalizationToken: null,
				promotionMultipartUploadId: null,
				promotionToken: null,
			},
		});
		if (aborted.count !== 1) throw new Error("Upload session changed concurrently before abort");
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
			[session.asset.objectKey],
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

export interface CreateGenerationOutputAssetBindingInput {
	jobId: string;
	asset: {
		id: string;
		ownerId: string;
		objectKey: string;
		mimeType: string;
		byteSize: bigint;
		checksum: string;
		sourceUrl: string;
	};
}

/**
 * Makes an output asset durable and ties it to its FINALIZING job in the same
 * serializable transaction. The asset must never be visible as READY before
 * the settlement path can find the OUTPUT binding.
 */
export async function createGenerationOutputAssetBindingTransaction(
	input: CreateGenerationOutputAssetBindingInput,
	client: MediaTransactionClient,
) {
	if (!/^[a-f0-9]{64}$/i.test(input.asset.checksum)) {
		throw new Error("GENERATION_OUTPUT_CHECKSUM_INVALID");
	}
	return runSerializable(client, async (tx) => {
		await lockMediaAssetGenerationBindings([input.asset.id], tx);
		const job = await tx.generationJob.findFirst({
			where: {
				id: input.jobId,
				ownerType: "USER",
				ownerId: input.asset.ownerId,
				status: "FINALIZING",
			},
			select: { id: true },
		});
		if (!job) throw new Error("GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT");

		let asset = await tx.mediaAsset.findUnique({ where: { id: input.asset.id } });
		if (asset) {
			const matchesCandidate =
				asset.ownerType === "USER" &&
				asset.ownerId === input.asset.ownerId &&
				asset.kind === "OUTPUT" &&
				asset.objectKey === input.asset.objectKey &&
				asset.mimeType === input.asset.mimeType &&
				asset.byteSize === input.asset.byteSize &&
				asset.checksum === input.asset.checksum &&
				asset.sourceUrl === input.asset.sourceUrl;
			if (!matchesCandidate) throw new Error("GENERATION_OUTPUT_ASSET_CONFLICT");
			if (asset.status === "DELETED" || asset.deletedAt) {
				throw new Error("GENERATION_OUTPUT_ASSET_DELETED");
			}
		} else {
			asset = await tx.mediaAsset.create({
				data: {
					id: input.asset.id,
					ownerType: "USER",
					ownerId: input.asset.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: input.asset.objectKey,
					mimeType: input.asset.mimeType,
					byteSize: input.asset.byteSize,
					checksum: input.asset.checksum,
					sourceUrl: input.asset.sourceUrl,
				},
			});
		}

		await tx.generationJobAsset.upsert({
			where: {
				jobId_assetId_role: {
					jobId: job.id,
					assetId: asset.id,
					role: "OUTPUT",
				},
			},
			create: {
				jobId: job.id,
				assetId: asset.id,
				assetChecksum: input.asset.checksum,
				role: "OUTPUT",
				position: 0,
			},
			update: { assetChecksum: input.asset.checksum },
		});
		return asset;
	});
}

export interface ClaimGenerationOutputTransferInput {
	jobId: string;
	ownerId: string;
	assetId: string;
	objectKey: string;
	mimeType: string;
	sourceUrl: string;
	createStagingObjectKey: (transferToken: string) => string;
	now?: Date;
	leaseDurationMs?: number;
}

type GenerationOutputTransferAsset = {
	id: string;
	status: string;
	objectKey: string;
	mimeType: string;
	byteSize: bigint;
	checksum: string | null;
	storageEtag: string | null;
	storageVersionId: string | null;
	finalizedAt: Date | null;
};

export type GenerationOutputTransferClaim =
	| { outcome: "COMPLETED"; asset: GenerationOutputTransferAsset }
	| { outcome: "IN_PROGRESS"; asset: { id: string } }
	| {
			outcome: "CLAIMED";
			asset: GenerationOutputTransferAsset;
			transferToken: string;
			stagingObjectKey: string;
			promotionMultipartUploadId: string | null;
	  };

export class GenerationOutputStorageError extends Error {
	readonly code = "STORAGE_QUOTA_EXCEEDED" as const;
	readonly stage = "TRANSFER" as const;
	readonly retryable = false as const;

	constructor() {
		super("STORAGE_QUOTA_EXCEEDED");
		this.name = "GenerationOutputStorageError";
	}
}

/**
 * Serializes all writes for one deterministic output asset before any storage
 * transfer begins. A claim owns an isolated staging key; final-object writes
 * are still conditional in the storage provider and this token fences the
 * database commit that follows promotion.
 */
export async function claimGenerationOutputTransferTransaction(
	input: ClaimGenerationOutputTransferInput,
	client: MediaTransactionClient,
): Promise<GenerationOutputTransferClaim> {
	return runSerializable(client, async (tx) => {
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const now = input.now ?? (await getDatabaseNow(tx));
		const job = await tx.generationJob.findFirst({
			where: {
				id: input.jobId,
				ownerType: "USER",
				ownerId: input.ownerId,
				status: "FINALIZING",
			},
			select: { id: true },
		});
		if (!job) throw new Error("GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT");

		let asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
		if (asset) {
			assertGenerationOutputTransferAssetMatches(asset, input);
			if (asset.status === "DELETED" || asset.deletedAt) {
				throw new Error("GENERATION_OUTPUT_ASSET_DELETED");
			}
			if (asset.status === "READY" || asset.status === "QUARANTINED") {
				await bindGenerationOutputAsset(job.id, asset.id, tx);
				return { outcome: "COMPLETED", asset: outputTransferAsset(asset) };
			}
			if (asset.status !== "VERIFYING") {
				throw new Error("GENERATION_OUTPUT_ASSET_NOT_VERIFYING");
			}
			if (asset.outputTransferToken) {
				if (!asset.outputTransferLeaseExpiresAt || !asset.outputStagingObjectKey) {
					throw new Error("GENERATION_OUTPUT_TRANSFER_STATE_INCOMPLETE");
				}
				if (asset.outputTransferLeaseExpiresAt > now) {
					await bindGenerationOutputAsset(job.id, asset.id, tx);
					return { outcome: "IN_PROGRESS", asset: { id: asset.id } };
				}
				await queueGenerationOutputStagingDeletion(
					asset.id,
					asset.outputStagingObjectKey,
					asset.outputTransferToken,
					tx,
				);
				if (asset.outputPromotionMultipartUploadId) {
					await queueGenerationOutputPromotionAbort(
						asset.id,
						asset.objectKey,
						asset.outputPromotionMultipartUploadId,
						asset.outputTransferToken,
						tx,
					);
				}
			} else if (
				asset.outputTransferLeaseExpiresAt ||
				asset.outputStagingObjectKey ||
				asset.outputPromotionMultipartUploadId
			) {
				throw new Error("GENERATION_OUTPUT_TRANSFER_STATE_INCOMPLETE");
			} else if (asset.finalizedAt) {
				await bindGenerationOutputAsset(job.id, asset.id, tx);
				return { outcome: "COMPLETED", asset: outputTransferAsset(asset) };
			}
		}

		const transferToken = randomUUID();
		const stagingObjectKey = createGenerationOutputStagingObjectKey(input, transferToken);
		const outputTransferLeaseExpiresAt = new Date(
			now.getTime() + normalizeLeaseDuration(input.leaseDurationMs),
		);
		if (!asset) {
			asset = await tx.mediaAsset.create({
				data: {
					id: input.assetId,
					ownerType: "USER",
					ownerId: input.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: input.objectKey,
					mimeType: input.mimeType,
					byteSize: 0n,
					sourceUrl: input.sourceUrl,
					outputTransferToken: transferToken,
					outputTransferLeaseExpiresAt,
					outputStagingObjectKey: stagingObjectKey,
				},
			});
		} else {
			const reclaimed = await tx.mediaAsset.updateMany({
				where: {
					id: asset.id,
					status: "VERIFYING",
					outputTransferToken: asset.outputTransferToken,
				},
				data: {
					outputTransferToken: transferToken,
					outputTransferLeaseExpiresAt,
					outputStagingObjectKey: stagingObjectKey,
					outputPromotionMultipartUploadId: null,
				},
			});
			if (reclaimed.count !== 1) {
				throw new Error("GENERATION_OUTPUT_TRANSFER_CHANGED_CONCURRENTLY");
			}
			asset = {
				...asset,
				outputTransferToken: transferToken,
				outputTransferLeaseExpiresAt,
				outputStagingObjectKey: stagingObjectKey,
				outputPromotionMultipartUploadId: null,
			};
		}
		await bindGenerationOutputAsset(job.id, asset.id, tx);
		return {
			outcome: "CLAIMED",
			asset: outputTransferAsset(asset),
			transferToken,
			stagingObjectKey,
			promotionMultipartUploadId: null,
		};
	});
}

export async function recordGenerationOutputPromotionMultipartTransaction(
	input: {
		assetId: string;
		ownerId: string;
		transferToken: string;
		multipartUploadId: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ multipartUploadId: string }> {
	if (!input.multipartUploadId)
		throw new Error("Generation output promotion multipart ID is required");
	return runSerializable(client, async (tx) => {
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const asset = await tx.mediaAsset.findFirst({
			where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId },
		});
		if (!asset) throw new Error("Generation output asset not found for owner");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (
			asset.status !== "VERIFYING" ||
			asset.outputTransferToken !== input.transferToken ||
			!asset.outputTransferLeaseExpiresAt ||
			asset.outputTransferLeaseExpiresAt <= now
		) {
			throw new Error("GENERATION_OUTPUT_TRANSFER_NOT_OWNED");
		}
		if (asset.outputPromotionMultipartUploadId) {
			if (asset.outputPromotionMultipartUploadId === input.multipartUploadId) {
				return { multipartUploadId: asset.outputPromotionMultipartUploadId };
			}
			throw new Error("GENERATION_OUTPUT_PROMOTION_MULTIPART_ALREADY_RECORDED");
		}
		const recorded = await tx.mediaAsset.updateMany({
			where: {
				id: asset.id,
				status: "VERIFYING",
				outputTransferToken: input.transferToken,
				outputTransferLeaseExpiresAt: { gt: now },
				outputPromotionMultipartUploadId: null,
			},
			data: { outputPromotionMultipartUploadId: input.multipartUploadId },
		});
		if (recorded.count !== 1) throw new Error("GENERATION_OUTPUT_TRANSFER_CHANGED_CONCURRENTLY");
		return { multipartUploadId: input.multipartUploadId };
	});
}

/**
 * Reserves aggregate owner storage before the caller can promote a staged
 * provider output to its durable final key. The owner advisory lock is shared
 * with upload and generation admission so concurrent writers cannot each
 * observe capacity that only one of them may consume.
 */
export async function reserveGenerationOutputStorageTransaction(
	input: {
		assetId: string;
		ownerId: string;
		transferToken: string;
		bytes: bigint;
		maximumStorageBytes: bigint;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ outcome: "RESERVED" | "STALE"; bytes: bigint }> {
	if (input.bytes <= 0n) throw new Error("Generation output storage bytes must be positive");
	if (input.maximumStorageBytes <= 0n) {
		throw new Error("Generation output storage quota must be positive");
	}
	return runSerializable(client, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const asset = await tx.mediaAsset.findFirst({
			where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId },
		});
		if (!asset) throw new Error("Generation output asset not found for owner");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (
			asset.status !== "VERIFYING" ||
			asset.outputTransferToken !== input.transferToken ||
			!asset.outputTransferLeaseExpiresAt ||
			asset.outputTransferLeaseExpiresAt <= now ||
			!asset.outputStagingObjectKey
		) {
			return { outcome: "STALE", bytes: 0n };
		}

		const referenceKey = generationOutputStorageReferenceKey(asset.id);
		const existing = await tx.storageUsageReservation.findUnique({ where: { referenceKey } });
		if (
			existing &&
			(existing.ownerType !== asset.ownerType || existing.ownerId !== asset.ownerId)
		) {
			throw new Error("GENERATION_OUTPUT_STORAGE_RESERVATION_OWNER_CONFLICT");
		}
		if (existing?.status === "COMMITTED") {
			throw new Error("GENERATION_OUTPUT_STORAGE_RESERVATION_ALREADY_COMMITTED");
		}
		const bytes =
			existing?.status === "ACTIVE" && existing.bytes > input.bytes ? existing.bytes : input.bytes;
		const usage = await tx.storageUsageReservation.aggregate({
			where: {
				ownerType: asset.ownerType,
				ownerId: asset.ownerId,
				status: { in: ["ACTIVE", "COMMITTED"] },
				referenceKey: { not: referenceKey },
			},
			_sum: { bytes: true },
		});
		if ((usage._sum.bytes ?? 0n) + bytes > input.maximumStorageBytes) {
			throw new GenerationOutputStorageError();
		}

		await tx.storageUsageReservation.upsert({
			where: { referenceKey },
			create: {
				ownerType: asset.ownerType,
				ownerId: asset.ownerId,
				bytes,
				status: "ACTIVE",
				referenceKey,
				expiresAt: asset.outputTransferLeaseExpiresAt,
			},
			update: {
				bytes,
				status: "ACTIVE",
				expiresAt: asset.outputTransferLeaseExpiresAt,
				releasedAt: null,
			},
		});
		return { outcome: "RESERVED", bytes };
	});
}

export async function completeGenerationOutputTransferTransaction(
	input: {
		assetId: string;
		ownerId: string;
		transferToken: string;
		bytes: bigint;
		checksum: string;
		storageEtag: string | null;
		storageVersionId: string | null;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ outcome: "COMPLETED" | "STALE"; asset: GenerationOutputTransferAsset }> {
	if (input.bytes <= 0n || !/^[a-f0-9]{64}$/i.test(input.checksum)) {
		throw new Error("Generation output transfer identity is invalid");
	}
	return runSerializable(client, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const asset = await tx.mediaAsset.findFirst({
			where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId },
		});
		if (!asset) throw new Error("Generation output asset not found for owner");
		const now = input.now ?? (await getDatabaseNow(tx));
		if (
			asset.status !== "VERIFYING" ||
			asset.outputTransferToken !== input.transferToken ||
			!asset.outputTransferLeaseExpiresAt ||
			asset.outputTransferLeaseExpiresAt <= now ||
			!asset.outputStagingObjectKey
		) {
			return { outcome: "STALE", asset: outputTransferAsset(asset) };
		}
		const stagingObjectKey = asset.outputStagingObjectKey;
		const referenceKey = generationOutputStorageReferenceKey(asset.id);
		const reservation = await tx.storageUsageReservation.findUnique({
			where: { referenceKey },
		});
		if (
			!reservation ||
			reservation.ownerType !== asset.ownerType ||
			reservation.ownerId !== asset.ownerId ||
			reservation.status !== "ACTIVE" ||
			reservation.bytes < input.bytes
		) {
			throw new Error("GENERATION_OUTPUT_STORAGE_RESERVATION_INSUFFICIENT");
		}
		const completed = await tx.mediaAsset.updateMany({
			where: {
				id: asset.id,
				status: "VERIFYING",
				outputTransferToken: input.transferToken,
				outputTransferLeaseExpiresAt: { gt: now },
			},
			data: {
				byteSize: input.bytes,
				checksum: input.checksum,
				storageEtag: input.storageEtag,
				storageVersionId: input.storageVersionId,
				finalizedAt: now,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
				outputStagingObjectKey: null,
				outputPromotionMultipartUploadId: null,
			},
		});
		if (completed.count !== 1) {
			return { outcome: "STALE", asset: outputTransferAsset(asset) };
		}
		const committed = await tx.storageUsageReservation.updateMany({
			where: {
				referenceKey,
				ownerType: asset.ownerType,
				ownerId: asset.ownerId,
				status: "ACTIVE",
				bytes: { gte: input.bytes },
			},
			data: {
				bytes: input.bytes,
				status: "COMMITTED",
				expiresAt: now,
				releasedAt: null,
			},
		});
		if (committed.count !== 1) {
			throw new Error("GENERATION_OUTPUT_STORAGE_RESERVATION_CHANGED_CONCURRENTLY");
		}
		await tx.generationJobAsset.updateMany({
			where: { assetId: asset.id, role: "OUTPUT" },
			data: { assetChecksum: input.checksum },
		});
		await queueGenerationOutputStagingDeletion(asset.id, stagingObjectKey, input.transferToken, tx);
		return {
			outcome: "COMPLETED",
			asset: {
				...outputTransferAsset(asset),
				byteSize: input.bytes,
				checksum: input.checksum,
				storageEtag: input.storageEtag,
				storageVersionId: input.storageVersionId,
				finalizedAt: now,
			},
		};
	});
}

/**
 * Fails one claimed provider-output transfer without allowing an expired actor
 * to terminalize a newer owner. Cleanup is queued from the same fenced state
 * transition. Only the active token may schedule final/staging deletion and an
 * exact multipart abort; cleanup releases storage accounting after physical
 * deletion succeeds.
 */
export async function failGenerationOutputTransferTransaction(
	input: {
		assetId: string;
		ownerId: string;
		transferToken: string;
		errorCode: string;
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ outcome: "FAILED" | "STALE"; asset: GenerationOutputTransferAsset }> {
	if (!input.errorCode.trim()) throw new Error("Generation output transfer error code is required");
	return runSerializable(client, async (tx) => {
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const asset = await tx.mediaAsset.findFirst({
			where: { id: input.assetId, ownerType: "USER", ownerId: input.ownerId },
		});
		if (!asset) throw new Error("Generation output asset not found for owner");
		const failedAt = input.now ?? (await getDatabaseNow(tx));
		if (
			asset.status !== "VERIFYING" ||
			asset.outputTransferToken !== input.transferToken ||
			!asset.outputTransferLeaseExpiresAt ||
			asset.outputTransferLeaseExpiresAt <= failedAt ||
			!asset.outputStagingObjectKey
		) {
			return { outcome: "STALE", asset: outputTransferAsset(asset) };
		}
		const stagingObjectKey = asset.outputStagingObjectKey;
		const promotionMultipartUploadId = asset.outputPromotionMultipartUploadId;
		const failed = await tx.mediaAsset.updateMany({
			where: {
				id: asset.id,
				status: "VERIFYING",
				outputTransferToken: input.transferToken,
				outputTransferLeaseExpiresAt: { gt: failedAt },
			},
			data: {
				status: "VERIFICATION_FAILED",
				verificationLastErrorCode: input.errorCode,
				verificationExhaustedAt: failedAt,
				verificationNextAttemptAt: null,
				outputTransferToken: null,
				outputTransferLeaseExpiresAt: null,
				outputStagingObjectKey: null,
				outputPromotionMultipartUploadId: null,
			},
		});
		if (failed.count !== 1) {
			return { outcome: "STALE", asset: outputTransferAsset(asset) };
		}
		await queueGenerationOutputTerminalCleanup(
			asset.id,
			asset.objectKey,
			stagingObjectKey,
			input.transferToken,
			tx,
		);
		if (promotionMultipartUploadId) {
			await queueGenerationOutputPromotionAbort(
				asset.id,
				asset.objectKey,
				promotionMultipartUploadId,
				input.transferToken,
				tx,
			);
		}
		return {
			outcome: "FAILED",
			asset: outputTransferAsset({
				...asset,
				status: "VERIFICATION_FAILED",
			}),
		};
	});
}

function assertGenerationOutputTransferAssetMatches(
	asset: {
		ownerType: string;
		ownerId: string;
		kind: string;
		objectKey: string;
		mimeType: string;
		sourceUrl: string | null;
	},
	input: ClaimGenerationOutputTransferInput,
): void {
	const matches =
		asset.ownerType === "USER" &&
		asset.ownerId === input.ownerId &&
		asset.kind === "OUTPUT" &&
		asset.objectKey === input.objectKey &&
		asset.mimeType === input.mimeType &&
		asset.sourceUrl === input.sourceUrl;
	if (!matches) throw new Error("GENERATION_OUTPUT_ASSET_CONFLICT");
}

function createGenerationOutputStagingObjectKey(
	input: ClaimGenerationOutputTransferInput,
	transferToken: string,
): string {
	const stagingObjectKey = input.createStagingObjectKey(transferToken);
	if (!stagingObjectKey || stagingObjectKey === input.objectKey) {
		throw new Error("Generation output staging key must differ from final asset key");
	}
	return stagingObjectKey;
}

function outputTransferAsset(asset: {
	id: string;
	status: string;
	objectKey: string;
	mimeType: string;
	byteSize: bigint;
	checksum: string | null;
	storageEtag: string | null;
	storageVersionId: string | null;
	finalizedAt: Date | null;
}): GenerationOutputTransferAsset {
	return {
		id: asset.id,
		status: asset.status,
		objectKey: asset.objectKey,
		mimeType: asset.mimeType,
		byteSize: asset.byteSize,
		checksum: asset.checksum,
		storageEtag: asset.storageEtag,
		storageVersionId: asset.storageVersionId,
		finalizedAt: asset.finalizedAt,
	};
}

async function bindGenerationOutputAsset(
	jobId: string,
	assetId: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const asset = await tx.mediaAsset.findUniqueOrThrow({
		where: { id: assetId },
		select: { checksum: true },
	});
	const assetChecksum =
		asset.checksum && /^[a-f0-9]{64}$/i.test(asset.checksum)
			? asset.checksum
			: `pending-output:${assetId}`;
	await tx.generationJobAsset.upsert({
		where: { jobId_assetId_role: { jobId, assetId, role: "OUTPUT" } },
		create: { jobId, assetId, assetChecksum, role: "OUTPUT", position: 0 },
		update: { assetChecksum },
	});
}

async function queueGenerationOutputStagingDeletion(
	assetId: string,
	stagingObjectKey: string,
	transferToken: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-output-staging-delete:${assetId}:${transferToken}` },
		create: {
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateType: "MEDIA_ASSET",
			aggregateId: assetId,
			dedupeKey: `generation-output-staging-delete:${assetId}:${transferToken}`,
			payload: { assetId, objectKey: stagingObjectKey },
		},
		update: {},
	});
}

async function queueGenerationOutputPromotionAbort(
	assetId: string,
	objectKey: string,
	multipartUploadId: string,
	transferToken: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-output-promotion-abort:${assetId}:${transferToken}` },
		create: {
			eventType: "MEDIA_UPLOAD_CLEANUP",
			aggregateType: "MEDIA_ASSET",
			aggregateId: assetId,
			dedupeKey: `generation-output-promotion-abort:${assetId}:${transferToken}`,
			payload: { assetId, objectKey, multipartUploadId, promotionAbortOnly: true },
		},
		update: {},
	});
}

async function queueGenerationOutputTerminalCleanup(
	assetId: string,
	objectKey: string,
	stagingObjectKey: string | null,
	transferToken: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-output-terminal-delete:${assetId}:${transferToken}` },
		create: {
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateType: "MEDIA_ASSET",
			aggregateId: assetId,
			dedupeKey: `generation-output-terminal-delete:${assetId}:${transferToken}`,
			payload: {
				assetId,
				objectKey,
				...(stagingObjectKey ? { cleanupObjectKeys: [stagingObjectKey] } : {}),
				storageReservationReferenceKey: generationOutputStorageReferenceKey(assetId),
			},
		},
		update: {},
	});
}

function generationOutputStorageReferenceKey(assetId: string): string {
	return `generation-output:${assetId}`;
}

export async function markMediaAssetDeletedTransaction(
	input: { assetId: string; ownerId: string; now?: Date },
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		await lockMediaAssetGenerationBindings([input.assetId], tx);
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
		const liveBinding = await tx.generationJobAsset.findFirst({
			where: {
				assetId: existing.id,
				job: { status: { in: [...LIVE_GENERATION_JOB_STATUSES] } },
			},
			select: { jobId: true },
		});
		if (liveBinding) throw new Error("MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB");
		const now = input.now ?? new Date();
		const asset = await tx.mediaAsset.update({
			where: { id: existing.id },
			data: { status: "DELETED", deletedAt: now },
		});
		const uploadSession = await tx.mediaUploadSession.findFirst({
			where: { assetId: existing.id },
			select: { id: true },
		});
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
					...(uploadSession
						? { uploadSessionId: uploadSession.id, reservationStatus: "RELEASED" }
						: existing.kind === "OUTPUT"
							? { storageReservationReferenceKey: `generation-output:${existing.id}` }
							: {}),
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
