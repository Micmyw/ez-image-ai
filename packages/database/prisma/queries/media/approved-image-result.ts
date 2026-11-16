import { randomUUID } from "node:crypto";

import {
	isApprovedImageResult,
	imageResultPriorReview,
	IMAGE_APPROVAL_NO_TIME_EXPIRY,
	type ImageResultReceipt,
} from "@repo/config/image-result";

import type { PrismaClient } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { runReadCommitted } from "./types";

/** Background import of a URL review. The digest describes the subsequently
 * fetched original; it is not claimed to be a digest returned by SeeAPI. */
export async function persistApprovedImageResult(
	input: {
		receipt: ImageResultReceipt;
		checksum: string;
		bytes: number;
		policyVersion: string;
	},
	database: PrismaClient,
) {
	const { receipt } = input;
	const prior = imageResultPriorReview(receipt);
	if (
		!isApprovedImageResult(receipt) ||
		receipt.policyVersion !== input.policyVersion ||
		!/^[a-f0-9]{64}$/.test(input.checksum) ||
		!Number.isSafeInteger(input.bytes) ||
		input.bytes < 1 ||
		input.bytes > 25 * 1024 * 1024
	)
		throw new Error("IMAGE_RESULT_IMPORT_INVALID");
	return runReadCommitted(database, async (tx) => {
		const identity = await tx.generationJob.findFirst({
			where: {
				id: receipt.context.jobId,
				ownerId: receipt.context.ownerId,
				executionEngine: "legacy",
			},
			select: { quoteId: true },
		});
		if (!identity) return false;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`moderation-quote:${identity.quoteId}`}, 0))`;
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${receipt.assetId}`}, 0))`;
		const [job] = await tx.$queryRaw<Array<{ id: string; guestExpiresAt: Date | null }>>`
			SELECT job."id", trial."expiresAt" AS "guestExpiresAt" FROM "generation_job" job
			JOIN "generation_attempt" attempt ON attempt."jobId" = job."id" AND attempt."id" = ${receipt.context.attemptId}
			LEFT JOIN "guest_media_trial" trial ON trial."id" = job."guestTrialId"
			WHERE job."id" = ${receipt.context.jobId} AND job."ownerId" = ${receipt.context.ownerId}
			 AND job."ownerType" = 'USER' AND job."executionEngine" = 'legacy'
			 AND job."status" IN ('PROVIDER_PENDING', 'PROVIDER_RUNNING', 'FINALIZING', 'SUCCEEDED')
			 AND attempt."provider" = 'kie' AND attempt."providerTaskId" = ${receipt.completion.providerTaskId}
			 AND attempt."providerModelId" = ${receipt.completion.providerModelId} AND NOT attempt."uncertainSubmission"
			 AND attempt."status" NOT IN ('SUBMISSION_UNCERTAIN', 'NEEDS_RECONCILIATION', 'FAILED')
			 AND NOT EXISTS (SELECT 1 FROM "generation_attempt" later WHERE later."jobId"=job."id" AND later."attemptNumber">attempt."attemptNumber")
			 AND (trial."id" IS NULL OR trial."expiresAt" > clock_timestamp())
			 AND NOT EXISTS (SELECT 1 FROM "moderation_review" review WHERE review."targetType"='QUOTE' AND review."targetId"=job."quoteId" AND review."status" IN ('REJECTED','BLOCKED'))
			FOR NO KEY UPDATE OF job`;
		if (!job || Boolean(job.guestExpiresAt) !== receipt.context.guest) return false;
		await lockMediaAssetGenerationBindings([receipt.assetId], tx);
		const extension =
			receipt.mimeType === "image/svg+xml"
				? "svg"
				: receipt.mimeType === "image/jpeg"
					? "jpg"
					: receipt.mimeType.slice(6);
		const key = `provider-original-v1/users/${receipt.context.ownerId}/assets/${receipt.assetId}/original.${extension}`;
		const existing = await tx.mediaAsset.findUnique({
			where: { id: receipt.assetId },
			include: { moderationResults: true },
		});
		const origin =
			existing && (await tx.mediaOutputOrigin.findUnique({ where: { assetId: receipt.assetId } }));
		if (existing && origin?.url !== receipt.completion.outputUrl) return false;
		if (existing?.status === "READY")
			return (
				!existing.deletedAt &&
				existing.ownerId === receipt.context.ownerId &&
				existing.verificationGeneration === 1 &&
				existing.verificationProviderTaskId === receipt.submission.moderationTaskId
			);
		if (
			existing &&
			(existing.status !== "VERIFYING" ||
				existing.deletedAt ||
				existing.ownerId !== receipt.context.ownerId ||
				existing.objectKey !== key ||
				existing.sourceUrl !== `provider-output:${receipt.context.attemptId}:0` ||
				existing.verificationGeneration > 1 ||
				(existing.verificationProviderTaskId &&
					existing.verificationProviderTaskId !== receipt.submission.moderationTaskId &&
					existing.verificationProviderTaskId !== prior?.moderationTaskId) ||
				(existing.verificationSubmissionToken &&
					existing.verificationSubmissionToken !== receipt.submission.idempotency.key &&
					existing.verificationSubmissionToken !== prior?.idempotencyKey) ||
				existing.moderationResults.some(
					(result) =>
						result.status !== "PENDING" ||
						(result.providerTaskId !== receipt.submission.moderationTaskId &&
							result.providerTaskId !== prior?.moderationTaskId),
				))
		)
			return false;
		const attemptNumber = Math.max(
			1,
			(existing?.verificationAttemptCount ?? 0) + (existing?.moderationResults.length ? 1 : 0),
		);
		const validUntil = new Date(IMAGE_APPROVAL_NO_TIME_EXPIRY);
		// Asset, origin, evidence, binding and archive intent share one write statement.
		// No financial mutation occurs here; the existing finalizer/ledger owns settlement.
		const [written] = await tx.$queryRaw<Array<{ id: string }>>`
			WITH asset AS (
			 INSERT INTO "media_asset" ("id","ownerType","ownerId","kind","status","retentionClass","deleteAfter",
			 "objectKey","mimeType","byteSize","checksum","finalizedAt","sourceUrl","verificationEngine",
			 "verificationGeneration","verificationAttemptCount","verificationProvider","verificationProviderTaskId",
			 "verificationRuleVersion","verificationPolicyVersion","verificationValidUntil","verificationSubmissionToken",
			 "verificationSubmittedAt","watermarkVersion","watermarkedAt","updatedAt")
			 SELECT ${receipt.assetId},'USER',${receipt.context.ownerId},'OUTPUT','VERIFYING',
			 ${receipt.context.guest ? "GUEST_TRIAL" : "ACCOUNT"}::"MediaRetentionClass",${job.guestExpiresAt},
			 ${key},${receipt.mimeType},${BigInt(input.bytes)},${input.checksum},clock_timestamp(),
			 ${`provider-output:${receipt.context.attemptId}:0`},'legacy',1,${attemptNumber},'seeapi',${receipt.submission.moderationTaskId},
			 ${receipt.submission.ruleVersion},${input.policyVersion},${validUntil},${receipt.submission.idempotency.key},
			 ${new Date(receipt.completion.receivedAt)},${receipt.context.guest ? "ezpic-guest-origin-v1" : null},
			 ${receipt.context.guest ? new Date() : null},clock_timestamp()
			 WHERE ${new Date(receipt.context.expiresAt)} > clock_timestamp()
			 AND ${new Date(receipt.approvedAt! + 86_400_000)} > clock_timestamp()
			 ON CONFLICT ("id") DO UPDATE SET "status"='VERIFYING', "byteSize"=EXCLUDED."byteSize", "checksum"=EXCLUDED."checksum",
			 "finalizedAt"=EXCLUDED."finalizedAt", "verificationGeneration"=1, "verificationAttemptCount"=EXCLUDED."verificationAttemptCount",
			 "verificationProvider"=EXCLUDED."verificationProvider", "verificationProviderTaskId"=EXCLUDED."verificationProviderTaskId",
			 "verificationRuleVersion"=EXCLUDED."verificationRuleVersion", "verificationPolicyVersion"=EXCLUDED."verificationPolicyVersion",
			 "verificationValidUntil"=EXCLUDED."verificationValidUntil", "verificationSubmissionToken"=EXCLUDED."verificationSubmissionToken",
			 "verificationSubmissionUncertain"=FALSE,"verificationLeaseToken"=NULL,"verificationLeasedUntil"=NULL,"verificationNextAttemptAt"=NULL,
			 "watermarkVersion"=EXCLUDED."watermarkVersion","watermarkedAt"=EXCLUDED."watermarkedAt","updatedAt"=clock_timestamp()
			 WHERE "media_asset"."status"='VERIFYING' AND "media_asset"."deletedAt" IS NULL
			 AND "media_asset"."verificationGeneration"<=1
			 RETURNING "id"
			), origin AS (
			 INSERT INTO "media_output_origin" ("assetId","url") SELECT "id",${receipt.completion.outputUrl} FROM asset
			 ON CONFLICT ("assetId") DO NOTHING RETURNING "assetId"
			), evidence AS (
			 INSERT INTO "asset_moderation_result" ("id","assetId","assetChecksum","verificationGeneration","attemptNumber",
			 "evidenceKind","provider","providerTaskId","ruleVersion","policyVersion","status","reasonCode","categories","rawEnvelope","validUntil")
			 SELECT ${randomUUID()},"id",${input.checksum},1,${attemptNumber},'OUTPUT','seeapi',${receipt.submission.moderationTaskId},
			 ${receipt.submission.ruleVersion},${input.policyVersion},'APPROVED',${receipt.decision!.reasonCode},'{}'::jsonb,
			 ${JSON.stringify({ source: "provider-url-review-v1", reviewInput: receipt.reviewInput, reviewedUrl: receipt.completion.outputUrl, decision: receipt.decision, ...(prior ? { priorReview: prior } : {}) })}::jsonb,${validUntil} FROM asset RETURNING "assetId"
			), binding AS (
			 INSERT INTO "generation_job_asset" ("id","jobId","assetId","assetChecksum","role","position")
			 SELECT ${randomUUID()},${receipt.context.jobId},"id",${input.checksum},'OUTPUT',0 FROM asset
			 ON CONFLICT ("jobId","assetId","role") DO UPDATE SET "assetChecksum"=EXCLUDED."assetChecksum" RETURNING "assetId"
			), archive AS (
			 INSERT INTO "outbox_event" ("id","dedupeKey","eventType","aggregateType","aggregateId","payload")
			 SELECT ${randomUUID()},${`provider-original-archive:${receipt.assetId}:0`},'MEDIA_OUTPUT_ARCHIVE','MEDIA_ASSET',"id",
			 ${JSON.stringify({ assetId: receipt.assetId })}::jsonb FROM asset ON CONFLICT ("dedupeKey") DO NOTHING RETURNING "id"
			), job_fence AS (UPDATE "generation_job" SET "updatedAt"=clock_timestamp() WHERE "id"=${receipt.context.jobId} AND EXISTS(SELECT 1 FROM asset))
			 SELECT "id" FROM asset`;
		if (!written) return false;
		// The existing READY trigger must observe the evidence from a previous
		// statement. Keep this last transition in the same transaction, off delivery.
		await tx.$executeRaw`UPDATE "media_asset" SET "status"='READY',"updatedAt"=clock_timestamp() WHERE "id"=${receipt.assetId}`;
		return true;
	});
}
