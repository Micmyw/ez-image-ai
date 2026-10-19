import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import {
	claimAccountInputCopy,
	commitAccountInputCopy,
	parseAccountInputCopyIntent,
} from "./account-input-copy";
import {
	getClaimedGenerationDraft,
	transferGuestGenerationDraftToRegisteredUserInTransaction,
} from "./drafts";
import { lockGuestOwnerPromotion } from "./guest-admission";
import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

let db: PrismaClient;
beforeAll(async () => {
	const value = process.env.TEST_DATABASE_URL;
	if (!value || value === process.env.DATABASE_URL) throw new Error("UNSAFE_TEST_DATABASE");
	const url = new URL(value);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname))
		throw new Error("UNSAFE_TEST_DATABASE");
	db = new PrismaClient({ adapter: new PrismaPg({ connectionString: value }) });
	await db.$connect();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => db?.$disconnect());

async function fixture() {
	const id = randomUUID();
	const guest = `retention-guest-${id}`,
		account = `retention-account-${id}`;
	const expiresAt = new Date(Date.now() + 60_000);
	await db.user.createMany({
		data: [guest, account].map((ownerId) => ({
			id: ownerId,
			name: "Retention test",
			email: `${ownerId}@test.invalid`,
			isAnonymous: ownerId === guest,
			emailVerified: ownerId === account,
			createdAt: new Date(),
			updatedAt: new Date(),
		})),
	});
	const asset = await db.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			kind: "INPUT",
			status: "VERIFYING",
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expiresAt,
			objectKey: `users/${guest}/assets/${id}/input.png`,
			mimeType: "image/png",
			byteSize: 10n,
			checksum: "a".repeat(64),
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationProviderTaskId: `retention-moderation-${id}`,
			verificationRuleVersion: "retention-test-rule",
			verificationPolicyVersion: "retention-test-policy",
			verificationValidUntil: expiresAt,
		},
	});
	// Respect the same approval invariant enforced for production READY assets.
	await db.assetModerationResult.create({
		data: {
			assetId: asset.id,
			assetChecksum: asset.checksum!,
			verificationGeneration: 1,
			attemptNumber: 1,
			evidenceKind: "INPUT",
			provider: "test",
			providerTaskId: `retention-moderation-${id}`,
			ruleVersion: "retention-test-rule",
			policyVersion: "retention-test-policy",
			status: "APPROVED",
			reasonCode: "ALLOW",
			categories: {},
			rawEnvelope: {},
			validUntil: expiresAt,
		},
	});
	await db.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });

	const draft = await db.generationDraft.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			submittedByUserId: guest,
			status: "SUBMITTED",
			claimTokenHash: randomUUID(),
			assetId: asset.id,
			productKey: "image-nano-banana-2-lite",
			inputSnapshot: {
				kind: "image-to-image",
				prompt: "Keep subject",
				skuKey: "nano-banana-2-lite-1k",
				aspectRatio: "auto",
			},
			expiresAt,
		},
	});
	await db.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: guest,
			referenceKey: `media-draft:${asset.id}`,
			bytes: 10n,
			status: "COMMITTED",
			expiresAt,
		},
	});
	return {
		asset,
		input: {
			draftId: draft.id,
			anonymousOwnerId: guest,
			registeredUserId: account,
			now: new Date(),
		},
	};
}

describe("registered input retention protocols", () => {
	it("retains a registered draft through a distinct account target using the genuine ORM contract", async () => {
		vi.stubEnv("ACCOUNT_INPUT_COPY_ENABLED", "true");
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, input } = await fixture();
		const claimed = await db.$transaction(async (tx: Prisma.TransactionClient) => {
			await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, "retention-test");
			return transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx);
		});
		expect(claimed.preparation).toMatchObject({ status: "COPYING" });
		expect(claimed.input).not.toHaveProperty("sourceAssetId");
		const event = await db.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: `account-input-copy:v1:${input.draftId}` },
		});
		const intent = parseAccountInputCopyIntent(event.payload);
		expect(intent.target.assetId).not.toBe(asset.id);
		expect(intent.target.objectKey).not.toBe(asset.objectKey);
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: intent.target.assetId } }),
		).resolves.toMatchObject({
			ownerId: input.registeredUserId,
			status: "UPLOADING",
			retentionClass: "ACCOUNT",
			deleteAfter: null,
		});
		const copy = await claimAccountInputCopy({ promotionId: event.id }, db);
		if (!copy) throw new Error("COPY_LEASE_MISSING");
		// The physical-copy boundary is supplied here; storage is independently
		// simulated/tested. This verifies real ORM mappings and migration triggers.
		await commitAccountInputCopy(
			{
				promotionId: copy.promotionId,
				leaseToken: copy.leaseToken,
				checksum: copy.source.checksum,
				bytes: copy.source.bytes,
				mimeType: copy.source.mimeType,
			},
			db,
		);
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			ownerId: input.anonymousOwnerId,
			retentionClass: "GUEST_TRIAL",
			deleteAfter: asset.deleteAfter,
			objectKey: asset.objectKey,
		});
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: intent.target.assetId } }),
		).resolves.toMatchObject({
			ownerId: input.registeredUserId,
			status: "VERIFYING",
			checksum: asset.checksum,
			verificationGeneration: 1,
		});
		await expect(
			db.generationDraft.findUniqueOrThrow({ where: { id: input.draftId } }),
		).resolves.toMatchObject({ ownerId: input.registeredUserId, assetId: intent.target.assetId });
		await expect(
			db.storageUsageReservation.findUniqueOrThrow({
				where: { referenceKey: `account-input-copy:${intent.target.assetId}` },
			}),
		).resolves.toMatchObject({
			ownerId: input.registeredUserId,
			bytes: asset.byteSize,
			status: "COMMITTED",
		});
		const restored = await getClaimedGenerationDraft(
			{ draftId: input.draftId, userId: input.registeredUserId },
			db,
		);
		expect(restored?.preparation).toMatchObject({ status: "VERIFYING" });
		expect(restored?.input).not.toHaveProperty("sourceAssetId");
	});
	it("cannot extend guest retention or suppress deadline cleanup with the historical flag", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		vi.stubEnv("ACCOUNT_INPUT_COPY_ENABLED", "false");
		const { asset, input } = await fixture();
		await db.$transaction(async (tx: Prisma.TransactionClient) => {
			await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, "retention-test");
			await transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx);
		});
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			ownerId: input.registeredUserId,
			retentionClass: "GUEST_TRIAL",
			deleteAfter: asset.deleteAfter,
			objectKey: asset.objectKey,
		});
		await db.mediaAsset.update({
			where: { id: asset.id },
			data: { deleteAfter: new Date(Date.now() - 1) },
		});
		await expect(
			claimMediaStorageCleanupTransaction({ assetId: asset.id, objectKeys: [asset.objectKey] }, db),
		).resolves.toBe("DELETE");
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({ status: "DELETED", deletedAt: expect.any(Date) });
	});

	it("rejects ownership transfer after deletion authorization commits, while physical deletion is outstanding", async () => {
		vi.stubEnv("ACCOUNT_INPUT_PROMOTION_ENABLED", "true");
		const { asset, input } = await fixture();
		await db.mediaAsset.update({
			where: { id: asset.id },
			data: { deleteAfter: new Date(Date.now() - 1) },
		});
		await expect(
			claimMediaStorageCleanupTransaction({ assetId: asset.id, objectKeys: [asset.objectKey] }, db),
		).resolves.toBe("DELETE");
		await expect(
			db.$transaction(async (tx: Prisma.TransactionClient) => {
				await lockGuestOwnerPromotion(tx, input.anonymousOwnerId, "retention-test");
				return transferGuestGenerationDraftToRegisteredUserInTransaction(input, tx);
			}),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		await expect(
			db.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }),
		).resolves.toMatchObject({
			status: "DELETED",
			deletedAt: expect.any(Date),
			ownerId: input.anonymousOwnerId,
		});
	});
});
