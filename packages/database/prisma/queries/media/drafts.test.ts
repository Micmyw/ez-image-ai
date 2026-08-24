import { describe, expect, it, vi } from "vitest";

import { claimGenerationDraftTransaction, expireGenerationDrafts } from "./drafts";

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
			{ claimTokenHash: "hash", userId: "user_1", now: new Date("2026-08-14T00:00:00Z") },
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
				{ claimTokenHash: "hash", userId: "user_1", now: new Date("2026-08-14T00:00:00Z") },
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
				{ claimTokenHash: "hash", userId: "user_1", now: new Date("2026-08-14T00:00:00Z") },
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
				{ claimTokenHash: "hash", userId: "user_1", now: new Date("2026-08-14T00:00:00Z") },
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
				{ claimTokenHash: "hash", userId: "user_2", now: new Date("2026-08-14T00:00:00Z") },
				client as never,
			),
		).rejects.toThrow("DRAFT_UNAVAILABLE");
		expect(tx.generationDraft.updateMany).not.toHaveBeenCalled();
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
