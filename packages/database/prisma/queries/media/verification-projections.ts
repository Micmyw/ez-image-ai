import type { Prisma } from "../../generated/client";
import type { ImagePhaseOwner } from "./image-phase-ownership";

export const MEDIA_VERIFICATION_CLAIM_SELECT = {
	id: true,
	kind: true,
	status: true,
	deletedAt: true,
	objectKey: true,
	mimeType: true,
	byteSize: true,
	checksum: true,
	storageEtag: true,
	storageVersionId: true,
	finalizedAt: true,
	outputTransferToken: true,
	deleteAfter: true,
	verificationEngine: true,
	verificationGeneration: true,
	verificationAttemptCount: true,
	verificationProvider: true,
	verificationRuleVersion: true,
	verificationPolicyVersion: true,
	verificationProviderTaskId: true,
	verificationLeaseToken: true,
	verificationLeasedUntil: true,
	verificationNextAttemptAt: true,
	verificationDeadlineAt: true,
	verificationValidUntil: true,
	verificationSubmissionToken: true,
	verificationSubmissionUncertain: true,
	verificationCallbackReceivedAt: true,
	verificationLastErrorCode: true,
} as const satisfies Prisma.MediaAssetSelect;

export type MediaVerificationClaimAsset = Prisma.MediaAssetGetPayload<{
	select: typeof MEDIA_VERIFICATION_CLAIM_SELECT;
}>;

interface VerificationFacts {
	failureCount: number;
	hasAccountInputCopy: boolean;
}

interface QueryRow extends MediaVerificationClaimAsset, VerificationFacts {
	hasLegacyReverificationMarker: boolean;
	phaseKey: string | null;
	workflowId: string | null;
	epoch: number | null;
}

/**
 * Read only after the caller takes this asset's verification advisory lock.
 * These facts belong to this transaction/generation, never to an RPC admission
 * snapshot. The live-owner join replaces getImagePhaseOwner only; it must never
 * become the acquisition snapshot. Renewal still reads the complete owner row
 * (including expired epochs) and fresh DB time, followed by the provider fence.
 */
export async function readMediaVerificationQueryProjection(
	assetId: string,
	tx: Prisma.TransactionClient,
) {
	const [row] = await tx.$queryRaw<QueryRow[]>`
	 SELECT asset."id", asset."kind", asset."status", asset."deletedAt", asset."objectKey",
	  asset."mimeType", asset."byteSize", asset."checksum", asset."storageEtag", asset."storageVersionId",
	  asset."finalizedAt", asset."outputTransferToken", asset."deleteAfter", asset."verificationEngine",
	  asset."verificationGeneration", asset."verificationAttemptCount", asset."verificationProvider",
	  asset."verificationRuleVersion", asset."verificationPolicyVersion", asset."verificationProviderTaskId",
	  asset."verificationLeaseToken", asset."verificationLeasedUntil", asset."verificationNextAttemptAt",
	  asset."verificationDeadlineAt", asset."verificationValidUntil", asset."verificationSubmissionToken",
	  asset."verificationSubmissionUncertain", asset."verificationCallbackReceivedAt", asset."verificationLastErrorCode",
	  owner."phaseKey", owner."workflowId", owner."epoch",
	  EXISTS (SELECT 1 FROM "outbox_event" copy WHERE copy."eventType" = 'ACCOUNT_INPUT_COPY_TARGET'
	   AND copy."dedupeKey" = 'account-input-copy-target:' || asset."id") AS "hasAccountInputCopy",
	  EXISTS (SELECT 1 FROM "audit_log" audit WHERE audit."action" = 'MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED'
	   AND audit."targetType" = 'MEDIA_ASSET' AND audit."targetId" = asset."id") AS "hasLegacyReverificationMarker",
	  (SELECT COUNT(*)::int FROM "asset_moderation_result" evidence WHERE evidence."assetId" = asset."id"
	   AND evidence."verificationGeneration" = GREATEST(asset."verificationGeneration", 1)
	   AND evidence."status" = 'ERROR') AS "failureCount"
	 FROM "media_asset" asset
	 LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
	  AND owner."subjectId" = asset."id" AND owner."generation" = GREATEST(asset."verificationGeneration", 1)
	  AND owner."leasedUntil" > clock_timestamp()
	 WHERE asset."id" = ${assetId} AND asset."verificationEngine" = 'legacy'`;
	if (!row) return null;
	assertVerificationFacts(row);
	if (typeof row.hasLegacyReverificationMarker !== "boolean")
		throw new Error("INVALID_VERIFICATION_PROJECTION");
	const {
		phaseKey,
		workflowId,
		epoch,
		hasAccountInputCopy,
		hasLegacyReverificationMarker,
		failureCount,
		...asset
	} = row;
	let phaseOwner: ImagePhaseOwner | undefined;
	if (phaseKey !== null || workflowId !== null || epoch !== null) {
		if (!phaseKey || !workflowId || !Number.isSafeInteger(epoch) || epoch! < 1)
			throw new Error("INVALID_VERIFICATION_PHASE_PROJECTION");
		phaseOwner = { phaseKey, workflowId, epoch: epoch! };
	}
	return { asset, phaseOwner, hasAccountInputCopy, hasLegacyReverificationMarker, failureCount };
}

type VerdictAsset = Prisma.MediaAssetGetPayload<{
	select: {
		id: true;
		kind: true;
		mimeType: true;
		ownerType: true;
		ownerId: true;
		verificationProviderTaskId: true;
	};
}>;

interface VerdictRow extends Omit<VerdictAsset, "id">, VerificationFacts {
	id: string | null;
	phaseOwnerCurrent: boolean;
	previousReviewId: string | null;
	previousLastErrorCode: string | null;
	previousLastFailureAt: Date | null;
}

/** Caller retains the prompt, verification and output-job lock order. */
export async function readMediaVerificationVerdictProjection(
	input: {
		assetId: string;
		generation: number;
		leaseToken: string;
		now: Date;
		phaseOwner?: ImagePhaseOwner;
	},
	tx: Prisma.TransactionClient,
) {
	const [row] = await tx.$queryRaw<VerdictRow[]>`
	 SELECT asset."id", asset."kind", asset."mimeType", asset."ownerType", asset."ownerId",
	  asset."verificationProviderTaskId", review."id" AS "previousReviewId",
	  review."lastErrorCode" AS "previousLastErrorCode", review."lastFailureAt" AS "previousLastFailureAt",
	  CASE WHEN ${input.phaseOwner?.phaseKey ?? null}::text IS NULL THEN TRUE ELSE
	   EXISTS (SELECT 1 FROM "media_workflow_phase_owner" owner WHERE owner."phaseKind" = 'verification'
	    AND owner."subjectId" = ${input.assetId} AND owner."generation" = ${input.generation}
	    AND owner."phaseKey" = ${input.phaseOwner?.phaseKey ?? null}
	    AND owner."workflowId" = ${input.phaseOwner?.workflowId ?? null}
	    AND owner."epoch" = ${input.phaseOwner?.epoch ?? null}::int
	    AND owner."leasedUntil" > clock_timestamp()) END AS "phaseOwnerCurrent",
	  EXISTS (SELECT 1 FROM "outbox_event" copy WHERE copy."eventType" = 'ACCOUNT_INPUT_COPY_TARGET'
	   AND copy."dedupeKey" = 'account-input-copy-target:' || asset."id") AS "hasAccountInputCopy",
	  (SELECT COUNT(*)::int FROM "asset_moderation_result" evidence WHERE evidence."assetId" = asset."id"
	   AND evidence."verificationGeneration" = asset."verificationGeneration"
	   AND evidence."status" = 'ERROR') AS "failureCount"
	 FROM (SELECT 1) anchor
	 LEFT JOIN "media_asset" asset ON asset."id" = ${input.assetId} AND asset."verificationEngine" = 'legacy'
	  AND asset."status" = 'VERIFYING' AND asset."verificationGeneration" = ${input.generation}
	  AND asset."verificationLeaseToken" = ${input.leaseToken}
	  AND asset."verificationLeasedUntil" > CASE WHEN ${input.phaseOwner?.phaseKey ?? null}::text IS NULL
	   THEN ${input.now} ELSE clock_timestamp() END
	 LEFT JOIN "moderation_review" review ON review."targetType" = 'ASSET' AND review."targetId" = asset."id"
	`;
	if (!row) return null;
	if (typeof row.phaseOwnerCurrent !== "boolean")
		throw new Error("INVALID_VERIFICATION_PHASE_PROJECTION");
	// Keep an expired/mismatched owner observable even if the asset lease also
	// disappeared. An asset WHERE predicate must not hide phase ownership loss.
	if (row.id === null)
		return row.phaseOwnerCurrent
			? null
			: {
					asset: null,
					phaseOwnerCurrent: false,
					hasAccountInputCopy: false,
					failureCount: 0,
					previousReview: null,
				};
	assertVerificationFacts(row);
	const {
		phaseOwnerCurrent,
		previousReviewId,
		previousLastErrorCode,
		previousLastFailureAt,
		hasAccountInputCopy,
		failureCount,
		...asset
	} = row;
	if (
		previousReviewId !== null &&
		(!previousReviewId ||
			typeof previousLastErrorCode !== "string" ||
			!(previousLastFailureAt instanceof Date))
	)
		throw new Error("INVALID_VERIFICATION_REVIEW_PROJECTION");
	return {
		asset: { ...asset, id: row.id },
		phaseOwnerCurrent,
		hasAccountInputCopy,
		failureCount,
		previousReview:
			previousReviewId === null
				? null
				: {
						id: previousReviewId,
						lastErrorCode: previousLastErrorCode!,
						lastFailureAt: previousLastFailureAt!,
					},
	};
}

function assertVerificationFacts(facts: VerificationFacts): void {
	if (
		!Number.isSafeInteger(facts.failureCount) ||
		facts.failureCount < 0 ||
		typeof facts.hasAccountInputCopy !== "boolean"
	)
		throw new Error("INVALID_VERIFICATION_PROJECTION");
}
