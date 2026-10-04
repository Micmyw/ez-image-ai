import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	createMediaUploadSessionTransaction: vi.fn(async () => undefined),
}));
vi.mock("@repo/database/video-v1-uploads", () => ({
	getVideoUploadSession: vi.fn(),
	recordVideoInputIdentity: vi.fn(),
	releaseNormalizedSourceStorage: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/admission", () => ({
	requireVideoAdmission: vi.fn(() => ({ config: { maxInputBytes: 10_000_000 } })),
}));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({}),
}));
vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: () => "users/owner/final/reference.webp",
	createStagingObjectKey: () => "users/owner/staging/image.webp",
	createSignedUpload: vi.fn(async () => "http://localhost/upload"),
	deleteObject: vi.fn(async () => undefined),
	inspectPrivateImage: vi.fn(async () => ({ width: 640, height: 480 })),
	normalizeVideoReferenceToPng: vi.fn(async () => ({
		bytes: 200,
		sha256: "sealed-png",
		etag: "png-etag",
		versionId: null,
	})),
}));
vi.mock("../media/procedures/complete-upload-session", () => ({
	completeOwnedUploadSession: vi.fn(),
}));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => ({ maximumInputBytes: 8_000_000 }),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({
	mediaUploadLimits: () => ({ maximumActiveSessions: 5, maximumReservedBytes: 100_000_000n }),
}));
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { getVideoUploadSession, recordVideoInputIdentity } from "@repo/database/video-v1-uploads";
import { inspectPrivateImage, normalizeVideoReferenceToPng } from "@repo/storage";

import { completeOwnedUploadSession } from "../media/procedures/complete-upload-session";
import { completeVideoUpload, createVideoUpload, validateVideoUpload } from "./uploads";

const user = { id: "owner" };
const asset = {
	id: "asset",
	ownerId: user.id,
	checksum: "sealed-webp",
	storageEtag: "webp-etag",
	storageVersionId: null,
	finalizedAt: new Date(),
	objectKey: "users/owner/final/reference.webp",
	byteSize: 100n,
	mimeType: "image/webp",
	width: null,
	height: null,
	status: "VERIFYING",
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("VIDEO_V1_ENABLED", "true");
	vi.stubEnv("VIDEO_V1_ALLOWED_USER_IDS", "owner");
	vi.stubEnv(
		"VIDEO_MODEL_ALLOWED_OPTIONS",
		JSON.stringify([
			{
				productKey: "video-kling-2-6-v1",
				modes: ["image-to-video"],
				durations: [5],
				resolutions: ["default"],
				sounds: [false],
			},
		]),
	);
	vi.mocked(getVideoUploadSession).mockResolvedValue({ asset } as never);
	vi.mocked(recordVideoInputIdentity).mockImplementation(
		async (value) => ({ ...asset, ...value, byteSize: BigInt(value.bytes) }) as never,
	);
});
afterEach(() => vi.unstubAllEnvs());
describe("video V1 immutable upload boundary", () => {
	it("rejects disguised/unsupported declared types and both contract and plan limits", () => {
		for (const contentType of ["video/mp4", "image/gif", "text/plain"])
			expect(() => validateVideoUpload({ contentType, byteSize: 100 }, 10_000_000)).toThrow(
				"VIDEO_INPUT_TYPE_UNSUPPORTED",
			);
		expect(() =>
			validateVideoUpload({ contentType: "image/png", byteSize: 10_000_001 }, 20_000_000),
		).toThrow("INPUT_TOO_LARGE");
		expect(() => validateVideoUpload({ contentType: "image/png", byteSize: 501 }, 500)).toThrow(
			"INPUT_TOO_LARGE",
		);
	});
	it("reserves original and maximum normalized bytes before creating a WebP upload", async () => {
		await createVideoUpload(user, { contentType: "image/webp", byteSize: 100 });
		expect(createMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				verificationEngine: "video-workflow-v1",
				expectedBytes: 100n,
				reservedBytes: 8_000_100n,
			}),
			expect.anything(),
		);
	});
	it("uses server-sealed original, preserves dimensions, and never reports moderation approved", async () => {
		const result = await completeVideoUpload(user, { sessionId: "session" });
		expect(completeOwnedUploadSession).toHaveBeenCalledWith({ sessionId: "session" }, "owner", {
			expectedVerificationEngine: "video-workflow-v1",
		});
		expect(normalizeVideoReferenceToPng).toHaveBeenCalledWith(
			expect.objectContaining({
				source: { bucket: "media", key: asset.objectKey },
				sourceEtag: asset.storageEtag,
			}),
		);
		expect(recordVideoInputIdentity).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceChecksum: "sealed-webp",
				checksum: "sealed-png",
				mimeType: "image/png",
				width: 640,
				height: 480,
			}),
		);
		expect(result).toMatchObject({
			status: "VERIFYING",
			moderationStatus: "PENDING",
			uploadStatus: "COMPLETED",
		});
	});
	it("refuses unknown owner/session without storage work", async () => {
		vi.mocked(getVideoUploadSession).mockResolvedValueOnce(null);
		await expect(completeVideoUpload(user, { sessionId: "foreign" })).rejects.toThrow(
			"VIDEO_UPLOAD_NOT_FOUND",
		);
		expect(completeOwnedUploadSession).not.toHaveBeenCalled();
	});
	it("does not make invalid image bytes eligible for quote", async () => {
		vi.mocked(inspectPrivateImage).mockRejectedValueOnce(new Error("INVALID_IMAGE"));
		await expect(completeVideoUpload(user, { sessionId: "session" })).rejects.toThrow(
			"INVALID_IMAGE",
		);
		expect(recordVideoInputIdentity).not.toHaveBeenCalled();
	});
});
