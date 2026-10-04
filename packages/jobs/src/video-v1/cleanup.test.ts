import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
	listVideoStagingCleanup: vi.fn(),
	completeVideoStagingCleanup: vi.fn(),
	listVideoResourceCleanupCandidates: vi.fn(),
	claimVideoResourceCleanup: vi.fn(),
	completeVideoResourceCleanup: vi.fn(),
	deleteObject: vi.fn(),
	abortMultipartUpload: vi.fn(),
	listMultipartUploads: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-v1-cleanup", () => f);
vi.mock("@repo/storage", () => f);
import { recoverVideoResources } from "./cleanup";
beforeEach(() => {
	vi.clearAllMocks();
	f.listVideoStagingCleanup.mockResolvedValue([]);
	f.listVideoResourceCleanupCandidates.mockResolvedValue([{ id: "asset" }]);
	f.claimVideoResourceCleanup.mockResolvedValue({
		assetId: "asset",
		objectKeys: ["private/final.mp4", "private/staging.mp4"],
		multipart: [],
		sessionIds: [],
	});
	f.listMultipartUploads.mockResolvedValue([]);
	f.deleteObject.mockResolvedValue(undefined);
	f.completeVideoResourceCleanup.mockResolvedValue(undefined);
});
describe("video resource recovery", () => {
	it("deletes only claimed objects and releases bytes after physical cleanup", async () => {
		expect(await recoverVideoResources(5)).toEqual({ scanned: 1, cleaned: 1, failed: 0 });
		expect(f.deleteObject).toHaveBeenCalledTimes(2);
		expect(f.completeVideoResourceCleanup).toHaveBeenCalledTimes(1);
		expect(f.completeVideoResourceCleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
			f.deleteObject.mock.invocationCallOrder[1]!,
		);
	});
	it("retains the durable tombstone and reservation when storage fails, then retries cleanup", async () => {
		f.deleteObject.mockRejectedValueOnce(new Error("storage unavailable"));
		expect(await recoverVideoResources()).toEqual({ scanned: 1, cleaned: 0, failed: 1 });
		expect(f.completeVideoResourceCleanup).not.toHaveBeenCalled();
		expect(await recoverVideoResources()).toEqual({ scanned: 1, cleaned: 1, failed: 0 });
	});
	it("does not touch live or uncertain references denied by the claim", async () => {
		f.claimVideoResourceCleanup.mockResolvedValue(null);
		expect(await recoverVideoResources()).toEqual({ scanned: 1, cleaned: 0, failed: 0 });
		expect(f.deleteObject).not.toHaveBeenCalled();
		expect(f.abortMultipartUpload).not.toHaveBeenCalled();
		expect(f.completeVideoResourceCleanup).not.toHaveBeenCalled();
	});
	it("cleans only expired staging and obsolete normalized source without acquiring the final input", async () => {
		f.listVideoResourceCleanupCandidates.mockResolvedValue([]);
		f.listVideoStagingCleanup.mockResolvedValue([
			{
				sessionId: "session",
				assetId: "input",
				stagingKey: "private/staging",
				sourceKey: "private/obsolete.webp",
			},
		]);
		expect(await recoverVideoResources()).toEqual({ scanned: 1, cleaned: 1, failed: 0 });
		expect(f.deleteObject.mock.calls).toEqual([
			[{ bucket: "media", key: "private/staging" }],
			[{ bucket: "media", key: "private/obsolete.webp" }],
		]);
		expect(f.completeVideoStagingCleanup).toHaveBeenCalledTimes(1);
	});
});
