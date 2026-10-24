import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimMediaStorageCleanupTransaction } from "./storage-cleanup";

const now = new Date("2026-10-19T12:00:00Z");
function store(patch: Record<string, unknown> = {}) {
	const asset = {
		id: "asset",
		ownerId: "owner",
		objectKey: "final",
		kind: "INPUT",
		mimeType: "image/png",
		verificationEngine: "legacy",
		checksum: "a".repeat(64),
		finalizedAt: now,
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
		auditLog: { findFirst: vi.fn(async () => null) },
		generationDraft: { findFirst: vi.fn(async () => null) },
		generationJobAsset: { findFirst: vi.fn(async () => null) },
		outboxEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
	};
	const client = { $transaction: vi.fn((fn) => fn(tx)) };
	return { asset, tx, client };
}
describe("physical cleanup ownership fence", () => {
	beforeEach(() => vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
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

describe("paused image deletion", () => {
	beforeEach(() => vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", undefined));
	afterEach(() => vi.unstubAllEnvs());
	it.each(["READY", "VERIFYING", "QUARANTINED", "VERIFICATION_FAILED", "DELETED"])(
		"retains a %s original even when an earlier cleanup was queued or tombstoned",
		async (status) => {
			const { asset, tx, client } = store({ status, deletedAt: status === "DELETED" ? now : null });
			const before = structuredClone(asset);
			await expect(
				claimMediaStorageCleanupTransaction(
					{ assetId: "asset", objectKeys: ["stage", "final"], releasesReservation: true },
					client as never,
				),
			).resolves.toEqual({ outcome: "DEFER", retainedObjectKey: "final" });
			expect(asset).toEqual(before);
			expect(tx.mediaAsset.update).not.toHaveBeenCalled();
			expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
		},
	);
	it("honors the durable owner deletion audit", async () => {
		const { tx, client } = store({ status: "DELETED", deletedAt: now });
		tx.auditLog.findFirst.mockResolvedValue({ id: "owner-delete" } as never);
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).resolves.toBe("DELETE");
		expect(tx.auditLog.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					actorUserId: "owner",
					OR: expect.arrayContaining([
						{ action: "MEDIA_ASSET_DELETED", targetType: "MEDIA_ASSET", targetId: "asset" },
					]),
				},
			}),
		);
	});
	it("retains an unknown finalized upload original while ordinary staging-only cleanup remains active", async () => {
		const incomplete = store({
			status: "DELETED",
			deletedAt: now,
			checksum: null,
			finalizedAt: null,
			uploadSessions: [{ id: "session", status: "EXPIRED" }],
		});
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final", "stage"] },
				incomplete.client as never,
			),
		).resolves.toEqual({ outcome: "DEFER", retainedObjectKey: "final" });
		const live = store();
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["stage"] },
				live.client as never,
			),
		).resolves.toBe("DELETE");
		expect(live.tx.auditLog.findFirst).not.toHaveBeenCalled();
	});
	it("never releases retained final capacity through a staging-only event on an old tombstone", async () => {
		const { tx, client } = store({ status: "DELETED", deletedAt: now });
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["stage"], releasesReservation: true },
				client as never,
			),
		).resolves.toEqual({ outcome: "DEFER", retainedObjectKey: "final" });
		expect(tx.mediaAsset.update).not.toHaveBeenCalled();
	});
	it.each([{ mimeType: "video/mp4" }, { verificationEngine: "video-workflow-v1" }])(
		"keeps nonimage and video-engine behavior: %j",
		async (patch) => {
			const { client } = store(patch);
			await expect(
				claimMediaStorageCleanupTransaction(
					{ assetId: "asset", objectKeys: ["final"] },
					client as never,
				),
			).resolves.toBe("DELETE");
		},
	);
	it("can resume the retained expired draft without allowing a bound asset deletion", async () => {
		vi.stubEnv("MEDIA_IMAGE_AUTO_DELETE_ENABLED", "true");
		const { tx, client } = store({ retentionClass: "ACCOUNT", deleteAfter: null });
		tx.generationDraft.findFirst.mockResolvedValue({ id: "expired-draft" } as never);
		tx.generationJobAsset.findFirst.mockResolvedValueOnce({ jobId: "job" } as never);
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).resolves.toBe("SKIP");
		await expect(
			claimMediaStorageCleanupTransaction(
				{ assetId: "asset", objectKeys: ["final"] },
				client as never,
			),
		).resolves.toBe("DELETE");
	});
});
