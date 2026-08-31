import { describe, expect, it, vi } from "vitest";

import {
	claimGenerationDraftTransaction,
	expireGenerationDrafts,
	finalizeGuestDraftFromReadyUploadTransaction,
} from "./drafts";

describe("finalizeGuestDraftFromReadyUploadTransaction", () => {
	it("persists the server-validated Quality product on the private draft", async () => {
		const now = new Date("2026-08-31T00:00:00.000Z");
		const validUntil = new Date("2026-09-01T00:00:00.000Z");
		const checksum = "a".repeat(64);
		const asset = {
			id: "asset_1",
			ownerId: "guest_owner",
			status: "READY",
			deletedAt: null,
			kind: "INPUT",
			checksum,
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "sightengine",
			verificationProviderTaskId: "task_1",
			verificationRuleVersion: "rule-v1",
			verificationPolicyVersion: "policy-v1",
			verificationValidUntil: validUntil,
			moderationResults: [
				{
					status: "APPROVED",
					assetChecksum: checksum,
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "INPUT",
					provider: "sightengine",
					providerTaskId: "task_1",
					ruleVersion: "rule-v1",
					policyVersion: "policy-v1",
					validUntil,
				},
			],
			jobBindings: [],
		};
		const tx = {
			$executeRaw: vi.fn(),
			mediaUploadSession: {
				findFirst: vi.fn().mockResolvedValue({ id: "session_1", assetId: asset.id, asset }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			generationDraft: {
				create: vi.fn(async ({ data }) => ({ id: "draft_1", expiresAt: data.expiresAt })),
			},
			guestSessionBootstrap: {
				count: vi.fn().mockResolvedValue(0),
				create: vi.fn().mockResolvedValue({ id: "bootstrap_1" }),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await finalizeGuestDraftFromReadyUploadTransaction(
			{
				sessionId: "session_1",
				completionTokenHash: "b".repeat(64),
				consumedTokenHash: "c".repeat(64),
				claimTokenHash: "d".repeat(64),
				capabilityVersion: "guest-v1",
				promotionPeriod: "launch",
				maximumOutstandingBootstraps: 25,
				productKey: "image-quality",
				prompt: "Preserve the product details",
				expiresAt: validUntil,
				verification: {
					provider: "sightengine",
					ruleVersion: "rule-v1",
					policyVersion: "policy-v1",
					now,
				},
			} as never,
			client as never,
		);

		expect(tx.generationDraft.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ productKey: "image-quality" }),
		});
	});
});

describe("claimGenerationDraftTransaction", () => {
	it("atomically consumes one active token and transfers its temporary asset to the user", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue({
					id: "draft_1",
					ownerType: "USER",
					ownerId: "draft:draft_1",
					submittedByUserId: "draft:draft_1",
					status: "ACTIVE",
					claimTokenHash: "hash",
					assetId: "asset_1",
					inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
					productKey: "image-fast",
					expiresAt: new Date("2026-08-14T01:00:00Z"),
				}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			mediaAsset: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
			outboxEvent: { create: vi.fn().mockResolvedValue({ id: "event_1" }) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		const claimed = await claimGenerationDraftTransaction(
			{
				claimTokenHash: "hash",
				userId: "user_1",
				now: new Date("2026-08-14T00:00:00Z"),
				allowedProductKeys: ["image-fast", "image-quality"],
			},
			client as never,
		);

		expect(claimed).toEqual({
			id: "draft_1",
			productKey: "image-fast",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.generationDraft.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "draft_1", status: "ACTIVE" }),
				data: expect.objectContaining({
					ownerType: "USER",
					ownerId: "user_1",
					submittedByUserId: "user_1",
					status: "SUBMITTED",
				}),
			}),
		);
		expect(tx.mediaAsset.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "asset_1", ownerId: "draft:draft_1", status: "VERIFYING" },
				data: { ownerType: "USER", ownerId: "user_1" },
			}),
		);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					eventType: "MEDIA_ASSET_VERIFY",
					dedupeKey: "media-asset-verify:asset_1",
				}),
			}),
		);
	});

	it("rejects a replay when the atomic state change loses", async () => {
		const activeDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "draft:draft_1",
			submittedByUserId: "draft:draft_1",
			status: "ACTIVE",
			claimTokenHash: "hash",
			assetId: null,
			inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
			productKey: "image-fast",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValueOnce(activeDraft).mockResolvedValueOnce(null),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-fast", "image-quality"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
	});

	it("returns the claimed draft when the same user loses a concurrent claim race", async () => {
		const activeDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "draft:draft_1",
			submittedByUserId: "draft:draft_1",
			status: "ACTIVE",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
			productKey: "image-fast",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const submittedDraft = {
			...activeDraft,
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValueOnce(activeDraft).mockResolvedValueOnce(submittedDraft),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			mediaAsset: { updateMany: vi.fn() },
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-fast", "image-quality"],
				},
				client as never,
			),
		).resolves.toEqual({
			id: "draft_1",
			productKey: "image-fast",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("returns an unexpired submitted draft when the same user repeats the claim", async () => {
		const submittedDraft = {
			id: "draft_1",
			ownerType: "USER",
			ownerId: "user_1",
			submittedByUserId: "user_1",
			status: "SUBMITTED",
			assetId: "asset_1",
			claimTokenHash: "hash",
			inputSnapshot: { kind: "image-to-image", prompt: "Soften the background" },
			productKey: "image-fast",
			expiresAt: new Date("2026-08-14T01:00:00Z"),
		};
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(submittedDraft),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
			mediaAsset: { updateMany: vi.fn() },
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-fast", "image-quality"],
				},
				client as never,
			),
		).resolves.toEqual({
			id: "draft_1",
			productKey: "image-fast",
			input: {
				kind: "image-to-image",
				prompt: "Soften the background",
				sourceAssetId: "asset_1",
			},
		});
		expect(tx.generationDraft.updateMany).not.toHaveBeenCalled();
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});

	it("rejects a repeated claim after another user submitted the draft", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(null),
				updateMany: vi.fn(),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_2",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-fast", "image-quality"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.generationDraft.updateMany).not.toHaveBeenCalled();
	});

	it("filters the atomic claim by currently allowed stable product keys", async () => {
		const tx = {
			generationDraft: {
				findFirst: vi.fn().mockResolvedValue(null),
				updateMany: vi.fn(),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			claimGenerationDraftTransaction(
				{
					claimTokenHash: "hash",
					userId: "user_1",
					now: new Date("2026-08-14T00:00:00Z"),
					allowedProductKeys: ["image-fast", "image-quality"],
				},
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.generationDraft.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					productKey: { in: ["image-fast", "image-quality"] },
				}),
			}),
		);
	});
});

describe("expireGenerationDrafts", () => {
	it("limits expiry to the requested draft candidates", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => []),
			},
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };
		const now = new Date("2026-08-14T00:00:00Z");

		await expect(
			expireGenerationDrafts(now, client as never, ["draft_e2e_1", "draft_e2e_2"]),
		).resolves.toBe(0);
		expect(tx.generationDraft.findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["draft_e2e_1", "draft_e2e_2"] },
				status: "ACTIVE",
				expiresAt: { lte: now },
			},
			select: { id: true, assetId: true, ownerId: true },
		});
	});

	it("queues physical deletion for each expired anonymous draft asset", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => [
					{ id: "draft_1", assetId: "asset_1", ownerId: "anonymous:subject" },
				]),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			mediaAsset: {
				findUnique: vi.fn(async () => ({
					objectKey: "users/anonymous/assets/asset_1/original.png",
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			outboxEvent: { create: vi.fn(async ({ data }) => data) },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };
		await expect(
			expireGenerationDrafts(new Date("2026-08-14T00:00:00Z"), client as never),
		).resolves.toBe(1);
		expect(tx.outboxEvent.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				eventType: "MEDIA_OBJECT_DELETE",
				dedupeKey: "media-draft-expire-cleanup:draft_1",
			}),
		});
	});

	it("does not delete an asset when a concurrent claim already consumed the draft", async () => {
		const tx = {
			generationDraft: {
				findMany: vi.fn(async () => [
					{ id: "draft_1", assetId: "asset_1", ownerId: "anonymous:subject" },
				]),
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			mediaAsset: {
				findUnique: vi.fn(),
				updateMany: vi.fn(),
			},
			outboxEvent: { create: vi.fn() },
		};
		const client = { $transaction: vi.fn((operation) => operation(tx)) };

		await expect(
			expireGenerationDrafts(new Date("2026-08-14T00:00:00Z"), client as never),
		).resolves.toBe(0);
		expect(tx.mediaAsset.findUnique).not.toHaveBeenCalled();
		expect(tx.mediaAsset.updateMany).not.toHaveBeenCalled();
		expect(tx.outboxEvent.create).not.toHaveBeenCalled();
	});
});
