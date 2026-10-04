import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({ createMediaUploadSessionTransaction: vi.fn() }));
vi.mock("@repo/database/video-template", () => ({
	getVideoTemplateInputRecord: vi.fn(),
	getVideoTemplateInputReadAuthorization: vi.fn(),
}));
vi.mock("@repo/database/video-v1-uploads", () => ({
	getVideoUploadSession: vi.fn(),
	recordVideoInputIdentity: vi.fn(),
	releaseNormalizedSourceStorage: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/template-admission", () => ({
	VIDEO_EFFECT_CAPABILITY_REQUEST: {},
	requireVideoTemplateAdmission: vi.fn(() => ({ maximumInputBytes: 10_000_000, template: {} })),
	requireVideoTemplateRuntimeEnabled: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({}),
}));
vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: () => "owner/final/photo.jpg",
	createStagingObjectKey: () => "owner/staging/photo.jpg",
	createSignedUpload: vi.fn(async () => "https://fixture.test/upload"),
	deleteObject: vi.fn(),
	inspectPrivateImage: vi.fn(async () => ({ width: 720, height: 1280 })),
	normalizeVideoReferenceToPng: vi.fn(async () => ({
		bytes: 200,
		sha256: "b".repeat(64),
		etag: "canonical-etag",
		versionId: null,
	})),
}));
vi.mock("../media/lib/asset-read-url", () => ({ signAuthorizedAssetReadUrl: vi.fn() }));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: vi.fn(async () => ({ maximumInputBytes: 8_000_000 })),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({
	mediaUploadLimits: () => ({ maximumActiveSessions: 5, maximumReservedBytes: 100_000_000n }),
}));
vi.mock("../media/procedures/complete-upload-session", () => ({
	completeOwnedUploadSession: vi.fn(),
}));
vi.mock("../video-v1/uploads", () => ({ validateVideoUpload: vi.fn() }));

import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import {
	getVideoTemplateInputRecord,
	getVideoTemplateInputReadAuthorization,
} from "@repo/database/video-template";
import {
	getVideoUploadSession,
	recordVideoInputIdentity,
	releaseNormalizedSourceStorage,
} from "@repo/database/video-v1-uploads";
import { deleteObject, inspectPrivateImage, normalizeVideoReferenceToPng } from "@repo/storage";

import { signAuthorizedAssetReadUrl } from "../media/lib/asset-read-url";
import { completeOwnedUploadSession } from "../media/procedures/complete-upload-session";
import { completeVideoEffectUpload, createVideoEffectUpload, getVideoEffectInput } from "./uploads";

const source = {
	id: "asset",
	mimeType: "image/jpeg",
	byteSize: 100n,
	objectKey: "owner/final/photo.jpg.template-source",
	checksum: "a".repeat(64),
	storageEtag: "source-etag",
	storageVersionId: null,
	finalizedAt: new Date(),
	width: null,
	height: null,
	status: "VERIFYING",
};
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getVideoUploadSession).mockResolvedValue({ asset: source } as never);
	vi.mocked(recordVideoInputIdentity).mockImplementation(
		async (input) => ({ ...source, ...input, byteSize: BigInt(input.bytes) }) as never,
	);
});

describe("template canonical immutable photo boundary", () => {
	it.each(["image/jpeg", "image/png", "image/webp"])(
		"reserves source plus canonical capacity for %s before signing",
		async (contentType) => {
			await createVideoEffectUpload({ id: "owner" }, { contentType, byteSize: 100 });
			expect(createMediaUploadSessionTransaction).toHaveBeenCalledWith(
				expect.objectContaining({
					reservedBytes: 8_000_100n,
					expectedBytes: 100n,
					objectKey: "owner/final/photo.jpg.template-source",
					verificationEngine: "video-workflow-v1",
				}),
				expect.anything(),
			);
		},
	);
	it.each(["image/jpeg", "image/png", "image/webp"])(
		"decodes and normalizes %s before publishing the sealed identity",
		async (mimeType) => {
			vi.mocked(getVideoUploadSession).mockResolvedValue({
				asset: { ...source, mimeType },
			} as never);
			const result = await completeVideoEffectUpload({ id: "owner" }, { sessionId: "session" });
			expect(inspectPrivateImage).toHaveBeenCalledTimes(2);
			expect(normalizeVideoReferenceToPng).toHaveBeenCalledWith(
				expect.objectContaining({
					sourceContentType: mimeType,
					sourceEtag: "source-etag",
					maximumBytes: 8_000_000,
					final: {
						bucket: "media",
						key: "owner/final/photo.jpg.template-source.template-input.png",
					},
				}),
			);
			expect(recordVideoInputIdentity).toHaveBeenCalledWith(
				expect.objectContaining({
					checksum: "b".repeat(64),
					mimeType: "image/png",
					objectKey: "owner/final/photo.jpg.template-source.template-input.png",
					etag: "canonical-etag",
				}),
			);
			expect(result.mimeType).toBe("image/png");
			expect(releaseNormalizedSourceStorage).toHaveBeenCalledWith(
				"owner",
				"session",
				"owner/final/photo.jpg.template-source.template-input.png",
			);
		},
	);
	it("rejects ordinary upload sessions as template canonical uploads", async () => {
		vi.mocked(getVideoUploadSession).mockResolvedValue({
			asset: { ...source, objectKey: "ordinary/photo.png" },
		} as never);
		await expect(
			completeVideoEffectUpload({ id: "owner" }, { sessionId: "session" }),
		).rejects.toThrow("VIDEO_UPLOAD_NOT_FOUND");
		expect(completeOwnedUploadSession).not.toHaveBeenCalled();
	});
	it("retains capacity when physical source deletion fails", async () => {
		vi.mocked(deleteObject).mockRejectedValueOnce(new Error("delete failed"));
		await completeVideoEffectUpload({ id: "owner" }, { sessionId: "session" });
		expect(releaseNormalizedSourceStorage).not.toHaveBeenCalled();
	});
	it("replays the canonical identity after a lost response without re-transforming", async () => {
		vi.mocked(getVideoUploadSession).mockResolvedValue({
			asset: {
				...source,
				mimeType: "image/png",
				objectKey: `${source.objectKey}.template-input.png`,
				width: 720,
				height: 1280,
			},
		} as never);
		await completeVideoEffectUpload({ id: "owner" }, { sessionId: "session" });
		expect(normalizeVideoReferenceToPng).not.toHaveBeenCalled();
		expect(recordVideoInputIdentity).not.toHaveBeenCalled();
		expect(deleteObject).toHaveBeenCalledWith({ bucket: "media", key: source.objectKey });
	});
	it("restores owned input metadata without signing unchecked content", async () => {
		vi.mocked(getVideoTemplateInputRecord).mockResolvedValue({
			...source,
			width: 720,
			height: 1280,
		} as never);
		const result = await getVideoEffectInput("owner", "asset");
		expect(getVideoTemplateInputRecord).toHaveBeenCalledWith("owner", "asset", expect.anything());
		expect(result.previewUrl).toBeNull();
		expect(signAuthorizedAssetReadUrl).not.toHaveBeenCalled();
	});
	it("reissues preview only after current owned template approval", async () => {
		vi.mocked(getVideoTemplateInputRecord).mockResolvedValue({
			...source,
			width: 720,
			height: 1280,
		} as never);
		const authorization = {
			id: source.id,
			objectKey: source.objectKey,
			verificationValidUntil: new Date(Date.now() + 60000),
			deleteAfter: null,
		};
		vi.mocked(getVideoTemplateInputReadAuthorization).mockResolvedValueOnce(authorization);
		vi.mocked(signAuthorizedAssetReadUrl).mockResolvedValueOnce({
			assetId: source.id,
			url: "https://fixture.test/approved",
			expiresAt: "2100-01-01T00:00:00Z",
			expiresIn: 60,
		});
		expect((await getVideoEffectInput("owner", "asset")).previewUrl).toBe(
			"https://fixture.test/approved",
		);
		expect(signAuthorizedAssetReadUrl).toHaveBeenCalledWith(authorization);
	});
});
