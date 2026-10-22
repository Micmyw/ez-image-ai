import {
	acquireImagePhaseOwnership,
	imagePhaseIdentity,
	imagePhaseOwner,
	type ImagePhaseIdentity,
	type ImagePhaseLease,
	type ImagePhaseOwner,
	type ImageWorkflowPhase,
} from "../../../shared/image-phase-ownership";
import type { Prisma } from "../../generated/client";

export * from "../../../shared/image-phase-ownership";

type Client = Prisma.TransactionClient;

/** Caller must hold the asset verification advisory lock or attempt row lock. */
export async function claimImagePhaseOwnerInTransaction(
	input: Parameters<typeof acquireImagePhaseOwnership>[0],
	tx: Client,
) {
	return acquireImagePhaseOwnership(input, {
		async read(identity) {
			const [result] = await tx.$queryRaw<Array<Partial<ImagePhaseLease> & { now: Date }>>`
				SELECT clock_timestamp() AS "now", owner."phaseKey", owner."workflowId", owner."epoch", owner."leasedUntil"
				FROM (SELECT 1) anchor LEFT JOIN "media_workflow_phase_owner" owner
				  ON owner."phaseKind" = ${identity.phaseKind} AND owner."subjectId" = ${identity.subjectId}
				 AND owner."generation" = ${identity.generation}`;
			if (!result) throw new Error("IMAGE_PHASE_CLOCK_UNAVAILABLE");
			return { lease: result.phaseKey ? (result as ImagePhaseLease) : null, now: result.now };
		},
		async write(identity, lease, previous) {
			if (!previous) {
				return (
					(await tx.$executeRaw`
					INSERT INTO "media_workflow_phase_owner" ("phaseKey", "phaseKind", "subjectId", "generation", "workflowId", "epoch", "leasedUntil", "createdAt", "updatedAt")
					VALUES (${lease.phaseKey}, ${identity.phaseKind}, ${identity.subjectId}, ${identity.generation}, ${lease.workflowId}, ${lease.epoch}, ${lease.leasedUntil}, clock_timestamp(), clock_timestamp())
					ON CONFLICT ("phaseKind", "subjectId", "generation") DO NOTHING`) === 1
				);
			}
			return (
				(await tx.$executeRaw`
				UPDATE "media_workflow_phase_owner" SET "workflowId" = ${lease.workflowId}, "epoch" = ${lease.epoch},
				 "leasedUntil" = ${lease.leasedUntil}, "updatedAt" = clock_timestamp()
				WHERE "phaseKey" = ${previous.phaseKey} AND "workflowId" = ${previous.workflowId}
				 AND "epoch" = ${previous.epoch} AND "leasedUntil" = ${previous.leasedUntil}`) === 1
			);
		},
	});
}

/** Only callers that already validated the immutable subject may signal this identity. */
export async function getImagePhaseOwner(
	phase: ImageWorkflowPhase,
	tx: Client,
): Promise<ImagePhaseOwner | undefined> {
	const identity = imagePhaseIdentity(phase);
	const [owner] = await tx.$queryRaw<ImagePhaseLease[]>`
		SELECT "phaseKey", "workflowId", "epoch", "leasedUntil" FROM "media_workflow_phase_owner"
		WHERE "phaseKind" = ${identity.phaseKind} AND "subjectId" = ${identity.subjectId}
		 AND "generation" = ${identity.generation} AND "leasedUntil" > clock_timestamp()`;
	return owner ? imagePhaseOwner(owner) : undefined;
}

/** Pending callback delivery uses DB lease time and does not spend a failure retry. */
export async function getProviderEventDeliveryWait(
	input: { eventId: string; attemptId?: string; includeProcessingLease: boolean },
	tx: Client,
): Promise<number> {
	const [row] = await tx.$queryRaw<Array<{ retryAfterMs: number }>>`
	 SELECT GREATEST(0,
	  COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (owner."leasedUntil" - clock_timestamp())) * 1000)
	   FROM "media_workflow_phase_owner" owner WHERE owner."phaseKind" = 'generation'
	    AND owner."subjectId" = ${input.attemptId ?? null} AND owner."generation" = 0), 0),
	  COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (event."processingLeasedUntil" - clock_timestamp())) * 1000)
	   FROM "provider_webhook_event" event WHERE ${input.includeProcessingLease}::boolean
	    AND event."id" = ${input.eventId} AND event."status" = 'PROCESSING'), 0)
	 )::double precision AS "retryAfterMs"`;
	if (!row || !Number.isFinite(row.retryAfterMs) || row.retryAfterMs < 0)
		throw new Error("INVALID_PROVIDER_EVENT_WAIT");
	return row.retryAfterMs;
}

/** Check inside the same subject-locked transaction as the protected mutation. */
export async function isImagePhaseOwnerCurrent(
	phase: ImageWorkflowPhase,
	owner: ImagePhaseOwner,
	tx: Client,
): Promise<boolean> {
	const identity: ImagePhaseIdentity = imagePhaseIdentity(phase);
	const [current] = await tx.$queryRaw<Array<{ current: boolean }>>`
		SELECT EXISTS (SELECT 1 FROM "media_workflow_phase_owner"
		 WHERE "phaseKind" = ${identity.phaseKind} AND "subjectId" = ${identity.subjectId}
		 AND "generation" = ${identity.generation} AND "phaseKey" = ${owner.phaseKey}
		 AND "workflowId" = ${owner.workflowId} AND "epoch" = ${owner.epoch}
		 AND "leasedUntil" > clock_timestamp()) AS "current"`;
	return current?.current === true;
}

/** Maintenance only. A replacement gets a fresh UUID, so expired receipts cannot revive. */
export async function deleteExpiredImagePhaseOwners(
	input: { limit: number },
	tx: Client,
): Promise<number> {
	if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
		throw new Error("INVALID_IMAGE_PHASE_CLEANUP_LIMIT");
	const deleted = await tx.$queryRaw<Array<{ phaseKey: string }>>`
		WITH expired AS (
		 SELECT owner."phaseKey" FROM "media_workflow_phase_owner" owner
		 WHERE owner."leasedUntil" < clock_timestamp() - INTERVAL '24 hours'
		 AND NOT EXISTS (SELECT 1 FROM "media_asset" asset WHERE owner."phaseKind" = 'verification'
		  AND asset."id" = owner."subjectId" AND asset."verificationGeneration" = owner."generation"
		  AND asset."verificationLeasedUntil" > clock_timestamp())
		 AND NOT EXISTS (SELECT 1 FROM "generation_attempt" attempt WHERE owner."phaseKind" = 'generation'
		  AND attempt."id" = owner."subjectId" AND attempt."reconcileLeasedUntil" > clock_timestamp())
		 ORDER BY owner."leasedUntil", owner."phaseKey" FOR UPDATE OF owner SKIP LOCKED LIMIT ${input.limit}
		) DELETE FROM "media_workflow_phase_owner" owner USING expired
		WHERE owner."phaseKey" = expired."phaseKey" RETURNING owner."phaseKey"`;
	return deleted.length;
}
