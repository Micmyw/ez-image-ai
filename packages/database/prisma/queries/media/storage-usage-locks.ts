import type { Prisma } from "../../generated/client";

const STORAGE_USAGE_LOCK_NAMESPACE = "media-owner-storage-usage";

/** Enable only after all quota writers use the owner fence and old writers drain. */
export function isStorageFreshReadEnabled(): boolean {
	return process.env.MEDIA_STORAGE_FRESH_READ_ENABLED === "true";
}

/**
 * Serializes every owner-scoped storage mutation with quota admission. This
 * prevents a generated output from committing durable bytes concurrently with
 * a new job that would otherwise observe stale storage usage.
 *
 * The write fence is unconditional during the receiver-first rollout: an old
 * Serializable snapshot must conflict with a newer ReadCommitted writer and
 * retry, even when it took its snapshot before waiting for the advisory lock.
 * Read quota usage in a separate statement after this function completes, so a
 * ReadCommitted reader observes the writer that just released the owner lock.
 */
export async function lockOwnerStorageUsage(
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: Prisma.TransactionClient,
): Promise<void> {
	await client.$executeRaw`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`${STORAGE_USAGE_LOCK_NAMESPACE}:${owner.ownerType}:${owner.ownerId}`}, 0)
		)`;
	await client.$executeRaw`
		INSERT INTO media_owner_storage_fence ("ownerType", "ownerId", revision)
		VALUES (${owner.ownerType}::"OwnerType", ${owner.ownerId}, 1)
		ON CONFLICT ("ownerType", "ownerId")
		DO UPDATE SET revision = media_owner_storage_fence.revision + 1
	`;
}
