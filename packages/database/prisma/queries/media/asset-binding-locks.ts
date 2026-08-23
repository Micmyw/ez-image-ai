import type { Prisma } from "../../generated/client";

const MEDIA_ASSET_BINDING_LOCK_NAMESPACE = "media-asset-generation-binding";

export const LIVE_GENERATION_JOB_STATUSES = [
	"RESERVED",
	"DISPATCH_QUEUED",
	"SUBMITTING",
	"PROVIDER_PENDING",
	"PROVIDER_RUNNING",
	"NEEDS_RECONCILIATION",
	"FINALIZING",
] as const;

export async function lockMediaAssetGenerationBindings(
	assetIds: readonly string[],
	client: Prisma.TransactionClient,
): Promise<void> {
	const sortedAssetIds = [...new Set(assetIds)].sort();
	for (const assetId of sortedAssetIds) {
		await client.$executeRaw`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`${MEDIA_ASSET_BINDING_LOCK_NAMESPACE}:${assetId}`}, 0)
			)`;
	}
}
