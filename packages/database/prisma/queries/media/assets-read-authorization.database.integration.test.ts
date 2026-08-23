import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { getOwnedMediaAssetReadState, listReadableMediaAssets } from "./assets";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("media asset read authorization database boundary", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl(TEST_DATABASE_URL) }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("hides expired READY claims and a newer non-approved attempt", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `asset-reader-${suffix}`;
		const assetId = `asset-readable-${suffix}`;
		const now = new Date();
		const validUntil = new Date(now.getTime() + 60 * 60_000);
		const verification = {
			provider: "sightengine",
			ruleVersion: "asset-rule-current",
			policyVersion: "asset-policy-current",
			now,
		};
		await client.mediaAsset.create({
			data: {
				id: assetId,
				ownerType: "USER",
				ownerId,
				kind: "INPUT",
				status: "VERIFYING",
				objectKey: `users/${ownerId}/assets/${assetId}/original.png`,
				mimeType: "image/png",
				byteSize: 1024n,
				checksum: "a".repeat(64),
				storageEtag: "etag-current",
				storageVersionId: "version-current",
				finalizedAt: new Date(now.getTime() - 60_000),
				verificationGeneration: 1,
				verificationAttemptCount: 1,
				verificationProvider: verification.provider,
				verificationProviderTaskId: "provider-task-1",
				verificationRuleVersion: verification.ruleVersion,
				verificationPolicyVersion: verification.policyVersion,
			},
		});
		await client.assetModerationResult.create({
			data: {
				assetId,
				assetChecksum: "a".repeat(64),
				verificationGeneration: 1,
				attemptNumber: 1,
				evidenceKind: "INPUT",
				provider: verification.provider,
				providerTaskId: "provider-task-1",
				ruleVersion: verification.ruleVersion,
				policyVersion: verification.policyVersion,
				status: "APPROVED",
				reasonCode: "ALLOW",
				categories: {},
				rawEnvelope: {},
				validUntil,
			},
		});
		await client.mediaAsset.update({
			where: { id: assetId },
			data: { status: "READY", verificationValidUntil: validUntil },
		});

		await expect(
			getOwnedMediaAssetReadState({ assetId, ownerId, verification }, client),
		).resolves.toMatchObject({ readable: true, asset: { id: assetId } });
		await expect(
			listReadableMediaAssets({ ownerType: "USER", ownerId, verification, take: 20 }, client),
		).resolves.toMatchObject({ items: [{ id: assetId }], hasMore: false });

		const expiredVerification = {
			...verification,
			now: new Date(validUntil.getTime() + 1),
		};
		await expect(
			getOwnedMediaAssetReadState({ assetId, ownerId, verification: expiredVerification }, client),
		).resolves.toMatchObject({ readable: false });
		await expect(
			listReadableMediaAssets(
				{ ownerType: "USER", ownerId, verification: expiredVerification, take: 20 },
				client,
			),
		).resolves.toEqual({ items: [], hasMore: false });

		const driftedVerification = { ...verification, policyVersion: "asset-policy-next" };
		await expect(
			getOwnedMediaAssetReadState({ assetId, ownerId, verification: driftedVerification }, client),
		).resolves.toMatchObject({ readable: false });
		await expect(
			listReadableMediaAssets(
				{ ownerType: "USER", ownerId, verification: driftedVerification, take: 20 },
				client,
			),
		).resolves.toEqual({ items: [], hasMore: false });
	});
});

function safeTestDatabaseUrl(value: string | undefined): string {
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
		!["55432", "55439", "55445"].includes(parsed.port) ||
		!/(^|[_-])(test|testing)([_-]|$)/.test(parsed.pathname.slice(1).toLowerCase())
	) {
		throw new Error("TEST_DATABASE_URL must target a disposable local test database");
	}
	return value;
}
