import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "../../generated/client";
import { diagnosticObject } from "./admin-content-diagnostics";
import {
	lockMediaAssetGenerationBindings,
	LIVE_GENERATION_JOB_STATUSES,
} from "./asset-binding-locks";
import { isSourceTemplateMaterialObjectKey } from "./source-template-material-retention";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import type { MediaDatabaseClient, MediaTransactionClient } from "./types";

const PLAN_VERSION = 1;
const PLAN_TTL_MS = 10 * 60_000;
const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_ASSETS = 20;
const MAX_LOGS = 100;
type Asset = Prisma.MediaAssetGetPayload<{ include: { uploadSessions: true } }>;
type Identity = ReturnType<typeof assetIdentity>;
type PlannedAsset = { id: string; bytes: string; identity: Identity | null; blocked: string[] };
type PlannedLog = { id: string; fingerprint: string; bytes: number };
type Plan = {
	version: 1;
	actorUserId: string;
	reason: string;
	expiresAt: string;
	cutoff: string;
	assets: PlannedAsset[];
	logs: PlannedLog[];
};

function hash(value: unknown) {
	function stable(item: unknown): unknown {
		if (item instanceof Date) return item.toISOString();
		if (Array.isArray(item)) return item.map(stable);
		if (item && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, entry]) => [key, stable(entry)]),
			);
		return item;
	}
	return createHash("sha256")
		.update(JSON.stringify(stable(value)))
		.digest("hex");
}
function assetIdentity(asset: Asset) {
	return {
		id: asset.id,
		ownerType: asset.ownerType,
		ownerId: asset.ownerId,
		kind: asset.kind,
		objectKey: asset.objectKey,
		checksum: asset.checksum,
		storageEtag: asset.storageEtag,
		storageVersionId: asset.storageVersionId,
		byteSize: asset.byteSize.toString(),
		updatedAt: asset.updatedAt.toISOString(),
		verificationGeneration: asset.verificationGeneration,
	};
}
async function clock(tx: MediaDatabaseClient) {
	const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!row) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return row.now;
}
function reservationKeys(asset: Asset) {
	return [
		`generation-output:${asset.id}`,
		`media-draft:${asset.id}`,
		`temporary-reference:${asset.id}`,
		...asset.uploadSessions.map((session) => `media-upload:${session.id}`),
	];
}

async function blockedReasons(asset: Asset, tx: MediaDatabaseClient, now: Date): Promise<string[]> {
	const reasons: string[] = [];
	if (asset.verificationEngine !== "legacy" || !asset.mimeType.startsWith("image/"))
		reasons.push("UNSUPPORTED_ASSET");
	if (asset.deletedAt || asset.status === "DELETED") reasons.push("ALREADY_DELETED");
	if (
		!asset.finalizedAt ||
		!asset.checksum ||
		!["READY", "QUARANTINED", "VERIFICATION_FAILED"].includes(asset.status)
	)
		reasons.push("ASSET_NOT_TERMINAL");
	if (isSourceTemplateMaterialObjectKey(asset.objectKey))
		reasons.push("PROTECTED_TEMPLATE_MATERIAL");
	if (asset.verificationSubmissionUncertain) reasons.push("UNCERTAIN_REVIEW");
	if (
		asset.verificationLeaseToken ||
		asset.verificationLeasedUntil ||
		asset.verificationNextAttemptAt
	)
		reasons.push("ACTIVE_REVIEW");
	if (
		asset.outputTransferToken ||
		asset.outputTransferLeaseExpiresAt ||
		asset.outputPromotionMultipartUploadId ||
		asset.outputStagingObjectKey
	)
		reasons.push("ACTIVE_TRANSFER");
	if (
		asset.uploadSessions.some(
			(session) =>
				session.status === "PENDING" ||
				session.status === "FINALIZING" ||
				session.finalizationToken ||
				session.promotionToken,
		)
	)
		reasons.push("ACTIVE_UPLOAD");
	if (
		asset.retentionClass === "GUEST_TRIAL" &&
		asset.uploadSessions.some(
			(session) =>
				session.status === "COMPLETED" &&
				!session.guestCompletionConsumedAt &&
				session.expiresAt > now,
		)
	)
		reasons.push("UNCONSUMED_GUEST_UPLOAD");
	const [job, review, reservation, draft, copies] = await Promise.all([
		tx.generationJobAsset.findFirst({
			where: {
				assetId: asset.id,
				job: {
					OR: [
						{ status: { in: [...LIVE_GENERATION_JOB_STATUSES] } },
						{ terminalAt: null },
						{ reservation: { status: "ACTIVE" } },
						{ imagePassReservation: { status: "ACTIVE" } },
						{
							attempts: {
								some: {
									OR: [
										{ uncertainSubmission: true },
										{
											status: {
												in: [
													"CREATED",
													"SUBMISSION_UNCERTAIN",
													"SUBMITTED",
													"RUNNING",
													"NEEDS_RECONCILIATION",
												],
											},
										},
										{ reconcileLeaseToken: { not: null } },
									],
								},
							},
						},
					],
				},
			},
			select: { jobId: true },
		}),
		tx.moderationReview.findFirst({
			where: {
				targetType: "ASSET",
				targetId: asset.id,
				status: { notIn: ["APPROVED", "REJECTED"] },
			},
			select: { id: true },
		}),
		tx.storageUsageReservation.findFirst({
			where: { referenceKey: { in: reservationKeys(asset) }, status: "ACTIVE" },
			select: { id: true },
		}),
		tx.generationDraft.findFirst({
			where: { assetId: asset.id, status: { in: ["ACTIVE", "SUBMITTED"] }, expiresAt: { gt: now } },
			select: { id: true },
		}),
		tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "outbox_event"
			WHERE "eventType" = 'ACCOUNT_INPUT_COPY_INTENT'
			AND ("payload"->'source'->>'assetId' = ${asset.id} OR "payload"->'target'->>'assetId' = ${asset.id})
			AND ("payload"->>'phase' IN ('PENDING', 'COPYING', 'VERIFYING') OR "payload"->'uncertainWriter' = 'true'::jsonb)
			LIMIT 1`,
	]);
	if (job) reasons.push("ACTIVE_JOB_OR_RESERVATION");
	if (review) reasons.push("UNRESOLVED_REVIEW");
	if (reservation) reasons.push("ACTIVE_STORAGE_RESERVATION");
	if (draft) reasons.push("ACTIVE_DRAFT");
	if (copies.length) reasons.push("ACTIVE_OR_UNCERTAIN_COPY");
	return reasons;
}

function publicPlan(planId: string, planHash: string, plan: Plan) {
	const deletable = plan.assets.filter((asset) => asset.blocked.length === 0);
	return {
		planId,
		planHash,
		expiresAt: new Date(plan.expiresAt),
		assets: plan.assets.map(({ id, bytes, blocked }) => ({ id, bytes, blocked })),
		assetCount: deletable.length,
		assetBytes: deletable.reduce((sum, asset) => sum + BigInt(asset.bytes), 0n).toString(),
		logCount: plan.logs.length,
		logBytes: plan.logs.reduce((sum, log) => sum + log.bytes, 0),
		confirmation: `DELETE ${deletable.length} ASSETS AND ${plan.logs.length} INTERNAL LOGS`,
	};
}

/** Recover exact confirmed plans after navigation without persisting private identifiers in browser storage. */
export async function listRecentAdminContentCleanupPlans(
	actorUserId: string,
	client: MediaTransactionClient,
) {
	const receipts = await client.auditLog.findMany({
		where: {
			actorUserId,
			action: "MEDIA_ADMIN_CLEANUP_EXECUTED",
			targetType: "ADMIN_MEDIA_CLEANUP_PLAN",
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: 5,
		select: { targetId: true },
	});
	const plans = await client.auditLog.findMany({
		where: {
			id: { in: receipts.map((receipt) => receipt.targetId) },
			actorUserId,
			action: "MEDIA_ADMIN_CLEANUP_PREVIEWED",
		},
		select: { id: true, metadata: true },
	});
	await client.auditLog.create({
		data: {
			actorUserId,
			action: "MEDIA_ADMIN_CLEANUP_PLANS_VIEWED",
			targetType: "ADMIN_MEDIA_CLEANUP_PLAN",
			targetId: actorUserId,
			metadata: { resultCount: plans.length },
		},
	});
	return receipts.flatMap((receipt) => {
		const audit = plans.find((plan) => plan.id === receipt.targetId);
		const metadata = diagnosticObject(audit?.metadata);
		const plan = metadata.plan as Plan | undefined;
		return audit &&
			plan?.version === PLAN_VERSION &&
			plan.actorUserId === actorUserId &&
			typeof metadata.planHash === "string" &&
			hash(plan) === metadata.planHash
			? [publicPlan(audit.id, metadata.planHash, plan)]
			: [];
	});
}

/** Read-only selection plus immutable audit; never dispatches or deletes objects. */
export async function previewAdminContentCleanup(
	input: {
		assetIds: string[];
		includeExpiredInternalDiagnostics: boolean;
		diagnosticEventIds?: string[];
		reason: string;
	},
	actorUserId: string,
	client: MediaTransactionClient,
) {
	const assetIds = [...new Set(input.assetIds)].sort();
	if (
		assetIds.length > MAX_ASSETS ||
		(input.diagnosticEventIds?.length ?? 0) > MAX_LOGS ||
		input.reason.trim().length < 5 ||
		input.reason.length > 500
	)
		throw new Error("ADMIN_CLEANUP_INVALID_REQUEST");
	return client.$transaction(
		async (tx) => {
			const now = await clock(tx);
			const cutoff = new Date(now.getTime() - DIAGNOSTIC_RETENTION_MS);
			const assets: PlannedAsset[] = [];
			for (const id of assetIds) {
				const asset = await tx.mediaAsset.findUnique({
					where: { id },
					include: { uploadSessions: true },
				});
				assets.push(
					asset
						? {
								id,
								bytes: asset.byteSize.toString(),
								identity: assetIdentity(asset),
								blocked: await blockedReasons(asset, tx, now),
							}
						: { id, bytes: "0", identity: null, blocked: ["NOT_FOUND"] },
				);
			}
			// These browser test observations have no billing, moderation, admission or recovery role.
			// All Outbox rows (even PROCESSED copy journals), audit rows and real visitor events remain.
			const logs = input.includeExpiredInternalDiagnostics
				? await tx.growthEvent.findMany({
						where: {
							internal: true,
							createdAt: { lt: cutoff },
							...(input.diagnosticEventIds ? { id: { in: input.diagnosticEventIds } } : {}),
						},
						orderBy: [{ createdAt: "asc" }, { id: "asc" }],
						take: MAX_LOGS,
					})
				: [];
			const plan: Plan = {
				version: PLAN_VERSION,
				actorUserId,
				reason: input.reason.trim(),
				expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
				cutoff: cutoff.toISOString(),
				assets,
				logs: logs.map((log) => ({
					id: log.id,
					fingerprint: hash(log),
					bytes: Buffer.byteLength(JSON.stringify(log), "utf8"),
				})),
			};
			const planId = `admin-cleanup:${randomUUID()}`;
			const planHash = hash(plan);
			await tx.auditLog.create({
				data: {
					id: planId,
					actorUserId,
					action: "MEDIA_ADMIN_CLEANUP_PREVIEWED",
					targetType: "ADMIN_MEDIA_CLEANUP_PLAN",
					targetId: planId,
					metadata: { plan: plan as unknown as Prisma.InputJsonValue, planHash },
				},
			});
			return publicPlan(planId, planHash, plan);
		},
		{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 20_000 },
	);
}

/** Atomically revoke usage and enqueue exact physical deletion; preserve asset/evidence rows. */
export async function executeAdminContentCleanup(
	input: { planId: string; planHash: string; confirmation: string },
	actorUserId: string,
	client: MediaTransactionClient,
) {
	return client.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.planId}, 0))`;
			const audit = await tx.auditLog.findUnique({ where: { id: input.planId } });
			const metadata = diagnosticObject(audit?.metadata);
			const plan = metadata.plan as Plan | undefined;
			if (
				!audit ||
				audit.action !== "MEDIA_ADMIN_CLEANUP_PREVIEWED" ||
				audit.actorUserId !== actorUserId ||
				!plan ||
				plan.version !== PLAN_VERSION ||
				plan.actorUserId !== actorUserId ||
				metadata.planHash !== input.planHash ||
				hash(plan) !== input.planHash
			)
				throw new Error("ADMIN_CLEANUP_PLAN_INVALID");
			const summary = publicPlan(input.planId, input.planHash, plan);
			if (input.confirmation !== summary.confirmation)
				throw new Error("ADMIN_CLEANUP_CONFIRMATION_REQUIRED");
			const receiptId = `${input.planId}:executed`;
			const replay = await tx.auditLog.findUnique({ where: { id: receiptId } });
			if (replay) {
				// Retry only the already authorized, durable object identity. Never create a new intent.
				let requeuedAssets = 0;
				for (const item of plan.assets.filter((asset) => !asset.blocked.length)) {
					await lockMediaAssetGenerationBindings([item.id], tx);
					await tx.$executeRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${item.id} FOR UPDATE`;
					const asset = await tx.mediaAsset.findUnique({
						where: { id: item.id },
						include: { uploadSessions: true },
					});
					if (!asset || !(await hasExactAdminDeletionAuthorization(asset, tx)))
						throw new Error("ADMIN_CLEANUP_PLAN_STALE");
					const event = await tx.outboxEvent.findUnique({
						where: { dedupeKey: `admin-media-object-delete:${input.planId}:${item.id}` },
					});
					if (event?.status === "DEAD_LETTER") {
						const payload = diagnosticObject(event.payload);
						if (payload.assetId !== asset.id || payload.objectKey !== asset.objectKey)
							throw new Error("ADMIN_CLEANUP_PLAN_STALE");
						const changed = await tx.outboxEvent.updateMany({
							where: { id: event.id, status: "DEAD_LETTER", attempts: event.attempts },
							data: {
								status: "PENDING",
								attempts: 0,
								leaseOwner: null,
								leaseToken: null,
								leasedUntil: null,
								lastError: null,
								availableAt: await clock(tx),
							},
						});
						requeuedAssets += changed.count;
						if (changed.count)
							await tx.auditLog.create({
								data: {
									actorUserId,
									action: "MEDIA_ADMIN_CLEANUP_RETRIED",
									targetType: "ADMIN_MEDIA_CLEANUP_PLAN",
									targetId: input.planId,
									metadata: {
										eventId: event.id,
										previousAttempts: event.attempts,
										planHash: input.planHash,
									},
								},
							});
					}
				}
				return {
					planId: input.planId,
					queuedAssets: summary.assetCount,
					deletedLogs: summary.logCount,
					replayed: true,
					requeuedAssets,
				};
			}
			if (new Date(plan.expiresAt) <= (await clock(tx)))
				throw new Error("ADMIN_CLEANUP_PLAN_EXPIRED");
			const selected = plan.assets.filter((asset) => !asset.blocked.length);
			if (!selected.length && !plan.logs.length) throw new Error("ADMIN_CLEANUP_EMPTY_PLAN");
			// Owner -> binding -> verification -> rows is compatible with copy/admission writers.
			const owners = [
				...new Map(
					selected.map((asset) => [
						`${asset.identity!.ownerType}:${asset.identity!.ownerId}`,
						asset.identity!,
					]),
				).values(),
			].sort((a, b) => `${a.ownerType}:${a.ownerId}`.localeCompare(`${b.ownerType}:${b.ownerId}`));
			for (const owner of owners) await lockOwnerStorageUsage(owner, tx);
			await lockMediaAssetGenerationBindings(
				selected.map((asset) => asset.id),
				tx,
			);
			for (const asset of selected)
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${asset.id}`}, 0))`;
			for (const asset of selected)
				await tx.$executeRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${asset.id} FOR UPDATE`;
			const now = await clock(tx);
			if (new Date(plan.expiresAt) <= now) throw new Error("ADMIN_CLEANUP_PLAN_EXPIRED");
			for (const item of selected) {
				const asset = await tx.mediaAsset.findUnique({
					where: { id: item.id },
					include: { uploadSessions: true },
				});
				if (
					!asset ||
					hash(assetIdentity(asset)) !== hash(item.identity) ||
					(await blockedReasons(asset, tx, now)).length
				)
					throw new Error("ADMIN_CLEANUP_PLAN_STALE");
				const authorization = {
					version: PLAN_VERSION,
					planId: input.planId,
					planHash: input.planHash,
					...assetIdentity(asset),
					deletedAt: now.toISOString(),
				};
				await tx.auditLog.create({
					data: {
						actorUserId,
						action: "MEDIA_ADMIN_ASSET_DELETE_AUTHORIZED",
						targetType: "MEDIA_ASSET",
						targetId: asset.id,
						before: { status: asset.status },
						after: { status: "DELETED", physicalDeletion: "QUEUED" },
						metadata: { authorization, reason: plan.reason },
					},
				});
				await tx.mediaAsset.update({
					where: { id: asset.id },
					data: { status: "DELETED", deletedAt: now },
				});
				const uploadSession = asset.uploadSessions[0];
				await tx.outboxEvent.create({
					data: {
						eventType: "MEDIA_OBJECT_DELETE",
						aggregateType: "MEDIA_ASSET",
						aggregateId: asset.id,
						dedupeKey: `admin-media-object-delete:${input.planId}:${asset.id}`,
						payload: {
							assetId: asset.id,
							objectKey: asset.objectKey,
							...(uploadSession
								? { uploadSessionId: uploadSession.id, reservationStatus: "RELEASED" }
								: {
										storageReservationReferenceKey:
											asset.kind === "OUTPUT"
												? `generation-output:${asset.id}`
												: asset.objectKey.startsWith("users/temporary-references/v1/")
													? `temporary-reference:${asset.id}`
													: `media-draft:${asset.id}`,
									}),
						},
					},
				});
			}
			for (const plannedLog of plan.logs) {
				await tx.$executeRaw`SELECT "id" FROM "growth_event" WHERE "id" = ${plannedLog.id} FOR UPDATE`;
				const log = await tx.growthEvent.findUnique({ where: { id: plannedLog.id } });
				if (
					!log ||
					!log.internal ||
					log.createdAt >= new Date(plan.cutoff) ||
					hash(log) !== plannedLog.fingerprint
				)
					throw new Error("ADMIN_CLEANUP_PLAN_STALE");
			}
			if (plan.logs.length) {
				const result = await tx.growthEvent.deleteMany({
					where: {
						id: { in: plan.logs.map((log) => log.id) },
						internal: true,
						createdAt: { lt: new Date(plan.cutoff) },
					},
				});
				if (result.count !== plan.logs.length) throw new Error("ADMIN_CLEANUP_PLAN_STALE");
			}
			const result = {
				planId: input.planId,
				queuedAssets: selected.length,
				deletedLogs: plan.logs.length,
				replayed: false,
				requeuedAssets: 0,
			};
			await tx.auditLog.create({
				data: {
					id: receiptId,
					actorUserId,
					action: "MEDIA_ADMIN_CLEANUP_EXECUTED",
					targetType: "ADMIN_MEDIA_CLEANUP_PLAN",
					targetId: input.planId,
					after: result,
					metadata: { planHash: input.planHash, reason: plan.reason },
				},
			});
			return result;
		},
		{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 20_000 },
	);
}

/** Administrator authority is explicit and bound to this tombstone and immutable object. */
export async function hasExactAdminDeletionAuthorization(asset: Asset, tx: MediaDatabaseClient) {
	if (asset.status !== "DELETED" || !asset.deletedAt) return false;
	const latest = await tx.auditLog.findFirst({
		where: {
			action: "MEDIA_ADMIN_ASSET_DELETE_AUTHORIZED",
			targetType: "MEDIA_ASSET",
			targetId: asset.id,
		},
		orderBy: { createdAt: "desc" },
	});
	for (const audit of latest ? [latest] : []) {
		const authorization = diagnosticObject(diagnosticObject(audit.metadata).authorization);
		if (
			!audit.actorUserId ||
			authorization.version !== PLAN_VERSION ||
			authorization.id !== asset.id ||
			authorization.ownerType !== asset.ownerType ||
			authorization.ownerId !== asset.ownerId ||
			authorization.objectKey !== asset.objectKey ||
			authorization.checksum !== asset.checksum ||
			authorization.storageEtag !== asset.storageEtag ||
			authorization.storageVersionId !== asset.storageVersionId ||
			authorization.byteSize !== asset.byteSize.toString() ||
			authorization.kind !== asset.kind ||
			authorization.verificationGeneration !== asset.verificationGeneration ||
			authorization.deletedAt !== asset.deletedAt.toISOString() ||
			typeof authorization.planId !== "string"
		)
			continue;
		const executed = await tx.auditLog.findUnique({
			where: { id: `${authorization.planId}:executed` },
		});
		if (
			executed?.action === "MEDIA_ADMIN_CLEANUP_EXECUTED" &&
			executed.actorUserId === audit.actorUserId &&
			diagnosticObject(executed.metadata).planHash === authorization.planHash
		)
			return true;
	}
	return false;
}
