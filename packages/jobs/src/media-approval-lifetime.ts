import type { AssetModerationResult, MediaAsset } from "@repo/database/generated-client";

// A finite terminal timestamp represents no calendar expiry while preserving the
// existing non-null database evidence contract and short-lived signed URL gates.
export const IMAGE_APPROVAL_NO_TIME_EXPIRY = "9999-12-31T23:59:59.999Z";

type ApprovalAsset = Pick<
	MediaAsset,
	| "mimeType"
	| "status"
	| "deletedAt"
	| "finalizedAt"
	| "checksum"
	| "kind"
	| "verificationGeneration"
	| "verificationAttemptCount"
	| "verificationProvider"
	| "verificationProviderTaskId"
	| "verificationRuleVersion"
	| "verificationPolicyVersion"
	| "verificationValidUntil"
	| "verificationLeaseToken"
	| "verificationSubmissionUncertain"
>;
type ApprovalEvidence = Pick<
	AssetModerationResult,
	| "status"
	| "assetChecksum"
	| "evidenceKind"
	| "verificationGeneration"
	| "attemptNumber"
	| "provider"
	| "providerTaskId"
	| "ruleVersion"
	| "policyVersion"
	| "validUntil"
>;

export function canReuseApprovedImageEvidence(
	asset: ApprovalAsset,
	evidence: ApprovalEvidence | null,
	current: { provider: string; ruleVersion: string; policyVersion: string },
): boolean {
	// This compatibility is intentionally pinned: only the lifetime changed in .2.
	// A future classifier, provider, rule, or policy change must not inherit it.
	if (
		current.ruleVersion !== "media-safety-2026-09-08.1" ||
		current.policyVersion !== "media-policy-2026-09-08.2" ||
		!["media-policy-2026-09-08.1", "media-policy-2026-09-08.2"].includes(
			asset.verificationPolicyVersion ?? "",
		)
	)
		return false;

	return Boolean(
		["image/jpeg", "image/png", "image/webp"].includes(asset.mimeType) &&
		asset.status === "READY" &&
		asset.deletedAt === null &&
		asset.finalizedAt &&
		asset.checksum &&
		/^[a-f0-9]{64}$/i.test(asset.checksum) &&
		asset.verificationGeneration >= 1 &&
		asset.verificationAttemptCount >= 1 &&
		asset.verificationLeaseToken === null &&
		!asset.verificationSubmissionUncertain &&
		asset.verificationProvider === current.provider &&
		asset.verificationRuleVersion === current.ruleVersion &&
		asset.verificationValidUntil &&
		evidence?.status === "APPROVED" &&
		evidence.assetChecksum === asset.checksum &&
		evidence.evidenceKind === asset.kind &&
		evidence.verificationGeneration === asset.verificationGeneration &&
		evidence.attemptNumber === asset.verificationAttemptCount &&
		evidence.provider === asset.verificationProvider &&
		evidence.providerTaskId === asset.verificationProviderTaskId &&
		evidence.ruleVersion === asset.verificationRuleVersion &&
		evidence.policyVersion === asset.verificationPolicyVersion &&
		evidence.validUntil &&
		evidence.validUntil.getTime() === asset.verificationValidUntil.getTime(),
	);
}
