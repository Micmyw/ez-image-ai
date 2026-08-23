import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai/media";
import { db } from "@repo/database/client";
import { schedules, tasks } from "@trigger.dev/sdk";

import { recoverMediaVerifications } from "../src/handlers/recover-media-verifications";

export const recoverMediaVerificationsTask = schedules.task({
	id: "media-recover-verifications",
	cron: "* * * * *",
	queue: { name: "media-verification-recovery", concurrencyLimit: 1 },
	maxDuration: 120,
	run: () =>
		recoverMediaVerifications(
			{ limit: 25 },
			{
				listCandidates: async ({ limit, now }) => {
					const moderationProvider = process.env.MEDIA_SAFETY_ADAPTER ?? "test";
					const assets = await db.mediaAsset.findMany({
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
										{
											verificationLeaseToken: { not: null },
											verificationLeasedUntil: null,
										},
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
								{
									status: "QUARANTINED",
									verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
								},
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
				},
				trigger: (candidate) =>
					tasks.trigger("media-verify-upload", candidate).then(() => undefined),
			},
		),
});
