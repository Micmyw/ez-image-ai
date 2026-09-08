import { describe, expect, it } from "vitest";

import { canReuseApprovedImageEvidence } from "./media-approval-lifetime";

const current = {
	provider: "sightengine",
	ruleVersion: "media-safety-2026-09-08.1",
	policyVersion: "media-policy-2026-09-08.2",
};
const asset: Parameters<typeof canReuseApprovedImageEvidence>[0] = {
	mimeType: "image/png",
	kind: "INPUT",
	status: "READY",
	deletedAt: null,
	finalizedAt: new Date("2026-09-01"),
	checksum: "a".repeat(64),
	verificationGeneration: 1,
	verificationAttemptCount: 2,
	verificationProvider: "sightengine",
	verificationProviderTaskId: null,
	verificationRuleVersion: current.ruleVersion,
	verificationPolicyVersion: "media-policy-2026-09-08.1",
	verificationValidUntil: new Date("2026-09-02"),
	verificationLeaseToken: null,
	verificationSubmissionUncertain: false,
};
const evidence: NonNullable<Parameters<typeof canReuseApprovedImageEvidence>[1]> = {
	status: "APPROVED",
	assetChecksum: asset.checksum,
	evidenceKind: "INPUT",
	verificationGeneration: 1,
	attemptNumber: 2,
	provider: "sightengine",
	providerTaskId: null,
	ruleVersion: current.ruleVersion,
	policyVersion: "media-policy-2026-09-08.1",
	validUntil: asset.verificationValidUntil,
};

describe("reuse of unchanged image approvals", () => {
	it.each(["INPUT", "OUTPUT"] as const)(
		"reuses the exact %s evidence independently of its old calendar expiry",
		(kind) => {
			expect(
				canReuseApprovedImageEvidence(
					{ ...asset, kind },
					{ ...evidence, evidenceKind: kind },
					current,
				),
			).toBe(true);
		},
	);

	it.each([
		{ status: "QUARANTINED" },
		{ status: "VERIFYING" },
		{ deletedAt: new Date() },
		{ finalizedAt: null },
		{ checksum: null },
		{ checksum: "b".repeat(64) },
		{ mimeType: "video/mp4" },
		{ verificationLeaseToken: "active-lease" },
		{ verificationSubmissionUncertain: true },
		{ verificationGeneration: 2 },
		{ verificationAttemptCount: 3 },
		{ verificationProvider: "other-provider" },
		{ verificationProviderTaskId: "different-task" },
		{ verificationRuleVersion: "old-rule" },
		{ verificationPolicyVersion: "media-policy-2026-08-23.1" },
		{ verificationValidUntil: null },
	] satisfies Array<Partial<typeof asset>>)(
		"requires the original intact private image claim: %o",
		(change) => {
			expect(canReuseApprovedImageEvidence({ ...asset, ...change }, evidence, current)).toBe(false);
		},
	);

	it.each([
		{ status: "REJECTED" },
		{ status: "REVIEW" },
		{ status: "ERROR" },
		{ assetChecksum: "b".repeat(64) },
		{ evidenceKind: "OUTPUT" },
		{ verificationGeneration: 2 },
		{ attemptNumber: 1 },
		{ provider: "other-provider" },
		{ providerTaskId: "other-task" },
		{ ruleVersion: "old-rule" },
		{ policyVersion: "other-policy" },
		{ validUntil: null },
		{ validUntil: new Date("2026-09-03") },
	] satisfies Array<Partial<typeof evidence>>)(
		"never treats mismatched or unapproved evidence as reusable: %o",
		(change) => {
			expect(canReuseApprovedImageEvidence(asset, { ...evidence, ...change }, current)).toBe(false);
		},
	);

	it("requires an existing approved record", () => {
		expect(canReuseApprovedImageEvidence(asset, null, current)).toBe(false);
	});

	it.each([
		{ provider: "other-provider" },
		{ ruleVersion: "media-safety-next" },
		{ policyVersion: "media-policy-2026-09-08.3" },
	])("does not silently reuse approvals after a future policy or provider change: %o", (change) => {
		expect(canReuseApprovedImageEvidence(asset, evidence, { ...current, ...change })).toBe(false);
	});
});
