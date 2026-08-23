import type { Prisma } from "../../generated/client";

const STORAGE_USAGE_LOCK_NAMESPACE = "media-owner-storage-usage";

/**
 * Serializes every owner-scoped storage mutation with quota admission. This
 * prevents a generated output from committing durable bytes concurrently with
 * a new job that would otherwise observe stale storage usage.
 */
export async function lockOwnerStorageUsage(
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: Prisma.TransactionClient,
): Promise<void> {
	await client.$executeRaw`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`${STORAGE_USAGE_LOCK_NAMESPACE}:${owner.ownerType}:${owner.ownerId}`}, 0)
		)`;
}
