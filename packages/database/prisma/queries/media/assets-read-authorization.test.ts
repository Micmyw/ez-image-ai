import { describe, expect, it, vi } from "vitest";

import {
	hasCurrentApprovedMediaAssetEvidence,
	listReadableMediaAssets,
	type MediaAssetReadRecord,
} from "./assets";

const now = new Date("2026-08-24T00:00:00.000Z");
const validUntil = new Date("2026-08-24T01:00:00.000Z");
const verification = {
	provider: "sightengine",
	ruleVersion: "media-safety-2026-08-23.1",
	policyVersion: "media-policy-2026-08-23.1",
	now,
};

function readableAsset(id = "asset-readable"): MediaAssetReadRecord {
	return {
		id,
		ownerType: "USER",
		ownerId: "user-1",
		kind: "INPUT",
		status: "READY",
		retentionClass: "ACCOUNT",
		deleteAfter: null,
		watermarkVersion: null,
		watermarkedAt: null,
		cleanStagingDeletedAt: null,
		objectKey: `users/user-1/assets/${id}/original.png`,
		mimeType: "image/png",
		byteSize: 1024n,
		width: 100,
		height: 100,
		durationMillis: null,
		checksum: "a".repeat(64),
		storageEtag: "etag-1",
		storageVersionId: "version-1",
		finalizedAt: new Date("2026-08-23T23:00:00.000Z"),
		outputTransferToken: null,
		outputTransferLeaseExpiresAt: null,
		outputStagingObjectKey: null,
		outputPromotionMultipartUploadId: null,
		sourceUrl: null,
		verificationEngine: "legacy",
		videoCleanupCompletedAt: null,
		verificationGeneration: 2,
		verificationAttemptCount: 3,
		verificationProvider: verification.provider,
		verificationRuleVersion: verification.ruleVersion,
		verificationPolicyVersion: verification.policyVersion,
		verificationProviderTaskId: "provider-task-3",
		verificationLeaseToken: null,
		verificationLeasedUntil: null,
		verificationNextAttemptAt: null,
		verificationDeadlineAt: null,
		verificationExhaustedAt: null,
		verificationValidUntil: validUntil,
		verificationSubmissionToken: null,
		verificationSubmissionUncertain: false,
		verificationSubmittedAt: new Date("2026-08-23T23:59:00.000Z"),
		verificationLastErrorCode: null,
		createdAt: new Date("2026-08-23T23:00:00.000Z"),
		updatedAt: new Date("2026-08-23T23:59:00.000Z"),
		deletedAt: null,
		moderationResults: [
			{
				id: "evidence-3",
				assetId: id,
				assetChecksum: "a".repeat(64),
				verificationGeneration: 2,
				attemptNumber: 3,
				evidenceKind: "INPUT",
				provider: verification.provider,
				providerTaskId: "provider-task-3",
				ruleVersion: verification.ruleVersion,
				policyVersion: verification.policyVersion,
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil,
				createdAt: new Date("2026-08-23T23:59:00.000Z"),
			},
		],
		jobBindings: [{ jobId: "job-1" }],
	};
}

describe("media asset read authorization", () => {
	it.each(["sightengine", "seeapi+sightengine", "sightengine+seeapi"])(
		"preserves complete historical %s approval after retirement without rewriting it",
		(provider) => {
			const asset = readableAsset();
			asset.verificationProvider = provider;
			asset.moderationResults[0]!.provider = provider;
			const before = structuredClone(asset);
			expect(
				hasCurrentApprovedMediaAssetEvidence(asset, { ...verification, provider: "seeapi" }),
			).toBe(true);
			expect(asset).toEqual(before);
		},
	);
	it("does not turn incomplete, stale, mismatched, bypassed or video history into image approval", () => {
		const asset = readableAsset();
		const evidence = asset.moderationResults[0]!;
		const invalid = [
			{ ...asset, status: "VERIFYING" as const },
			{ ...asset, status: "QUARANTINED" as const },
			{ ...asset, verificationEngine: "video-workflow-v1" },
			{ ...asset, mimeType: "video/mp4" },
			{ ...asset, verificationValidUntil: now },
			{ ...asset, verificationRuleVersion: "different" },
			{ ...asset, verificationPolicyVersion: "different" },
			{ ...asset, moderationResults: [] },
			{
				...asset,
				moderationResults: [
					{
						...evidence,
						status: "BYPASSED" as const,
						reasonCode: "MODERATION_TECHNICAL_FAILURE_BYPASS",
					},
				],
			},
			{ ...asset, moderationResults: [{ ...evidence, verificationGeneration: 1 }] },
			{ ...asset, moderationResults: [{ ...evidence, provider: "seeapi" }] },
			{ ...asset, moderationResults: [{ ...evidence, assetChecksum: "b".repeat(64) }] },
		];
		for (const value of invalid)
			expect(
				hasCurrentApprovedMediaAssetEvidence(value, { ...verification, provider: "seeapi" }),
			).toBe(false);
	});
	it("includes historical approvals in candidate listing and validates their evidence before returning", async () => {
		const asset = readableAsset();
		const findMany = vi.fn().mockResolvedValueOnce([asset]);
		const result = await listReadableMediaAssets(
			{
				ownerType: "USER",
				ownerId: "user-1",
				take: 5,
				verification: { ...verification, provider: "seeapi" },
			},
			{ mediaAsset: { findMany } } as never,
		);
		expect(result.items).toEqual([asset]);
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					verificationProvider: {
						in: ["seeapi", "sightengine", "seeapi+sightengine", "sightengine+seeapi"],
					},
				}),
			}),
		);
	});
	it("requires an unexpired READY claim and the latest exact APPROVED evidence", () => {
		const valid = readableAsset();
		expect(hasCurrentApprovedMediaAssetEvidence(valid, verification)).toBe(true);

		const evidence = valid.moderationResults[0]!;
		const invalid: Parameters<typeof hasCurrentApprovedMediaAssetEvidence>[0][] = [
			{ ...valid, verificationValidUntil: null },
			{ ...valid, verificationValidUntil: now },
			{ ...valid, verificationProvider: "legacy-provider" },
			{ ...valid, verificationRuleVersion: "legacy-rule" },
			{ ...valid, verificationPolicyVersion: "legacy-policy" },
			{ ...valid, checksum: null },
			{ ...valid, moderationResults: [] },
			{
				...valid,
				moderationResults: [{ ...evidence, status: "REJECTED" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, assetChecksum: "b".repeat(64) }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, verificationGeneration: 1 }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, attemptNumber: 2 }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, evidenceKind: "OUTPUT" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, providerTaskId: "provider-task-old" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, provider: "legacy-provider" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, ruleVersion: "legacy-rule" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, policyVersion: "legacy-policy" }],
			},
			{
				...valid,
				moderationResults: [{ ...evidence, validUntil: new Date(validUntil.getTime() + 1) }],
			},
		];

		for (const asset of invalid) {
			expect(hasCurrentApprovedMediaAssetEvidence(asset, verification)).toBe(false);
		}
	});

	it("filters invalid READY rows and continues scanning for readable assets", async () => {
		const invalid = {
			...readableAsset("asset-invalid"),
			moderationResults: [],
		};
		const valid = readableAsset();
		const findMany = vi.fn().mockResolvedValueOnce([invalid, valid]).mockResolvedValueOnce([]);
		const client = { mediaAsset: { findMany } };

		const result = await listReadableMediaAssets(
			{
				ownerType: "USER",
				ownerId: "user-1",
				take: 1,
				mimeTypePrefix: "image/",
				verification,
			},
			client as never,
		);

		expect(result).toEqual({ items: [valid], hasMore: false });
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "READY",
					verificationProvider: verification.provider,
					verificationRuleVersion: verification.ruleVersion,
					verificationPolicyVersion: verification.policyVersion,
					verificationValidUntil: { gt: now },
				}),
			}),
		);
	});
});
