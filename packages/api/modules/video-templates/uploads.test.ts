import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({ createMediaUploadSessionTransaction: vi.fn() }));
vi.mock("@repo/database/video-source-template-admission", () => ({
	getSourceTemplateInputRecord: vi.fn(),
}));
vi.mock("@repo/jobs/video-v1/source-template-admission", () => ({ sourceTemplateAccess: vi.fn() }));
vi.mock("@repo/jobs/video-v1/workflow-binding", () => ({
	getVideoWorkflowReadinessBindings: () => ({}),
}));
vi.mock("@repo/storage", () => ({
	createSignedReadUrl: vi.fn(async () => "https://private.example/signed"),
	createFinalAssetObjectKey: () => "final",
	createStagingObjectKey: () => "staging",
	createSignedUpload: vi.fn(),
}));
vi.mock("../media/lib/asset-authorization", () => ({ requireReadyOwnedMediaAsset: vi.fn() }));
vi.mock("../media/lib/asset-read-url", () => ({ signAuthorizedAssetReadUrl: vi.fn() }));
vi.mock("../media/lib/plan-entitlement", () => ({
	loadUserPlanEntitlement: async () => ({ maximumInputBytes: 10000000 }),
}));
vi.mock("../media/lib/rate-limit", () => ({ enforceMediaRateLimit: vi.fn() }));
vi.mock("../media/lib/storage-limits", () => ({ mediaUploadLimits: () => ({}) }));
vi.mock("../video-v1/uploads", () => ({
	validateVideoUpload: vi.fn(),
	completeVideoUpload: vi.fn(),
}));
import { getSourceTemplateInputRecord } from "@repo/database/video-source-template-admission";
import { sourceTemplateAccess } from "@repo/jobs/video-v1/source-template-admission";
import { createSignedReadUrl } from "@repo/storage";

import { requireReadyOwnedMediaAsset } from "../media/lib/asset-authorization";
import { createSourceTemplateUpload, getSourceTemplateInput } from "./uploads";

const asset = {
	id: "photo",
	kind: "INPUT",
	verificationEngine: "video-workflow-v1",
	status: "VERIFYING",
	objectKey: "users/owner/photo.png",
	deleteAfter: null,
	mimeType: "image/png",
	byteSize: 100n,
	width: 32,
	height: 32,
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(getSourceTemplateInputRecord).mockResolvedValue(asset as never);
	vi.mocked(createSignedReadUrl).mockResolvedValue("https://private.example/signed");
});
describe("source template original previews", () => {
	it("previews a sealed owner upload pending review with one owner-scoped read", async () => {
		const result = await getSourceTemplateInput("owner", "photo");
		expect(getSourceTemplateInputRecord).toHaveBeenCalledExactlyOnceWith(
			"owner",
			"photo",
			expect.anything(),
		);
		expect(result.previewUrl).toBe("https://private.example/signed");
		expect(result).not.toHaveProperty("approved");
		expect(requireReadyOwnedMediaAsset).not.toHaveBeenCalled();
		expect(createSignedReadUrl).toHaveBeenCalledWith(
			expect.objectContaining({ key: asset.objectKey, expiresIn: 300 }),
		);
	});
	it("does not sign an inaccessible asset or an expired original", async () => {
		vi.mocked(getSourceTemplateInputRecord).mockResolvedValueOnce(null);
		await expect(getSourceTemplateInput("other-owner", "photo")).rejects.toThrow("NOT_FOUND");
		vi.mocked(getSourceTemplateInputRecord).mockResolvedValueOnce({
			...asset,
			deleteAfter: new Date(Date.now() - 1000),
		} as never);
		await expect(getSourceTemplateInput("owner", "photo")).rejects.toThrow(
			"VIDEO_INPUT_NOT_AVAILABLE",
		);
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});
	it("keeps generated outputs behind full approval", async () => {
		vi.mocked(getSourceTemplateInputRecord).mockResolvedValueOnce({
			...asset,
			kind: "OUTPUT",
		} as never);
		await expect(getSourceTemplateInput("owner", "photo")).rejects.toThrow("NOT_FOUND");
		vi.mocked(getSourceTemplateInputRecord).mockResolvedValueOnce({
			...asset,
			kind: "OUTPUT",
			status: "READY",
		} as never);
		vi.mocked(requireReadyOwnedMediaAsset).mockRejectedValueOnce(new Error("NOT_APPROVED"));
		await expect(getSourceTemplateInput("owner", "photo")).rejects.toThrow(
			"VIDEO_INPUT_NOT_AVAILABLE",
		);
		expect(createSignedReadUrl).not.toHaveBeenCalled();
	});
	it("uses upload admission without rereading the reference pack, and still denies closed templates", async () => {
		vi.mocked(sourceTemplateAccess).mockResolvedValue({
			available: true,
			reasons: [],
			maximumInputBytes: 10000000,
			pricing: null,
		});
		await createSourceTemplateUpload(
			{ id: "owner" },
			{ templateKey: "original-rap", contentType: "image/png", byteSize: 100 },
		);
		expect(sourceTemplateAccess).toHaveBeenCalledWith(
			{ userId: "owner", role: undefined },
			"original-rap",
			{},
			process.env,
			{ forUpload: true },
		);
		vi.mocked(sourceTemplateAccess).mockResolvedValueOnce({
			available: false,
			reasons: ["VIDEO_TEMPLATE_DISABLED"],
			maximumInputBytes: 10000000,
			pricing: null,
		});
		await expect(
			createSourceTemplateUpload(
				{ id: "owner" },
				{ templateKey: "original-rap", contentType: "image/png", byteSize: 100 },
			),
		).rejects.toThrow("VIDEO_TEMPLATE_DISABLED");
	});
});
