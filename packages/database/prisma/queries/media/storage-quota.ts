import type { Prisma } from "../../generated/client";
import { findEffectivePaidSubscription } from "./billing";
import type { MediaDatabaseClient } from "./types";

type StorageOwner = { ownerType: "USER" | "ORGANIZATION"; ownerId: string };

/** null means no aggregate byte quota. All callers still meter and reserve bytes. */
export async function effectiveMediaStorageLimit(
	owner: StorageOwner,
	freeMaximumBytes: bigint,
	client: MediaDatabaseClient,
	now = new Date(),
): Promise<bigint | null> {
	if (freeMaximumBytes <= 0n) throw new Error("MEDIA_STORAGE_QUOTA_INVALID");
	return (await findEffectivePaidSubscription({ ...owner, now }, client)) ? null : freeMaximumBytes;
}

/** Server-owned job data, separate from the reviewed quote and all price fields. */
export function freezeAggregateStoragePolicy(
	pricingSnapshot: Prisma.JsonValue,
	maximumBytes: bigint | null,
): Prisma.JsonObject {
	if (!pricingSnapshot || typeof pricingSnapshot !== "object" || Array.isArray(pricingSnapshot))
		throw new Error("GENERATION_PRICING_SNAPSHOT_INVALID");
	if (maximumBytes !== null && maximumBytes <= 0n) throw new Error("MEDIA_STORAGE_QUOTA_INVALID");
	return {
		...pricingSnapshot,
		aggregateStoragePolicy: { schemaVersion: 1, maximumBytes: maximumBytes?.toString() ?? null },
	};
}

export function readAggregateStoragePolicy(snapshot: Prisma.JsonValue): bigint | null | undefined {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
	if (!("aggregateStoragePolicy" in snapshot)) return undefined;
	const policy = snapshot.aggregateStoragePolicy;
	if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.schemaVersion !== 1)
		throw new Error("AGGREGATE_STORAGE_POLICY_INVALID");
	if (policy.maximumBytes === null) return null;
	if (typeof policy.maximumBytes !== "string" || !/^[1-9][0-9]*$/.test(policy.maximumBytes))
		throw new Error("AGGREGATE_STORAGE_POLICY_INVALID");
	return BigInt(policy.maximumBytes);
}

/** Only the server-owned job extension is excluded; quote comparisons remain exact. */
export function pricingWithoutAggregateStoragePolicy(snapshot: Prisma.JsonValue): Prisma.JsonValue {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
	const { aggregateStoragePolicy: _policy, ...pricing } = snapshot;
	return pricing;
}

export async function outputMediaStorageLimit(
	owner: StorageOwner & { assetId?: string; jobId?: string },
	freeMaximumBytes: bigint,
	client: MediaDatabaseClient,
): Promise<bigint | null> {
	// Asset metadata and request input cannot establish an admitted storage policy.
	if (Boolean(owner.jobId) === Boolean(owner.assetId))
		throw new Error("OUTPUT_STORAGE_BINDING_REQUIRED");
	const job = owner.jobId
		? await client.generationJob.findFirst({
				where: { id: owner.jobId, ownerType: owner.ownerType, ownerId: owner.ownerId },
				select: { pricingSnapshot: true },
			})
		: (
				await client.generationJobAsset.findFirst({
					where: {
						assetId: owner.assetId,
						role: "OUTPUT",
						job: { ownerType: owner.ownerType, ownerId: owner.ownerId },
					},
					select: { job: { select: { pricingSnapshot: true } } },
				})
			)?.job;
	if (job) {
		const frozen = readAggregateStoragePolicy(job.pricingSnapshot);
		if (frozen === null) return null;
	}
	return effectiveMediaStorageLimit(
		{ ownerType: owner.ownerType, ownerId: owner.ownerId },
		freeMaximumBytes,
		client,
	);
}
