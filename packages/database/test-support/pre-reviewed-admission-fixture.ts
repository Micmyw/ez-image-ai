import { createHash } from "node:crypto";

import {
	TEMPORARY_REFERENCE_RESERVATION_PREFIX,
	temporaryReferenceObjectKey,
	type TemporaryReference,
} from "@repo/config";

import type { PrismaClient } from "../prisma/generated/client";
import { createCreditGrant } from "../prisma/queries/media/credits";
import { fingerprintGenerationQuoteSecurityPayload } from "../prisma/queries/media/quotes";
import type {
	CreateGenerationJobInput,
	CreateModeratedGenerationQuoteInput,
} from "../prisma/queries/media/types";

/** Matching completed or explicitly pending review state; no provider or clock mocks. */
export async function createPreReviewedAdmissionFixture(
	client: PrismaClient,
	options: {
		amount?: bigint;
		creditExpiresAt?: Date;
		prefix?: string;
		reviewStatus?: "PENDING" | "NOT_STARTED";
	} = {},
) {
	const ownerId = `${options.prefix ?? "pre-reviewed-admission"}-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	const grantReferenceKey = `${ownerId}:grant`;
	await createCreditGrant(
		{
			accountId: account.id,
			amount: options.amount ?? 100n,
			referenceKey: grantReferenceKey,
			expiresAt: options.creditExpiresAt,
		},
		client,
	);
	const now = new Date();
	const reference: TemporaryReference = {
		v: 1,
		ownerId,
		assetId: crypto.randomUUID(),
		contentType: "image/png",
		bytes: 1000,
		checksum: "b".repeat(64),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
	};
	await client.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId,
			bytes: BigInt(reference.bytes),
			status: "COMMITTED",
			referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}`,
			expiresAt: new Date(reference.expiresAt),
		},
	});
	const validUntil = new Date(now.getTime() + 60_000);
	const pending = options.reviewStatus !== undefined;
	const notStarted = options.reviewStatus === "NOT_STARTED";
	const asset = await client.mediaAsset.create({
		data: {
			id: reference.assetId,
			ownerType: "USER",
			ownerId,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "ACCOUNT",
			objectKey: temporaryReferenceObjectKey(reference),
			mimeType: reference.contentType,
			byteSize: BigInt(reference.bytes),
			checksum: reference.checksum,
			finalizedAt: now,
			deleteAfter: new Date(reference.expiresAt),
			verificationEngine: "legacy",
			verificationGeneration: 1,
			verificationAttemptCount: notStarted ? 0 : 1,
			verificationProvider: "seeapi",
			verificationProviderTaskId: notStarted ? null : `${reference.assetId}:review`,
			...(pending
				? {
						verificationSubmissionToken: notStarted ? null : crypto.randomUUID(),
						verificationSubmittedAt: notStarted ? null : now,
						verificationDeadlineAt: new Date(now.getTime() + 120_000),
						verificationNextAttemptAt: notStarted ? null : new Date(now.getTime() + 1000),
						verificationLastErrorCode: notStarted ? null : "IMAGE_PROCESSING",
					}
				: {}),
			verificationRuleVersion: "test-asset-rule",
			verificationPolicyVersion: "test-asset-policy",
			verificationValidUntil: pending ? null : validUntil,
		},
	});
	if (!notStarted)
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: reference.checksum,
				verificationGeneration: asset.verificationGeneration,
				attemptNumber: asset.verificationAttemptCount,
				evidenceKind: "INPUT",
				provider: asset.verificationProvider!,
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: asset.verificationRuleVersion!,
				policyVersion: asset.verificationPolicyVersion!,
				status: pending ? "PENDING" : "APPROVED",
				reasonCode: pending ? "IMAGE_PROCESSING" : "NO_POLICY_MATCH",
				categories: {},
				rawEnvelope: { decision: pending ? "PENDING" : "ALLOW" },
				validUntil: pending ? null : validUntil,
			},
		});
	const reviewedAsset = pending
		? asset
		: await client.mediaAsset.update({
				where: { id: asset.id },
				data: { status: "READY" },
			});
	const reviewEvent = pending
		? await client.outboxEvent.create({
				data: {
					eventType: "MEDIA_ASSET_VERIFY",
					aggregateType: "MEDIA_ASSET",
					aggregateId: asset.id,
					dedupeKey: notStarted
						? `temporary-reference-verify:${asset.id}:g1`
						: `media-asset-verify:${asset.id}:g1:poll`,
					payload: { assetId: asset.id },
				},
			})
		: null;
	const quoteId = `submit_${crypto.randomUUID()}`;
	function prepare(suffix = ""): CreateModeratedGenerationQuoteInput {
		const prompt = "A fixed simulated mountain landscape";
		const quote = {
			quoteId: `${quoteId}${suffix}`,
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 5n,
			costMicros: 100n,
			inputSnapshot: {
				kind: "image-to-image",
				prompt,
				submissionFingerprint: createHash("sha256").update(prompt).digest("hex"),
				sourceAssetId: reference.assetId,
				editContext: { kind: "ROOT", rootAssetId: reference.assetId },
				temporaryReference: reference,
			},
			pricingSnapshot: { fundingSource: "CREDITS" },
			expiresAt: new Date(Date.now() + 60_000),
		};
		const observedAt = new Date().toISOString();
		return {
			...quote,
			moderation: {
				decision: "ALLOW",
				provider: "waffo",
				ruleVersion: "test-rule",
				reasonCode: "NO_POLICY_MATCH",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
				retry: { failures: 0, lastErrorCode: "", startedAt: observedAt, lastFailureAt: observedAt },
			},
		};
	}
	function input(preparedQuote = prepare()): CreateGenerationJobInput {
		return {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: preparedQuote.quoteId!,
			idempotencyKey: `${ownerId}:${preparedQuote.quoteId}`,
			preparedQuote,
			inputAssetIds: [reference.assetId],
			expectedInputAssets: [{ assetId: reference.assetId, assetChecksum: reference.checksum }],
			edit: { kind: "ROOT", rootAssetId: reference.assetId },
			expectedModerationRuleVersion: "test-rule",
			expectedModerationProvider: "waffo",
			expectedAssetModerationRuleVersion: "test-asset-rule",
			expectedAssetModerationPolicyVersion: "test-asset-policy",
			maximumDailyCostMicros: 1000n,
			maximumStorageBytes: 10_000_000_000n,
			validateCurrentEligibility: true,
		};
	}
	return {
		ownerId,
		account,
		grantReferenceKey,
		reference,
		asset: reviewedAsset,
		reviewEvent,
		quoteId,
		prepare,
		input,
	};
}
