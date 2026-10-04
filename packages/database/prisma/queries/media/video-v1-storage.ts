import { VIDEO_OUTPUT_MAX_BYTES } from "@repo/config/video-output";

import type { Prisma } from "../../generated/client";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { unexpiredStorageReservations } from "./temporary-references";
import { releaseVideoTemplatePreSceneCapacity } from "./video-template-storage";

export const videoOutputStoragePolicy = {
	schemaVersion: 1,
	maximumBytes: VIDEO_OUTPUT_MAX_BYTES,
};

export function videoOutputReservationKey(jobId: string) {
	return `video-output:${jobId}`;
}

export function videoOutputReservationBytes(snapshot: Prisma.JsonValue): bigint {
	const policy =
		snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
			? snapshot.outputStoragePolicy
			: undefined;
	// Historical accepted jobs used the same fixed maximum. They may recover
	// storage after authenticated provider success, but cannot bypass the paid fence.
	if (policy === undefined) return BigInt(VIDEO_OUTPUT_MAX_BYTES);
	if (
		!policy ||
		typeof policy !== "object" ||
		Array.isArray(policy) ||
		policy.schemaVersion !== 1 ||
		typeof policy.maximumBytes !== "number" ||
		!Number.isSafeInteger(policy.maximumBytes) ||
		policy.maximumBytes < 1 ||
		policy.maximumBytes > VIDEO_OUTPUT_MAX_BYTES
	)
		throw new Error("VIDEO_OUTPUT_STORAGE_POLICY_INVALID");
	return BigInt(policy.maximumBytes);
}

/** Always acquire this before a video job/asset lock when changing capacity. */
export async function lockVideoOwnerStorage(tx: Prisma.TransactionClient, jobId: string) {
	const owner = await tx.generationJob.findFirst({
		where: { id: jobId, executionEngine: "video-workflow-v1", ownerType: "USER" },
		select: { ownerType: true, ownerId: true },
	});
	if (!owner) throw new Error("VIDEO_JOB_NOT_FOUND");
	await lockOwnerStorageUsage(owner, tx);
	return owner;
}

export async function videoOwnerStorageUsage(
	tx: Prisma.TransactionClient,
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	excludeKeys: string[] = [],
) {
	const usage = await tx.storageUsageReservation.aggregate({
		where: {
			...owner,
			status: { in: ["ACTIVE", "COMMITTED"] },
			...unexpiredStorageReservations(new Date()),
			...(excludeKeys.length ? { referenceKey: { notIn: excludeKeys } } : {}),
		},
		_sum: { bytes: true },
	});
	return usage._sum.bytes ?? 0n;
}

/** No output binding means no transfer could have written an object. */
export async function releaseVideoPreOutputCapacity(
	tx: Prisma.TransactionClient,
	job: { id: string; ownerType: "USER" | "ORGANIZATION"; ownerId: string },
) {
	await releaseVideoTemplatePreSceneCapacity(tx, job);
	if (await tx.generationJobAsset.count({ where: { jobId: job.id, role: "OUTPUT" } })) return;
	await tx.storageUsageReservation.updateMany({
		where: {
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			referenceKey: videoOutputReservationKey(job.id),
			status: "ACTIVE",
		},
		data: { status: "RELEASED", releasedAt: new Date() },
	});
}
