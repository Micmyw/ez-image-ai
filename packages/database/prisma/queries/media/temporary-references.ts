import {
	assertTemporaryReferenceUsable,
	isImageAutomaticDeletionEnabled,
	TEMPORARY_REFERENCE_RESERVATION_PREFIX,
	temporaryReferenceObjectKey,
	temporaryReferenceSchema,
	type TemporaryReference,
} from "@repo/config";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { effectiveMediaStorageLimit } from "./storage-quota";
import { isStorageFreshReadEnabled, lockOwnerStorageUsage } from "./storage-usage-locks";
import { runReadCommitted, runSerializable, type MediaTransactionClient } from "./types";

// An unknown PUT/commit can leave a complete object behind an ACTIVE reservation.
// Without automatic physical deletion, neither ACTIVE nor COMMITTED bytes may
// disappear from quota merely because the private access receipt expired.
export function unexpiredStorageReservations(
	now = new Date(),
): Prisma.StorageUsageReservationWhereInput {
	return {
		OR: [
			{ NOT: { referenceKey: { startsWith: TEMPORARY_REFERENCE_RESERVATION_PREFIX } } },
			{ expiresAt: { gt: now } },
			...(!isImageAutomaticDeletionEnabled()
				? [{ status: { in: ["ACTIVE", "COMMITTED"] as Array<"ACTIVE" | "COMMITTED"> } }]
				: []),
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
	const transaction = isStorageFreshReadEnabled() ? runReadCommitted : runSerializable;
	return transaction(client, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		// Read after the owner fence completes, so quota and expiry include its wait.
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (!clock) throw new Error("TEMPORARY_REFERENCE_INVALID");
		const now = clock.now;
		if (input.expiresAt.getTime() <= now.getTime()) throw new Error("TEMPORARY_REFERENCE_EXPIRED");
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
		const maximumBytes = await effectiveMediaStorageLimit(
			{ ownerType: "USER", ownerId: input.ownerId },
			input.maximumBytes,
			tx,
			now,
		);
		if (
			input.bytes <= 0 ||
			(maximumBytes !== null && (usage._sum.bytes ?? 0n) + BigInt(input.bytes) > maximumBytes)
		)
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

export interface TemporaryReferenceVerificationProfile {
	provider: string;
	ruleVersion: string;
	policyVersion: string;
}

/** The immutable write has completed; commit its quota and optional review intent together. */
export async function commitTemporaryReferenceVerificationTransaction(
	input: {
		ownerId: string;
		reservationId: string;
		reference: TemporaryReference;
		verification: TemporaryReferenceVerificationProfile | null;
	},
	client: MediaTransactionClient,
): Promise<{ reference: TemporaryReference; continuationEventIds: string[] }> {
	const reference = temporaryReferenceSchema.parse(input.reference);
	const freshRead = isStorageFreshReadEnabled();
	const transaction = freshRead ? runReadCommitted : runSerializable;
	return transaction(client, async (tx) => {
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		await lockMediaAssetGenerationBindings([reference.assetId], tx);
		// Older receivers can finalize ACTIVE reservations without the owner lock.
		// Wait for that row before reading its identity and the authoritative clock.
		if (freshRead)
			await tx.$queryRaw`SELECT id FROM storage_usage_reservation
				WHERE id = ${input.reservationId} FOR UPDATE`;
		const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
		if (!clock) throw new Error("TEMPORARY_REFERENCE_INVALID");
		assertTemporaryReferenceUsable(reference, input.ownerId, reference.assetId, clock.now);
		const reservation = await tx.storageUsageReservation.findUnique({
			where: { id: input.reservationId },
		});
		if (
			!reservation ||
			reservation.id !== input.reservationId ||
			reservation.referenceKey !==
				`${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}` ||
			reservation.ownerType !== "USER" ||
			reservation.ownerId !== input.ownerId ||
			!["ACTIVE", "COMMITTED"].includes(reservation.status) ||
			reservation.bytes !== BigInt(reference.bytes) ||
			reservation.expiresAt?.getTime() !== Date.parse(reference.expiresAt)
		)
			throw new Error("TEMPORARY_REFERENCE_INVALID");
		if (reservation.status === "ACTIVE") {
			const committed = await tx.storageUsageReservation.updateMany({
				where: {
					id: reservation.id,
					status: "ACTIVE",
					ownerType: "USER",
					ownerId: input.ownerId,
					referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}`,
					bytes: BigInt(reference.bytes),
					expiresAt: new Date(reference.expiresAt),
				},
				data: { status: "COMMITTED" },
			});
			if (committed.count !== 1) throw new Error("TEMPORARY_REFERENCE_INVALID");
		}
		// Pre-review is speculative. Closing generation retains the original pure-upload path.
		const disabled = input.verification
			? await tx.runtimeConfigOverride.findFirst({
					where: { active: true, configKey: "media.generation.enabled", value: { equals: false } },
					select: { id: true },
				})
			: null;
		if (!input.verification || disabled) return { reference, continuationEventIds: [] };
		const prepared = await prepareTemporaryReferenceAsset(
			{
				reference,
				now: clock.now,
				verification: input.verification,
				expectedRuleVersion: input.verification.ruleVersion,
				expectedPolicyVersion: input.verification.policyVersion,
			},
			tx,
		);
		return {
			reference,
			continuationEventIds: prepared.createdVerificationEventId
				? [prepared.createdVerificationEventId]
				: [],
		};
	});
}

/** Called only inside the job + binding + credit + Outbox transaction. */
export async function adoptTemporaryReference(
	input: {
		value: unknown;
		ownerId: string;
		assetIds: string[];
		now: Date;
		expectedRuleVersion?: string;
		expectedPolicyVersion?: string;
	},
	tx: Prisma.TransactionClient,
): Promise<{ reference: TemporaryReference; createdVerificationEventId?: string }> {
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
	return prepareTemporaryReferenceAsset({ ...input, reference }, tx);
}

async function prepareTemporaryReferenceAsset(
	input: {
		reference: TemporaryReference;
		now: Date;
		verification?: TemporaryReferenceVerificationProfile;
		expectedRuleVersion?: string;
		expectedPolicyVersion?: string;
	},
	tx: Prisma.TransactionClient,
): Promise<{ reference: TemporaryReference; createdVerificationEventId?: string }> {
	const { reference } = input;
	const objectKey = temporaryReferenceObjectKey(reference);
	const existing = await tx.mediaAsset.findUnique({ where: { id: reference.assetId } });
	if (existing) {
		if (
			existing.ownerId !== reference.ownerId ||
			existing.ownerType !== "USER" ||
			existing.kind !== "INPUT" ||
			existing.objectKey !== objectKey ||
			existing.checksum !== reference.checksum ||
			existing.byteSize !== BigInt(reference.bytes) ||
			existing.mimeType !== reference.contentType ||
			existing.verificationEngine !== "legacy" ||
			existing.verificationGeneration < 1 ||
			existing.deleteAfter?.getTime() !== Date.parse(reference.expiresAt) ||
			existing.deletedAt ||
			!["READY", "VERIFYING"].includes(existing.status)
		)
			throw new Error("ASSET_NOT_READY");
		// Receivers predating upload pre-review may have an untouched g1 asset with
		// no policy yet. Only the runtime can start/advance its review generation.
		const unstartedLegacyReview =
			existing.status === "VERIFYING" &&
			existing.verificationGeneration === 1 &&
			existing.verificationAttemptCount === 0 &&
			!existing.verificationProvider &&
			!existing.verificationProviderTaskId &&
			!existing.verificationSubmissionToken &&
			!existing.verificationSubmissionUncertain &&
			!existing.verificationLeaseToken &&
			!existing.verificationLeasedUntil &&
			!existing.verificationRuleVersion &&
			!existing.verificationPolicyVersion;
		if (
			!unstartedLegacyReview &&
			((input.expectedRuleVersion !== undefined &&
				existing.verificationRuleVersion !== input.expectedRuleVersion) ||
				(input.expectedPolicyVersion !== undefined &&
					existing.verificationPolicyVersion !== input.expectedPolicyVersion) ||
				(input.verification !== undefined &&
					existing.verificationProvider !== input.verification.provider))
		)
			throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
		return { reference };
	}
	await tx.mediaAsset.create({
		data: {
			id: reference.assetId,
			ownerType: "USER",
			ownerId: reference.ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			objectKey,
			mimeType: reference.contentType,
			byteSize: BigInt(reference.bytes),
			checksum: reference.checksum,
			finalizedAt: new Date(reference.createdAt),
			deleteAfter: new Date(reference.expiresAt),
			verificationGeneration: 1,
			verificationProvider: input.verification?.provider,
			verificationRuleVersion: input.expectedRuleVersion,
			verificationPolicyVersion: input.expectedPolicyVersion,
			verificationNextAttemptAt: null,
			verificationDeadlineAt: new Date(input.now.getTime() + 2 * 60_000),
		},
	});
	const event = await tx.outboxEvent.create({
		data: {
			eventType: "MEDIA_ASSET_VERIFY",
			aggregateType: "MEDIA_ASSET",
			aggregateId: reference.assetId,
			dedupeKey: `temporary-reference-verify:${reference.assetId}:g1`,
			payload: { assetId: reference.assetId },
		},
		select: { id: true },
	});
	return { reference, createdVerificationEventId: event.id };
}
