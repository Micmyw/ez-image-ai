import {
	assertTemporaryReferenceUsable,
	TEMPORARY_REFERENCE_RESERVATION_PREFIX,
	temporaryReferenceObjectKey,
	type TemporaryReference,
} from "@repo/config";

import type { MediaDatabaseClient } from "./types";

interface TemporaryReferenceStatusRow {
	status: "NOT_STARTED" | "PENDING" | "APPROVED" | "UNAVAILABLE";
	moderationStatus: string | null;
	reasonCode: string | null;
}

/** Read-only presentation state; Generate still authorizes the current immutable evidence. */
export async function getTemporaryReferenceStatus(
	input: {
		ownerId: string;
		reference: TemporaryReference;
		verification: { provider: string | null; ruleVersion: string; policyVersion: string };
		now?: Date;
	},
	client: MediaDatabaseClient,
): Promise<TemporaryReferenceStatusRow | null> {
	const { reference, verification } = input;
	assertTemporaryReferenceUsable(reference, input.ownerId, reference.assetId, input.now);
	// One bounded read also handles a valid pure upload with no speculative review.
	// The committed reservation, immutable object and expiry stay bound to the signed receipt.
	const [row] = await client.$queryRaw<TemporaryReferenceStatusRow[]>`
		SELECT CASE
			WHEN asset."id" IS NULL THEN 'NOT_STARTED'
			WHEN asset."status" IN ('UPLOADING', 'VERIFYING') THEN 'PENDING'
			WHEN asset."status" = 'READY'
				AND asset."verificationAttemptCount" >= 1
				AND asset."verificationProvider" = ${verification.provider}
				AND asset."verificationRuleVersion" = ${verification.ruleVersion}
				AND asset."verificationPolicyVersion" = ${verification.policyVersion}
				AND asset."verificationValidUntil" > clock_timestamp()
				AND evidence."status" = 'APPROVED'
				AND evidence."validUntil" = asset."verificationValidUntil"
				THEN 'APPROVED'
			ELSE 'UNAVAILABLE' END AS "status",
			evidence."status"::text AS "moderationStatus", evidence."reasonCode"
		FROM "storage_usage_reservation" reservation
		LEFT JOIN "media_asset" asset ON asset."id" = ${reference.assetId}
		LEFT JOIN "asset_moderation_result" evidence ON evidence."assetId" = asset."id"
			AND evidence."verificationGeneration" = asset."verificationGeneration"
			AND evidence."attemptNumber" = asset."verificationAttemptCount"
			AND evidence."assetChecksum" = asset."checksum"
			AND evidence."evidenceKind" = 'INPUT'
			AND evidence."provider" = asset."verificationProvider"
			AND evidence."providerTaskId" IS NOT DISTINCT FROM asset."verificationProviderTaskId"
			AND evidence."ruleVersion" = asset."verificationRuleVersion"
			AND evidence."policyVersion" = asset."verificationPolicyVersion"
		WHERE reservation."referenceKey" = ${`${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}`}
			AND reservation."ownerType" = 'USER' AND reservation."ownerId" = ${input.ownerId}
			AND reservation."status" = 'COMMITTED' AND reservation."bytes" = ${BigInt(reference.bytes)}
			AND reservation."expiresAt" = ${new Date(reference.expiresAt)}
			AND reservation."expiresAt" > clock_timestamp()
			AND (asset."id" IS NULL OR (
				asset."ownerType" = 'USER' AND asset."ownerId" = ${input.ownerId}
				AND asset."kind" = 'INPUT' AND asset."retentionClass" = 'ACCOUNT'
				AND asset."objectKey" = ${temporaryReferenceObjectKey(reference)}
				AND asset."checksum" = ${reference.checksum}
				AND asset."byteSize" = ${BigInt(reference.bytes)}
				AND asset."mimeType" = ${reference.contentType}
				AND asset."finalizedAt" IS NOT NULL
				AND asset."deleteAfter" = ${new Date(reference.expiresAt)}
				AND asset."deletedAt" IS NULL AND asset."status" <> 'DELETED'
				AND asset."verificationEngine" = 'legacy' AND asset."verificationGeneration" >= 1
			))
		LIMIT 1
	`;
	return row ?? null;
}
