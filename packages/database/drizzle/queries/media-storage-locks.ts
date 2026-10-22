import { sql } from "drizzle-orm";

import type { db } from "../client";

type StorageTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function isStorageFreshReadEnabled(): boolean {
	return process.env.MEDIA_STORAGE_FRESH_READ_ENABLED === "true";
}

/** Keep the owner lock and conflict row identical to the Prisma quota writers. */
export async function lockOwnerStorageUsage(
	owner: { ownerType: "USER" | "ORGANIZATION"; ownerId: string },
	client: StorageTransaction,
): Promise<void> {
	await client.execute(sql`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`media-owner-storage-usage:${owner.ownerType}:${owner.ownerId}`}, 0)
		)`);
	await client.execute(sql`
		INSERT INTO media_owner_storage_fence ("ownerType", "ownerId", revision)
		VALUES (${owner.ownerType}::"OwnerType", ${owner.ownerId}, 1)
		ON CONFLICT ("ownerType", "ownerId")
		DO UPDATE SET revision = media_owner_storage_fence.revision + 1
	`);
}
