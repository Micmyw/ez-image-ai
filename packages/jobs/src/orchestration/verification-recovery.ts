import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai/media";
import type { db } from "@repo/database/client";

import type { RecoverMediaVerificationCandidate } from "../handlers/recover-media-verifications";

/** Preserve the canonical stale, expired-policy, and explicit legacy-reverification scopes. */
export async function listVerificationRecoveryCandidates(
	database: Pick<typeof db, "mediaAsset">,
	input: { limit: number; now: Date },
	environment: Record<string, string | undefined>,
): Promise<RecoverMediaVerificationCandidate[]> {
	const moderationProvider = environment.MEDIA_SAFETY_ADAPTER ?? "test";
	const { now, limit } = input;
	const assets = await database.mediaAsset.findMany({
		where: {
			deletedAt: null,
			OR: [
				{
					status: "VERIFYING",
					OR: [
						{
							verificationLeaseToken: null,
							OR: [
								{ verificationNextAttemptAt: null },
								{ verificationNextAttemptAt: { lte: now } },
							],
						},
						{ verificationLeasedUntil: { lte: now } },
						{ verificationLeaseToken: { not: null }, verificationLeasedUntil: null },
					],
				},
				{
					status: "READY",
					OR: [
						{ verificationValidUntil: { lte: now } },
						{ verificationProvider: { not: moderationProvider } },
						{ verificationRuleVersion: { not: MEDIA_VERIFICATION_RULE_VERSION } },
						{ verificationPolicyVersion: { not: MEDIA_VERIFICATION_POLICY_VERSION } },
					],
				},
				{ status: "QUARANTINED", verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED" },
			],
		},
		orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
		take: limit,
		select: { id: true, status: true, verificationLastErrorCode: true },
	});
	return assets.map((asset) => ({
		assetId: asset.id,
		allowQuarantinedReverification:
			asset.status === "QUARANTINED" &&
			asset.verificationLastErrorCode === "LEGACY_EVIDENCE_UNTRUSTED",
	}));
}
