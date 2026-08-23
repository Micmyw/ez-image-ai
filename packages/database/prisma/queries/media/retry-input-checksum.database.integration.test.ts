import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("retry input checksum binding", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("rejects retry creation when the current asset bytes differ from the source binding", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `retry-checksum-owner-${suffix}`;
		const currentChecksum = "a".repeat(64);
		const originalChecksum = "b".repeat(64);
		const validUntil = new Date(Date.now() + 60 * 60_000);
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId },
		});
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				referenceKey: `retry-checksum-grant-${suffix}`,
			},
			client,
		);
		const asset = await client.mediaAsset.create({
			data: {
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/${ownerId}/assets/${suffix}/original.png`,
				mimeType: "image/png",
				byteSize: 16n,
				checksum: currentChecksum,
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: "test",
				verificationRuleVersion: "asset-rule-v1",
				verificationPolicyVersion: "asset-policy-v1",
				verificationValidUntil: validUntil,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId: asset.id,
				assetChecksum: currentChecksum,
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: "test",
				ruleVersion: "asset-rule-v1",
				policyVersion: "asset-policy-v1",
				status: "APPROVED",
				reasonCode: "TEST_ALLOW",
				categories: {},
				rawEnvelope: { decision: "ALLOW" },
				validUntil,
			},
		});
		await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-fast",
			catalogVersion: "2026-08-13.1",
			pricingVersion: "2026-08-13.1",
			credits: 4n,
			costMicros: 3_000n,
			inputSnapshot: { kind: "image-to-image", prompt: "preserve the original bytes" },
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
					idempotencyKey: `retry-checksum-job-${suffix}`,
					inputAssetIds: [asset.id],
					expectedInputAssets: [{ assetId: asset.id, assetChecksum: originalChecksum }],
					expectedModerationRuleVersion: "text-rule-v1",
					expectedAssetModerationRuleVersion: "asset-rule-v1",
					expectedAssetModerationPolicyVersion: "asset-policy-v1",
				},
				client,
			),
		).rejects.toThrow("ASSET_CONTENT_CHANGED");
		expect(
			await client.generationJob.count({
				where: { ownerType: "USER", ownerId, idempotencyKey: `retry-checksum-job-${suffix}` },
			}),
		).toBe(0);
	});
});

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		!["55432", "55439"].includes(parsed.port) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target a disposable local test database");
	}
	return value;
}
