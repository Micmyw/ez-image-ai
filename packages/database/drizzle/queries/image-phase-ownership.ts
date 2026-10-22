import { sql } from "drizzle-orm";

import {
	acquireImagePhaseOwnership,
	imagePhaseIdentity,
	imagePhaseOwner,
	type ImagePhaseLease,
	type ImagePhaseOwner,
	type ImageWorkflowPhase,
} from "../../shared/image-phase-ownership";
import type { db } from "../client";

export * from "../../shared/image-phase-ownership";
type Client = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Same subject-lock precondition and persisted CAS as the Prisma implementation. */
export async function claimImagePhaseOwnerInTransaction(
	input: Parameters<typeof acquireImagePhaseOwnership>[0],
	tx: Client,
) {
	return acquireImagePhaseOwnership(input, {
		async read(identity) {
			const result = await tx.execute(sql`
				SELECT clock_timestamp() AS "now", owner."phaseKey", owner."workflowId", owner."epoch", owner."leasedUntil"
				FROM (SELECT 1) anchor LEFT JOIN "media_workflow_phase_owner" owner
				  ON owner."phaseKind" = ${identity.phaseKind} AND owner."subjectId" = ${identity.subjectId}
				 AND owner."generation" = ${identity.generation}`);
			const row = result.rows[0] as (Partial<ImagePhaseLease> & { now: Date }) | undefined;
			if (!row) throw new Error("IMAGE_PHASE_CLOCK_UNAVAILABLE");
			return { lease: row.phaseKey ? (row as ImagePhaseLease) : null, now: row.now };
		},
		async write(identity, lease, previous) {
			const result = previous
				? await tx.execute(sql`
					UPDATE "media_workflow_phase_owner" SET "workflowId" = ${lease.workflowId}, "epoch" = ${lease.epoch},
					 "leasedUntil" = ${lease.leasedUntil}, "updatedAt" = clock_timestamp()
					WHERE "phaseKey" = ${previous.phaseKey} AND "workflowId" = ${previous.workflowId}
					 AND "epoch" = ${previous.epoch} AND "leasedUntil" = ${previous.leasedUntil} RETURNING "phaseKey"`)
				: await tx.execute(sql`
					INSERT INTO "media_workflow_phase_owner" ("phaseKey", "phaseKind", "subjectId", "generation", "workflowId", "epoch", "leasedUntil", "createdAt", "updatedAt")
					VALUES (${lease.phaseKey}, ${identity.phaseKind}, ${identity.subjectId}, ${identity.generation}, ${lease.workflowId}, ${lease.epoch}, ${lease.leasedUntil}, clock_timestamp(), clock_timestamp())
					ON CONFLICT ("phaseKind", "subjectId", "generation") DO NOTHING RETURNING "phaseKey"`);
			return result.rows.length === 1;
		},
	});
}

export async function getImagePhaseOwner(
	phase: ImageWorkflowPhase,
	tx: Client,
): Promise<ImagePhaseOwner | undefined> {
	const identity = imagePhaseIdentity(phase);
	const result = await tx.execute(sql`
		SELECT "phaseKey", "workflowId", "epoch", "leasedUntil" FROM "media_workflow_phase_owner"
		WHERE "phaseKind" = ${identity.phaseKind} AND "subjectId" = ${identity.subjectId}
		 AND "generation" = ${identity.generation} AND "leasedUntil" > clock_timestamp()`);
	const owner = result.rows[0] as unknown as ImagePhaseLease | undefined;
	return owner ? imagePhaseOwner(owner) : undefined;
}

export async function getProviderEventDeliveryWait(
	input: { eventId: string; attemptId?: string; includeProcessingLease: boolean },
	tx: Client,
): Promise<number> {
	const result = await tx.execute(sql`
	 SELECT GREATEST(0,
	  COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (owner."leasedUntil" - clock_timestamp())) * 1000)
	   FROM "media_workflow_phase_owner" owner WHERE owner."phaseKind" = 'generation'
	    AND owner."subjectId" = ${input.attemptId ?? null} AND owner."generation" = 0), 0),
	  COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (event."processingLeasedUntil" - clock_timestamp())) * 1000)
	   FROM "provider_webhook_event" event WHERE ${input.includeProcessingLease}::boolean
	    AND event."id" = ${input.eventId} AND event."status" = 'PROCESSING'), 0)
	 )::double precision AS "retryAfterMs"`);
	const retryAfterMs = result.rows[0]?.retryAfterMs;
	if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)
		throw new Error("INVALID_PROVIDER_EVENT_WAIT");
	return retryAfterMs;
}

export async function isImagePhaseOwnerCurrent(
	phase: ImageWorkflowPhase,
	owner: ImagePhaseOwner,
	tx: Client,
): Promise<boolean> {
	const identity = imagePhaseIdentity(phase);
	const result = await tx.execute(sql`
		SELECT EXISTS (SELECT 1 FROM "media_workflow_phase_owner"
		 WHERE "phaseKind" = ${identity.phaseKind} AND "subjectId" = ${identity.subjectId}
		 AND "generation" = ${identity.generation} AND "phaseKey" = ${owner.phaseKey}
		 AND "workflowId" = ${owner.workflowId} AND "epoch" = ${owner.epoch}
		 AND "leasedUntil" > clock_timestamp()) AS "current"`);
	return result.rows[0]?.current === true;
}

export async function deleteExpiredImagePhaseOwners(
	input: { limit: number },
	tx: Client,
): Promise<number> {
	if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000)
		throw new Error("INVALID_IMAGE_PHASE_CLEANUP_LIMIT");
	const result = await tx.execute(sql`
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
		WHERE owner."phaseKey" = expired."phaseKey" RETURNING owner."phaseKey"`);
	return result.rows.length;
}
