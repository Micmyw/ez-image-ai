import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { fenceGenerationOutputBindingJob, reserveGenerationOutputStorage } from "./assets";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runReadCommitted, runSerializable } from "./types";

/** The authenticated provider envelope, asset binding and both durable intents commit together. */
export async function createProviderOriginal(
	input: {
		jobId: string;
		ownerId: string;
		assetId: string;
		objectKey: string;
		mimeType: string;
		candidateKey: string;
		url: string;
		guest?: { deleteAfter: Date };
	},
	database: PrismaClient,
) {
	const position = Number(input.candidateKey.split(":").at(-1));
	if (!Number.isSafeInteger(position) || position < 0 || position > 3)
		throw new Error("GENERATION_OUTPUT_POSITION_INVALID");
	return runSerializable(database, async (tx) => {
		if (!(await fenceGenerationOutputBindingJob(input, tx)))
			throw new Error("GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT");
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (input.guest && input.guest.deleteAfter <= clock!.now)
			throw new Error("GUEST_RETENTION_EXPIRED");
		const existing = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
		if (
			existing &&
			(existing.ownerType !== "USER" ||
				existing.ownerId !== input.ownerId ||
				existing.kind !== "OUTPUT" ||
				existing.verificationEngine !== "legacy" ||
				existing.mimeType !== input.mimeType ||
				existing.objectKey !== input.objectKey ||
				existing.sourceUrl !== `provider-output:${input.candidateKey}` ||
				existing.deletedAt ||
				existing.status === "DELETED")
		)
			throw new Error("GENERATION_OUTPUT_ASSET_CONFLICT");
		const asset =
			existing ??
			(await tx.mediaAsset.create({
				data: {
					id: input.assetId,
					ownerType: "USER",
					ownerId: input.ownerId,
					kind: "OUTPUT",
					status: "VERIFYING",
					objectKey: input.objectKey,
					mimeType: input.mimeType,
					byteSize: 0n,
					sourceUrl: `provider-output:${input.candidateKey}`,
					...(input.guest
						? { retentionClass: "GUEST_TRIAL", deleteAfter: input.guest.deleteAfter }
						: {}),
				},
			}));
		const origin = await tx.mediaOutputOrigin.upsert({
			where: { assetId: asset.id },
			create: { assetId: asset.id, url: input.url },
			update: {},
		});
		if (origin.url !== input.url) throw new Error("GENERATION_OUTPUT_ORIGIN_CONFLICT");
		await tx.generationJobAsset.upsert({
			where: { jobId_assetId_role: { jobId: input.jobId, assetId: asset.id, role: "OUTPUT" } },
			create: {
				jobId: input.jobId,
				assetId: asset.id,
				assetChecksum: asset.checksum ?? "",
				role: "OUTPUT",
				position,
			},
			update: {},
		});
		const review = await tx.outboxEvent.upsert({
			where: { dedupeKey: `provider-original-review:${asset.id}` },
			create: {
				dedupeKey: `provider-original-review:${asset.id}`,
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				payload: { assetId: asset.id },
			},
			update: {},
		});
		const archive = await tx.outboxEvent.upsert({
			where: { dedupeKey: `provider-original-archive:${asset.id}:0` },
			create: {
				dedupeKey: `provider-original-archive:${asset.id}:0`,
				eventType: "MEDIA_OUTPUT_ARCHIVE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: asset.id,
				payload: { assetId: asset.id },
			},
			update: {},
		});
		return { asset, reviewEventId: review.id, archiveEventId: archive.id };
	});
}

/** The review identity is independent of the archive and cannot change after submission. */
export async function commitProviderOriginalIdentity(
	input: {
		assetId: string;
		leaseToken: string;
		generation: number;
		checksum: string;
		bytes: number;
		guest: boolean;
	},
	database: PrismaClient,
) {
	if (
		!/^[a-f0-9]{64}$/.test(input.checksum) ||
		!Number.isSafeInteger(input.bytes) ||
		input.bytes < 1 ||
		input.bytes > 25 * 1024 * 1024
	)
		throw new Error("ORIGINAL_IDENTITY_INVALID");
	return runReadCommitted(database, async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`;
		await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${input.assetId} FOR UPDATE`;
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		const changed = await tx.mediaAsset.updateMany({
			where: {
				id: input.assetId,
				kind: "OUTPUT",
				status: "VERIFYING",
				deletedAt: null,
				verificationEngine: "legacy",
				verificationLeaseToken: input.leaseToken,
				verificationGeneration: input.generation,
				verificationLeasedUntil: { gt: clock!.now },
				AND: [
					{ OR: [{ checksum: null }, { checksum: input.checksum }] },
					{ OR: [{ deleteAfter: null }, { deleteAfter: { gt: clock!.now } }] },
				],
			},
			data: {
				checksum: input.checksum,
				byteSize: BigInt(input.bytes),
				finalizedAt: clock!.now,
				...(input.guest
					? { watermarkVersion: "ezpic-guest-origin-v1", watermarkedAt: clock!.now }
					: {}),
			},
		});
		if (changed.count !== 1) return false;
		await tx.generationJobAsset.updateMany({
			where: { assetId: input.assetId, role: "OUTPUT" },
			data: { assetChecksum: input.checksum },
		});
		// Archival may win the race. Keep a mismatching copy private and diagnosable.
		await tx.mediaOutputOrigin.updateMany({
			where: {
				assetId: input.assetId,
				archiveState: "ARCHIVED",
				OR: [
					{ archiveChecksum: { not: input.checksum } },
					{ archiveBytes: { not: BigInt(input.bytes) } },
				],
			},
			data: { archiveState: "FAILED", lastErrorCode: "ORIGINAL_ARCHIVE_IDENTITY_CHANGED" },
		});
		return true;
	});
}

export async function claimProviderOriginalArchive(assetId: string, database: PrismaClient) {
	return runReadCommitted(database, async (tx) => {
		await lockMediaAssetGenerationBindings([assetId], tx);
		await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${assetId} FOR UPDATE`;
		await tx.$queryRaw`SELECT "assetId" FROM "media_output_origin" WHERE "assetId" = ${assetId} FOR UPDATE`;
		const asset = await tx.mediaAsset.findUnique({ where: { id: assetId } });
		const origin = await tx.mediaOutputOrigin.findUnique({ where: { assetId } });
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (
			!asset ||
			!origin ||
			asset.verificationEngine !== "legacy" ||
			asset.deletedAt ||
			asset.status === "DELETED" ||
			(asset.deleteAfter && asset.deleteAfter <= clock!.now) ||
			origin.archiveState === "ARCHIVED" ||
			origin.archiveState === "FAILED"
		)
			return null;
		if (origin.leasedUntil && origin.leasedUntil > clock!.now)
			throw new Error("ORIGINAL_ARCHIVE_LEASE_HELD");
		const token = randomUUID();
		const leasedUntil = new Date(clock!.now.getTime() + 15 * 60_000);
		await tx.mediaOutputOrigin.update({
			where: { assetId },
			data: { leaseToken: token, leasedUntil, attempts: { increment: 1 } },
		});
		return { asset, origin, token, leasedUntil };
	});
}

export async function reserveProviderOriginalArchive(
	input: {
		assetId: string;
		ownerId: string;
		token: string;
		bytes: number;
		maximumStorageBytes: bigint;
	},
	database: PrismaClient,
) {
	return runReadCommitted(database, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${input.assetId} FOR UPDATE`;
		const asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
		const origin = await tx.mediaOutputOrigin.findUnique({ where: { assetId: input.assetId } });
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (
			!asset ||
			asset.ownerId !== input.ownerId ||
			asset.deletedAt ||
			asset.status === "DELETED" ||
			(asset.deleteAfter && asset.deleteAfter <= clock!.now) ||
			origin?.leaseToken !== input.token ||
			!origin.leasedUntil ||
			origin.leasedUntil <= clock!.now
		)
			throw new Error("ORIGINAL_ARCHIVE_FENCE_LOST");
		return reserveGenerationOutputStorage(
			{ bytes: BigInt(input.bytes), maximumStorageBytes: input.maximumStorageBytes },
			{ ...asset, outputTransferLeaseExpiresAt: origin.leasedUntil },
			tx,
		);
	});
}

export async function completeProviderOriginalArchive(
	input: {
		assetId: string;
		ownerId: string;
		token: string;
		bytes: number;
		checksum: string;
		etag: string | null;
		versionId: string | null;
	},
	database: PrismaClient,
) {
	return runReadCommitted(database, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		await lockMediaAssetGenerationBindings([input.assetId], tx);
		await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${input.assetId} FOR UPDATE`;
		const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: input.assetId } });
		const origin = await tx.mediaOutputOrigin.findUniqueOrThrow({
			where: { assetId: input.assetId },
		});
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		const deleted = Boolean(asset.deletedAt || asset.status === "DELETED");
		// A confirmed late PUT still needs metering/cleanup after its lease expired.
		// Tombstones are irreversible; this branch cannot release a live asset.
		if (
			asset.ownerId !== input.ownerId ||
			(!deleted &&
				(origin.leaseToken !== input.token ||
					!origin.leasedUntil ||
					origin.leasedUntil <= clock!.now))
		)
			throw new Error("ORIGINAL_ARCHIVE_FENCE_LOST");
		const referenceKey = `generation-output:${input.assetId}`;
		const reserved = await tx.storageUsageReservation.updateMany({
			where: {
				referenceKey,
				ownerId: input.ownerId,
				status: "ACTIVE",
				bytes: { gte: BigInt(input.bytes) },
			},
			data: { bytes: BigInt(input.bytes), status: "COMMITTED", expiresAt: clock!.now },
		});
		if (reserved.count !== 1) {
			if (!asset.deletedAt && asset.status !== "DELETED")
				throw new Error("ORIGINAL_ARCHIVE_RESERVATION_LOST");
			// A delete may finish before an already-issued PUT. Meter the late physical
			// copy until its new cleanup receipt confirms removal.
			await tx.storageUsageReservation.upsert({
				where: { referenceKey },
				create: {
					referenceKey,
					ownerType: asset.ownerType,
					ownerId: asset.ownerId,
					bytes: BigInt(input.bytes),
					status: "COMMITTED",
					expiresAt: clock!.now,
				},
				update: {
					bytes: BigInt(input.bytes),
					status: "COMMITTED",
					expiresAt: clock!.now,
					releasedAt: null,
				},
			});
		}
		await tx.mediaOutputOrigin.update({
			where: { assetId: input.assetId },
			data: {
				archiveState: asset.checksum && asset.checksum !== input.checksum ? "FAILED" : "ARCHIVED",
				archiveChecksum: input.checksum,
				archiveBytes: BigInt(input.bytes),
				archivedAt: clock!.now,
				leaseToken: null,
				leasedUntil: null,
				lastErrorCode:
					asset.checksum && asset.checksum !== input.checksum
						? "ORIGINAL_ARCHIVE_IDENTITY_CHANGED"
						: null,
			},
		});
		// The detector owns checksum/READY; storage never overwrites its identity or verdict.
		if (asset.deletedAt || asset.status === "DELETED") {
			await tx.outboxEvent.upsert({
				where: { dedupeKey: `provider-original-late-delete:${asset.id}:${input.token}` },
				create: {
					dedupeKey: `provider-original-late-delete:${asset.id}:${input.token}`,
					eventType: "MEDIA_OBJECT_DELETE",
					aggregateType: "MEDIA_ASSET",
					aggregateId: asset.id,
					payload: {
						assetId: asset.id,
						objectKey: asset.objectKey,
						storageReservationReferenceKey: referenceKey,
					},
				},
				update: {},
			});
		}
	});
}

export async function retryProviderOriginalArchive(
	assetId: string,
	token: string,
	database: PrismaClient,
) {
	return runReadCommitted(database, async (tx) => {
		const origin = await tx.mediaOutputOrigin.findUnique({ where: { assetId } });
		if (!origin || origin.leaseToken !== token) return null;
		const exhausted = origin.attempts >= 8;
		const changed = await tx.mediaOutputOrigin.updateMany({
			where: { assetId, leaseToken: token },
			data: {
				leaseToken: null,
				leasedUntil: null,
				archiveState: exhausted ? "FAILED" : "PENDING",
				lastErrorCode: "ORIGINAL_ARCHIVE_RETRYABLE",
			},
		});
		if (changed.count !== 1 || exhausted) return null;
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		const availableAt = new Date(clock!.now.getTime() + Math.min(300, 2 ** origin.attempts) * 1000);
		const key = `provider-original-archive:${assetId}:${origin.attempts}`;
		return tx.outboxEvent.upsert({
			where: { dedupeKey: key },
			create: {
				dedupeKey: key,
				eventType: "MEDIA_OUTPUT_ARCHIVE",
				aggregateType: "MEDIA_ASSET",
				aggregateId: assetId,
				payload: { assetId },
				availableAt,
			},
			update: {},
		});
	});
}

/** Independent of job success: archival survives a worker crash after delivery/settlement. */
export async function recoverProviderOriginalArchives(database: PrismaClient) {
	const rows = await database.$queryRaw<Array<{ assetId: string; leaseToken: string }>>`
    SELECT "assetId", "leaseToken" FROM "media_output_origin"
    WHERE "archiveState" = 'PENDING' AND "leaseToken" IS NOT NULL AND "leasedUntil" <= clock_timestamp()
    ORDER BY "leasedUntil" LIMIT 50`;
	for (const row of rows) await retryProviderOriginalArchive(row.assetId, row.leaseToken, database);
	// A receiver may die after its Outbox begin but before claiming an archive
	// (including header preflight). Only this idempotent, conditional storage task
	// can reopen that guard; no provider submission or moderation is replayed.
	const reopened = await database.$executeRaw`
    WITH stale AS (
      SELECT event."id" FROM "outbox_event" event
      JOIN "media_output_origin" origin ON origin."assetId" = event."aggregateId"
      WHERE event."eventType" = 'MEDIA_OUTPUT_ARCHIVE' AND event."aggregateType" = 'MEDIA_ASSET'
        AND event."status" IN ('PENDING', 'LEASED')
        AND (event."leasedUntil" IS NULL OR event."leasedUntil" <= clock_timestamp())
        AND (origin."leasedUntil" IS NULL OR origin."leasedUntil" <= clock_timestamp())
        AND split_part(event."lastError", ':', 1) IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS')
      ORDER BY event."createdAt" LIMIT 50 FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE "outbox_event" event SET "status" = 'PENDING', "leaseOwner" = NULL,
      "leaseToken" = NULL, "leasedUntil" = NULL, "lastError" = NULL
    FROM stale WHERE event."id" = stale."id"`;
	// Scanned delivery ACKs a successful enqueue. If that Workflow dies before
	// claiming storage, recover its source intent even though the image job is done.
	const stranded = await database.$queryRaw<Array<{ assetId: string; eventId: string }>>`
    SELECT origin."assetId", latest."id" AS "eventId" FROM "media_output_origin" origin
    JOIN LATERAL (
      SELECT event."id", event."createdAt" FROM "outbox_event" event
      WHERE event."aggregateType" = 'MEDIA_ASSET' AND event."aggregateId" = origin."assetId"
        AND event."eventType" = 'MEDIA_OUTPUT_ARCHIVE'
      ORDER BY event."createdAt" DESC, event."id" DESC LIMIT 1
    ) latest ON true
    WHERE origin."archiveState" = 'PENDING' AND origin."leaseToken" IS NULL
      AND latest."createdAt" < clock_timestamp() - interval '15 minutes'
      AND NOT EXISTS (SELECT 1 FROM "outbox_event" live WHERE live."aggregateType" = 'MEDIA_ASSET'
        AND live."aggregateId" = origin."assetId" AND live."eventType" = 'MEDIA_OUTPUT_ARCHIVE'
        AND live."status" IN ('PENDING', 'LEASED'))
    ORDER BY latest."createdAt" LIMIT 50`;
	let recovered = 0;
	for (const row of stranded) {
		recovered += await runReadCommitted(database, async (tx) => {
			await tx.$queryRaw`SELECT "assetId" FROM "media_output_origin" WHERE "assetId" = ${row.assetId} FOR UPDATE`;
			const origin = await tx.mediaOutputOrigin.findUniqueOrThrow({
				where: { assetId: row.assetId },
			});
			if (
				origin.archiveState !== "PENDING" ||
				origin.leaseToken ||
				(await tx.outboxEvent.findFirst({
					where: {
						aggregateType: "MEDIA_ASSET",
						aggregateId: row.assetId,
						eventType: "MEDIA_OUTPUT_ARCHIVE",
						status: { in: ["PENDING", "LEASED"] },
					},
					select: { id: true },
				}))
			)
				return 0;
			const exhausted = origin.attempts >= 8;
			await tx.mediaOutputOrigin.update({
				where: { assetId: row.assetId },
				data: {
					attempts: { increment: 1 },
					archiveState: exhausted ? "FAILED" : "PENDING",
					lastErrorCode: "ORIGINAL_ARCHIVE_EXECUTION_LOST",
				},
			});
			if (exhausted) return 0;
			const dedupeKey = `provider-original-recovery:${row.assetId}:${row.eventId}`;
			await tx.outboxEvent.upsert({
				where: { dedupeKey },
				create: {
					dedupeKey,
					eventType: "MEDIA_OUTPUT_ARCHIVE",
					aggregateType: "MEDIA_ASSET",
					aggregateId: row.assetId,
					payload: { assetId: row.assetId },
				},
				update: {},
			});
			return 1;
		});
	}
	return rows.length + reopened + recovered;
}
