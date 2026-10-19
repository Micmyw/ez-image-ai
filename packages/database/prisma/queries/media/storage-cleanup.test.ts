import { describe, expect, it, vi } from "vitest";

import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

const now = new Date("2026-10-19T12:00:00Z");
function store(patch: Record<string, unknown> = {}) {
	const asset = {
		id: "asset",
		objectKey: "final",
		kind: "INPUT",
		status: "READY",
		retentionClass: "GUEST_TRIAL",
		deleteAfter: new Date(now.getTime() - 1),
		deletedAt: null,
		uploadSessions: [
			{
				id: "session",
				stagingObjectKey: "stage",
				multipartUploadId: "source-upload",
				promotionMultipartUploadId: "promotion-upload",
			},
		],
		...patch,
	};
	const tx = {
		$executeRaw: vi.fn(async () => 1),
		$queryRaw: vi.fn(async () => [{ now }]),
		mediaAsset: {
			findUnique: vi.fn(async () => asset),
			update: vi.fn(async ({ data }) => Object.assign(asset, data)),
		},
		mediaUploadSession: { findFirst: vi.fn(async () => null) },
		outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
	};
	const client = { $transaction: vi.fn((fn) => fn(tx)) };
	return { asset, tx, client };
}
describe("physical cleanup ownership fence", () => {
	it("durably tombstones a due guest final key before authorizing physical deletion", async () => {
		const { asset, client, tx } = store();
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final", "stage"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(asset).toMatchObject({ status: "DELETED", deletedAt: now });
		expect(tx.outboxEvent.createMany).toHaveBeenCalledTimes(3);
		expect(tx.outboxEvent.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						eventType: "MEDIA_OBJECT_DELETE",
						payload: expect.objectContaining({
							uploadSessionId: "session",
							reservationStatus: "RELEASED",
						}),
					}),
				],
			}),
		);
	});
	it("skips the whole old deletion group after account adoption, including a final key hidden in extra keys", async () => {
		const { tx, client } = store({ retentionClass: "ACCOUNT", deleteAfter: null });
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["stage", "final"], releasesReservation: true },
				client as never,
			),
		).resolves.toBe("SKIP");
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
		expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
	});
	it("uses the database clock and refuses physical deletion before the guest deadline", async () => {
		const { tx, client } = store({ deleteAfter: new Date(now.getTime() + 1) });
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).rejects.toThrow("MEDIA_STORAGE_CLEANUP_NOT_DUE");
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it("leaves a live account asset unchanged for staging-only cleanup", async () => {
		const { tx, client } = store({ retentionClass: "ACCOUNT", deleteAfter: null });
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["stage"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it("does not release live storage from a staging-only deletion", async () => {
		const { client } = store({ retentionClass: "ACCOUNT", deleteAfter: null });
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["stage"], releasesReservation: true },
				client as never,
			),
		).rejects.toThrow("MEDIA_STORAGE_CLEANUP_RELEASE_WITHOUT_FINAL_KEY");
	});
	it("keeps a deletion winner permanently unavailable during retries", async () => {
		const { asset, client } = store();
		const input = { assetId: "asset", objectKeys: ["final"] };
		await claimMediaStorageCleanupTransaction(input, client as never);
		await expect(claimMediaStorageCleanupTransaction(input, client as never)).resolves.toBe(
			"DELETE",
		);
		expect(asset).toMatchObject({ status: "DELETED", deletedAt: now });
	});
	it.each(["GUEST_TRIAL", "ACCOUNT"])(
		"still cleans a terminal %s upload before a later retention deadline",
		async (retentionClass) => {
			const { asset, tx, client } = store({
				retentionClass,
				status: "UPLOADING",
				deleteAfter: new Date(now.getTime() + 60_000),
			});
			tx.mediaUploadSession.findFirst.mockResolvedValue({ id: "session" } as never);
			await expect(
				claimMediaStorageCleanupTransaction(
					{
						assetId: "asset",
						objectKeys: ["final"],
						uploadSessionId: "session",
						releasesReservation: true,
					},
					client as never,
				),
			).resolves.toBe("DELETE");
			expect(asset).toMatchObject({ status: "DELETED", deletedAt: now });
		},
	);
	it("retains terminal output cleanup compatibility", async () => {
		const { asset, client } = store({
			retentionClass: "ACCOUNT",
			kind: "OUTPUT",
			status: "VERIFICATION_FAILED",
			deleteAfter: null,
		});
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(asset).toMatchObject({ status: "DELETED", deletedAt: now });
	});
	it("deletes a failed guest upload immediately instead of waiting for its retention deadline", async () => {
		const { asset, client } = store({
			status: "VERIFICATION_FAILED",
			deleteAfter: new Date(now.getTime() + 86_400_000),
		});
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(asset).toMatchObject({ status: "DELETED", deletedAt: now });
	});
	it("allows an orphan's persisted cleanup when no asset row remains", async () => {
		const { tx, client } = store();
		tx.mediaAsset.findUnique.mockResolvedValue(null as never);
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["orphan"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it("does not authorize storage I/O if canonical cleanup cannot be durably queued", async () => {
		const { tx, client } = store();
		tx.outboxEvent.createMany.mockRejectedValue(new Error("outbox unavailable"));
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).rejects.toThrow("outbox unavailable");
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
	});
});
