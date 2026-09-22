import {
	assertTemporaryReferenceUsable,
	TEMPORARY_REFERENCE_RESERVATION_PREFIX,
	temporaryReferenceObjectKey,
	temporaryReferenceSchema,
	type TemporaryReference,
} from "@repo/config";

import type { Prisma } from "../../generated/client";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { runSerializable, type MediaTransactionClient } from "./types";

// Durable objects retain their existing accounting semantics. Temporary bytes
// stop consuming logical quota at their deadline, without a cleanup job.
export function unexpiredStorageReservations(
	now = new Date(),
): Prisma.StorageUsageReservationWhereInput {
	return {
		OR: [
			{ NOT: { referenceKey: { startsWith: TEMPORARY_REFERENCE_RESERVATION_PREFIX } } },
			{ expiresAt: { gt: now } },
		],
	};
}

export async function reserveTemporaryReference(
	input: {
		ownerId: string;
		assetId: string;
		bytes: number;
		expiresAt: Date;
		maximumBytes: bigint;
	},
	client: MediaTransactionClient,
) {
	return runSerializable(client, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		const now = new Date();
		const [usage, pending] = await Promise.all([
			tx.storageUsageReservation.aggregate({
				where: {
					ownerType: "USER",
					ownerId: input.ownerId,
					status: { in: ["ACTIVE", "COMMITTED"] },
					...unexpiredStorageReservations(now),
				},
				_sum: { bytes: true },
			}),
			tx.storageUsageReservation.count({
				where: {
					ownerType: "USER",
					ownerId: input.ownerId,
					status: "ACTIVE",
					referenceKey: { startsWith: TEMPORARY_REFERENCE_RESERVATION_PREFIX },
					createdAt: { gt: new Date(now.getTime() - 15 * 60_000) },
				},
			}),
		]);
		if (pending >= 5) throw new Error("ACTIVE_UPLOAD_SESSION_LIMIT_EXCEEDED");
		if (input.bytes <= 0 || (usage._sum.bytes ?? 0n) + BigInt(input.bytes) > input.maximumBytes)
			throw new Error("STORAGE_QUOTA_EXCEEDED");
		return tx.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: input.ownerId,
				bytes: BigInt(input.bytes),
				referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${input.assetId}`,
				expiresAt: input.expiresAt,
			},
		});
	});
}

/** Called only inside the job + binding + credit + Outbox transaction. */
export async function adoptTemporaryReference(
	input: {
		value: unknown;
		ownerId: string;
		assetIds: string[];
		now: Date;
	},
	tx: Prisma.TransactionClient,
): Promise<TemporaryReference> {
	const reference = temporaryReferenceSchema.parse(input.value);
	if (input.assetIds.length !== 1) throw new Error("TEMPORARY_REFERENCE_INVALID");
	assertTemporaryReferenceUsable(reference, input.ownerId, input.assetIds[0]!, input.now);
	const reservation = await tx.storageUsageReservation.findUnique({
		where: {
			referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}`,
		},
	});
	if (
		!reservation ||
		reservation.ownerType !== "USER" ||
		reservation.ownerId !== input.ownerId ||
		reservation.status !== "COMMITTED" ||
		reservation.bytes !== BigInt(reference.bytes) ||
		reservation.expiresAt?.getTime() !== Date.parse(reference.expiresAt)
	)
		throw new Error("TEMPORARY_REFERENCE_INVALID");
	const objectKey = temporaryReferenceObjectKey(reference);
	const existing = await tx.mediaAsset.findUnique({ where: { id: reference.assetId } });
	if (existing) {
		if (
			existing.ownerId !== input.ownerId ||
			existing.ownerType !== "USER" ||
			existing.kind !== "INPUT" ||
			existing.objectKey !== objectKey ||
			existing.checksum !== reference.checksum ||
			existing.byteSize !== BigInt(reference.bytes) ||
			existing.mimeType !== reference.contentType ||
			existing.deleteAfter?.getTime() !== Date.parse(reference.expiresAt) ||
			existing.deletedAt ||
			!["READY", "VERIFYING"].includes(existing.status)
		)
			throw new Error("ASSET_NOT_READY");
		return reference;
	}
	await tx.mediaAsset.create({
		data: {
			id: reference.assetId,
			ownerType: "USER",
			ownerId: input.ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey,
			mimeType: reference.contentType,
			byteSize: BigInt(reference.bytes),
			checksum: reference.checksum,
			finalizedAt: new Date(reference.createdAt),
			deleteAfter: new Date(reference.expiresAt),
			verificationGeneration: 1,
			verificationNextAttemptAt: null,
			verificationDeadlineAt: new Date(input.now.getTime() + 2 * 60_000),
		},
	});
	await tx.outboxEvent.create({
		data: {
			eventType: "MEDIA_ASSET_VERIFY",
			aggregateType: "MEDIA_ASSET",
			aggregateId: reference.assetId,
			dedupeKey: `temporary-reference-verify:${reference.assetId}:g1`,
			payload: { assetId: reference.assetId },
		},
	});
	return reference;
}
