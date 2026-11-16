import type { PrismaClient } from "../../generated/client";

/** One fresh read for existing owner/task/revocation authority. A pending asset
 * record is not required: the accepted job existed before model submission. */
export async function getImageResultAccess(
	jobId: string,
	assetId: string,
	database: PrismaClient,
	requesterId?: string,
) {
	const [row] = await database.$queryRaw<
		Array<{
			ownerId: string;
			status: string;
			attemptId: string;
			providerTaskId: string | null;
			uncertainSubmission: boolean;
			attemptStatus: string;
			assetStatus: string | null;
			deletedAt: Date | null;
			deleteAfter: Date | null;
			verificationGeneration: number | null;
			verificationLastErrorCode: string | null;
			guestExpiresAt: Date | null;
			grantedUserId: string | null;
			promptRejected: boolean;
		}>
	>`
		SELECT job."ownerId", job."status", attempt."id" AS "attemptId", attempt."providerTaskId",
			attempt."uncertainSubmission", attempt."status" AS "attemptStatus",
			asset."status" AS "assetStatus", asset."deletedAt", asset."deleteAfter",
			asset."verificationGeneration", asset."verificationLastErrorCode",
			trial."expiresAt" AS "guestExpiresAt", grant_access."registeredUserId" AS "grantedUserId",
			EXISTS (SELECT 1 FROM "moderation_review" review WHERE review."targetType"='QUOTE' AND review."targetId"=job."quoteId" AND review."status" IN ('REJECTED','BLOCKED')) AS "promptRejected"
		FROM "generation_job" job
		JOIN LATERAL (SELECT * FROM "generation_attempt" WHERE "jobId" = job."id" ORDER BY "attemptNumber" DESC LIMIT 1) attempt ON TRUE
		LEFT JOIN "media_asset" asset ON asset."id" = ${assetId}
		LEFT JOIN "guest_media_trial" trial ON trial."id" = job."guestTrialId"
		LEFT JOIN "guest_result_access_grant" grant_access ON grant_access."guestJobId"=job."id"
		 AND grant_access."registeredUserId"=${requesterId ?? null} AND grant_access."trialId"=trial."id"
		 AND grant_access."expiresAt"=trial."expiresAt" AND grant_access."expiresAt">clock_timestamp()
		WHERE job."id" = ${jobId} AND job."ownerType" = 'USER' AND job."executionEngine" = 'legacy'
	`;
	return row ?? null;
}
