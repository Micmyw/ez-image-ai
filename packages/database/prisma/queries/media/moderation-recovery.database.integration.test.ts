import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { recordAssetModeration } from "./assets";
import { createCreditGrant } from "./credits";
import { createGenerationDraftTransaction } from "./drafts";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("media verification evidence invariants", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("rejects a READY asset that has no checksum-bound approved evidence", async () => {
		const suffix = crypto.randomUUID();

		await expect(
			client.mediaAsset.create({
				data: {
					ownerType: "USER",
					ownerId: `moderation-owner-${suffix}`,
					kind: "INPUT",
					status: "READY",
					objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/original.png`,
					mimeType: "image/png",
					byteSize: 16n,
				},
			}),
		).rejects.toThrow(/approved moderation evidence/i);
	});

	it("rejects READY when a later moderation attempt supersedes an approval", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "a".repeat(64);
		const validUntil = new Date(Date.now() + 60_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 2,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.createMany({
			data: [
				{
					assetId: asset.id,
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "test",
					ruleVersion: "asset-rule-v1",
					policyVersion: "policy-v1",
					status: "APPROVED",
					validUntil,
					reasonCode: "TEST_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
				},
				{
					assetId: asset.id,
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 2,
					evidenceKind: "INPUT",
					provider: "test",
					ruleVersion: "asset-rule-v1",
					policyVersion: "policy-v1",
					status: "ERROR",
					reasonCode: "TEST_ERROR",
					categories: {},
					rawEnvelope: { decision: "ERROR" },
				},
			],
		});

		await expect(
			client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } }),
		).rejects.toThrow(/latest approved moderation evidence/i);
	});

	it("rejects READY when video evidence belongs to another provider task", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "b".repeat(64);
		const validUntil = new Date(Date.now() + 60_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/original.mp4`,
				mimeType: "video/mp4",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationProviderTaskId: "task-current",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				providerTaskId: "task-stale",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
			},
		});

		await expect(
			client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } }),
		).rejects.toThrow(/latest approved moderation evidence/i);
	});

	it("prevents ready asset content identity from changing without reverification", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "c".repeat(64);
		const validUntil = new Date(Date.now() + 60_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });

		await expect(
			client.mediaAsset.update({
				where: { id: asset.id },
				data: { objectKey: `${asset.objectKey}.replacement` },
			}),
		).rejects.toThrow(/content identity is immutable/i);
	});

	it("rejects READY when the latest approved evidence has expired", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "d".repeat(64);
		const createdAt = new Date(Date.now() - 120_000);
		const validUntil = new Date(createdAt.getTime() + 60_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/expired.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				createdAt,
			},
		});

		await expect(
			client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } }),
		).rejects.toThrow(/latest approved moderation evidence/i);
	});

	it("allows diagnostic evidence without a checksum but rejects incomplete approvals", async () => {
		const suffix = crypto.randomUUID();
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/diagnostic.png`,
				mimeType: "image/png",
				byteSize: 16n,
				verificationGeneration: 1,
				verificationAttemptCount: 2,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
			},
		});

		await expect(
			client.assetModerationResult.create({
				data: {
					assetId: asset.id,
					assetChecksum: null,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "test",
					ruleVersion: "asset-rule-v1",
					policyVersion: "policy-v1",
					status: "ERROR",
					validUntil: null,
					reasonCode: "TEST_ERROR",
					categories: {},
					rawEnvelope: { decision: "ERROR" },
				},
			}),
		).resolves.toMatchObject({ assetChecksum: null, validUntil: null, status: "ERROR" });

		await expect(
			client.assetModerationResult.create({
				data: {
					assetId: asset.id,
					assetChecksum: null,
					verificationGeneration: 1,
					attemptNumber: 2,
					evidenceKind: "INPUT",
					provider: "test",
					ruleVersion: "asset-rule-v1",
					policyVersion: "policy-v1",
					status: "APPROVED",
					validUntil: null,
					reasonCode: "TEST_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
				},
			}),
		).rejects.toThrow();
	});

	it("keeps repeated moderation decisions as append-only evidence", async () => {
		const suffix = crypto.randomUUID();
		const checksum = "e".repeat(64);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
			},
		});

		await recordAssetModeration(
			{
				assetId: asset.id,
				provider: "test",
				status: "ERROR",
				rawEnvelope: { decision: "ERROR", attempt: 1 },
			},
			client,
		);
		await recordAssetModeration(
			{
				assetId: asset.id,
				provider: "test",
				status: "APPROVED",
				validUntil: new Date(Date.now() + 60_000),
				rawEnvelope: { decision: "ALLOW", attempt: 2 },
			},
			client,
		);

		await expect(
			client.assetModerationResult.count({ where: { assetId: asset.id } }),
		).resolves.toBe(2);
	});

	it("appends concurrent moderation diagnostics with distinct attempt numbers", async () => {
		const suffix = crypto.randomUUID();
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId: `moderation-owner-${suffix}`,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/moderation-owner-${suffix}/assets/${suffix}/concurrent.png`,
				mimeType: "image/png",
				byteSize: 16n,
				verificationGeneration: 1,
			},
		});

		await expect(
			Promise.all(
				["FIRST_ERROR", "SECOND_ERROR"].map((reasonCode) =>
					recordAssetModeration(
						{
							assetId: asset.id,
							provider: "test",
							status: "ERROR",
							categories: { reasonCode },
							rawEnvelope: { decision: "ERROR", reasonCode },
						},
						client,
					),
				),
			),
		).resolves.toHaveLength(2);

		await expect(
			client.assetModerationResult.findMany({
				where: { assetId: asset.id },
				select: { attemptNumber: true, assetChecksum: true },
				orderBy: { attemptNumber: "asc" },
			}),
		).resolves.toEqual([
			{ attemptNumber: 1, assetChecksum: null },
			{ attemptNumber: 2, assetChecksum: null },
		]);
	});

	it("binds an input job to the exact checksum authorized by moderation", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `moderation-owner-${suffix}`;
		const checksum = "a".repeat(64);
		const validUntil = new Date(Date.now() + 60_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
			},
		});
		await client.mediaAsset.update({
			where: { id: asset.id },
			data: { status: "READY" },
		});
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				referenceKey: `moderation-grant-${suffix}`,
			},
			client,
		);
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: 4n,
			costMicros: 100n,
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "make it brighter",
				sourceAssetId: asset.id,
			},
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: "text-rule-v1",
					reasonCode: "TEST_ALLOW",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);
		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: `moderation-job-${suffix}`,
					inputAssetIds: [asset.id],
					expectedModerationRuleVersion: "text-rule-v1",
					expectedAssetModerationRuleVersion: "asset-rule-v2",
					expectedAssetModerationPolicyVersion: "policy-v2",
				},
				client,
			),
		).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");

		const created = await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `moderation-job-${suffix}`,
				inputAssetIds: [asset.id],
				expectedModerationRuleVersion: "text-rule-v1",
				expectedAssetModerationRuleVersion: "asset-rule-v1",
				expectedAssetModerationPolicyVersion: "policy-v1",
			},
			client,
		);

		await expect(
			client.generationJobAsset.findFirstOrThrow({
				where: { jobId: created.job.id, assetId: asset.id },
				select: { assetChecksum: true },
			}),
		).resolves.toEqual({ assetChecksum: checksum });
	});

	it("rejects job creation after otherwise matching asset evidence expires", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `moderation-expiry-owner-${suffix}`;
		const checksum = "f".repeat(64);
		const validUntil = new Date(Date.now() + 1_000);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/${ownerId}/assets/${suffix}/expiring.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: checksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "policy-v1",
				status: "APPROVED",
				validUntil,
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				referenceKey: `moderation-expiry-grant-${suffix}`,
			},
			client,
		);
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "catalog-v1",
			pricingVersion: "pricing-v1",
			credits: 4n,
			costMicros: 100n,
			inputSnapshot: { kind: "image-to-image", prompt: "expired evidence" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: "text-rule-v1",
					reasonCode: "TEST_ALLOW",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, validUntil.getTime() - Date.now() + 50)),
		);

		await expect(
			createGenerationJobTransaction(
				{
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					quoteId: quote.id,
					idempotencyKey: `moderation-expiry-job-${suffix}`,
					inputAssetIds: [asset.id],
					expectedModerationRuleVersion: "text-rule-v1",
					expectedAssetModerationRuleVersion: "asset-rule-v1",
					expectedAssetModerationPolicyVersion: "policy-v1",
				},
				client,
			),
		).rejects.toThrow("ASSET_MODERATION_EVIDENCE_STALE");
		await expect(
			client.generationJob.count({
				where: { ownerType: "USER", ownerId, idempotencyKey: `moderation-expiry-job-${suffix}` },
			}),
		).resolves.toBe(0);
	});

	it("persists the SHA-256 already computed for an anonymous draft upload", async () => {
		const suffix = crypto.randomUUID();
		const assetId = `draft_asset_${suffix.replaceAll("-", "")}`;
		const checksum = "d".repeat(64);

		await createGenerationDraftTransaction(
			{
				claimTokenHash: suffix.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
				productKey: "image-fast",
				input: { kind: "image-to-image", prompt: "draft" },
				expiresAt: new Date(Date.now() + 60_000),
				asset: {
					id: assetId,
					objectKey: `drafts/${suffix}.png`,
					mimeType: "image/png",
					byteSize: 16n,
					checksum,
					finalizedAt: new Date(),
				},
			},
			client,
		);

		await expect(
			client.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
		).resolves.toMatchObject({
			status: "VERIFYING",
			checksum,
			finalizedAt: expect.any(Date),
		});
	});
});

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error("TEST_DATABASE_URL must target the disposable local media test database");
	}
	return value;
}
