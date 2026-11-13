import { describe, expect, it, vi } from "vitest";

import { claimVideoResourceCleanup, listVideoResourceCleanupCandidates } from "./video-v1-cleanup";

const now = new Date("2026-11-13T00:00:00Z");
function fixture(objectKey: string, deletedAt: Date | null = null) {
	const asset = {
		id: "asset",
		ownerType: "USER",
		ownerId: "admin",
		kind: "INPUT",
		objectKey,
		status: deletedAt ? "DELETED" : "READY",
		deletedAt,
		createdAt: new Date(now.getTime() - 35 * 86_400_000),
		deleteAfter: null,
		templateScenes: [],
		jobBindings: [],
		uploadSessions: [],
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		mediaAsset: {
			findFirst: vi.fn(async () => asset),
			findMany: vi.fn(async () => []),
			update: vi.fn(),
		},
		mediaUploadSession: { updateMany: vi.fn() },
	};
	const db = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) };
	return { asset, tx, db };
}

describe("permanent source-template material retention", () => {
	it.each([null, now])(
		"refuses automatic deletion even for an old candidate (deletedAt=%s)",
		async (deletedAt) => {
			const { tx, db } = fixture("users/admin/source-templates/frozen-fingerprint", deletedAt);
			expect(await claimVideoResourceCleanup("asset", now, db as never)).toBeNull();
			expect(tx.mediaAsset.update).not.toHaveBeenCalled();
			expect(tx.mediaUploadSession.updateMany).not.toHaveBeenCalled();
		},
	);
	it("excludes the reserved material namespace from bounded candidate scans", async () => {
		const { db } = fixture("users/admin/source-templates/frozen-fingerprint");
		await listVideoResourceCleanupCandidates({ now, limit: 20 }, db as never);
		expect(db.mediaAsset.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					NOT: {
						kind: "INPUT",
						objectKey: { startsWith: "users/", contains: "/source-templates/" },
					},
				}),
			}),
		);
	});
	it("still claims an expired ordinary user input", async () => {
		const { tx, db } = fixture("users/admin/video-input.png");
		expect(await claimVideoResourceCleanup("asset", now, db as never)).toMatchObject({
			assetId: "asset",
			objectKeys: ["users/admin/video-input.png"],
		});
		expect(tx.mediaAsset.update).toHaveBeenCalledOnce();
	});
});
