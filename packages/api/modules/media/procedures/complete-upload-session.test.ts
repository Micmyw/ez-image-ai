import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	claimMediaUploadSessionFinalizationTransaction: vi.fn(),
	clearMediaUploadPromotionMultipartTransaction: vi.fn(),
	completeMediaUploadSessionTransaction: vi.fn(),
	failMediaUploadSessionFinalizationTransaction: vi.fn(),
	recordMediaUploadPromotionMultipartTransaction: vi.fn(),
	renewMediaUploadSessionFinalizationLeaseTransaction: vi.fn(),
	MediaUploadSessionExpiredError: class MediaUploadSessionExpiredError extends Error {
		constructor() {
			super("Upload session expired");
		}
	},
}));
vi.mock("@repo/storage", () => ({
	MediaValidationError: class MediaValidationError extends Error {
		readonly stage = "TRANSFER" as const;
		readonly retryable = false as const;

		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
			this.name = "MediaValidationError";
		}
	},
	abortMultipartUpload: vi.fn(async () => undefined),
	completeMultipartUpload: vi.fn(async () => undefined),
	deleteObject: vi.fn(async () => undefined),
	listMultipartUploads: vi.fn(async () => []),
	promoteStagedObject: vi.fn(),
}));
vi.mock("../lib/asset-authorization", () => ({ requireOwnedUploadSession: vi.fn() }));

import { auth } from "@repo/auth";
import {
	claimMediaUploadSessionFinalizationTransaction,
	clearMediaUploadPromotionMultipartTransaction,
	completeMediaUploadSessionTransaction,
	failMediaUploadSessionFinalizationTransaction,
	MediaUploadSessionExpiredError,
	recordMediaUploadPromotionMultipartTransaction,
	renewMediaUploadSessionFinalizationLeaseTransaction,
} from "@repo/database/media-assets";
import {
	MediaValidationError,
	abortMultipartUpload,
	completeMultipartUpload,
	deleteObject,
	listMultipartUploads,
	promoteStagedObject,
} from "@repo/storage";

import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { completeUploadSession } from "./complete-upload-session";

const context = { context: { headers: new Headers() } };

function uploadSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session_1",
		assetId: "asset_1",
		status: "PENDING",
		expectedBytes: 16n,
		expiresAt: new Date("2026-08-15T00:00:00Z"),
		multipartUploadId: null,
		stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
		asset: {
			id: "asset_1",
			ownerType: "USER",
			ownerId: "user_1",
			objectKey: "users/user_1/assets/asset_1/versions/version_1/original.png",
			mimeType: "image/png",
		},
		...overrides,
	};
}

function finalizationClaim(overrides: Record<string, unknown> = {}) {
	return {
		outcome: "CLAIMED",
		finalizationToken: "finalize_1",
		finalizationParts: null,
		multipartUploadId: null,
		stagingObjectKey: "users/user_1/staging/session_1/nonce.png",
		asset: {
			id: "asset_1",
			objectKey: "users/user_1/assets/asset_1/versions/version_1/original.png",
			mimeType: "image/png",
		},
		...overrides,
	};
}

describe("completeUploadSession", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1" },
			session: { id: "auth_session_1" },
		} as never);
		vi.mocked(requireOwnedUploadSession).mockResolvedValue(uploadSession() as never);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValue(
			finalizationClaim() as never,
		);
		vi.mocked(recordMediaUploadPromotionMultipartTransaction).mockImplementation(async (input) => ({
			multipartUploadId: input.multipartUploadId,
			promotionToken: input.promotionToken,
		}));
		vi.mocked(clearMediaUploadPromotionMultipartTransaction).mockResolvedValue(undefined);
		vi.mocked(renewMediaUploadSessionFinalizationLeaseTransaction).mockResolvedValue({
			finalizationLeaseExpiresAt: new Date("2026-08-14T00:05:00Z"),
		});
		vi.mocked(listMultipartUploads).mockResolvedValue(["stale-final-multipart"]);
		vi.mocked(promoteStagedObject).mockImplementation(async (input) => {
			await input.promotion?.onMultipartUploadCreated?.({ uploadId: "final-multipart-1" });
			return {
				bytes: 16,
				sha256: "a".repeat(64),
				etag: "final-etag",
				versionId: "final-version",
			};
		});
		vi.mocked(completeMediaUploadSessionTransaction).mockResolvedValue({
			id: "asset_1",
			status: "VERIFYING",
			mimeType: "image/png",
			byteSize: 16n,
		} as never);
		vi.mocked(failMediaUploadSessionFinalizationTransaction).mockResolvedValue({
			id: "asset_1",
			status: "DELETED",
		} as never);
		vi.mocked(abortMultipartUpload).mockResolvedValue(undefined);
		vi.mocked(completeMultipartUpload).mockResolvedValue(undefined);
		vi.mocked(deleteObject).mockResolvedValue(undefined);
	});

	afterEach(() => vi.useRealTimers());

	it("expires a pending upload before finalization and cleans only its staging key", async () => {
		vi.mocked(requireOwnedUploadSession).mockResolvedValueOnce(
			uploadSession({ expiresAt: new Date("2026-08-14T00:00:00Z") }) as never,
		);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockRejectedValueOnce(
			new MediaUploadSessionExpiredError(),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/expired/i,
		);
		expect(deleteObject).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/staging/session_1/nonce.png",
		});
		expect(claimMediaUploadSessionFinalizationTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session_1", ownerId: "user_1" }),
			expect.anything(),
		);
		expect(
			vi.mocked(claimMediaUploadSessionFinalizationTransaction).mock.calls[0]?.[0],
		).not.toHaveProperty("now");
		expect(promoteStagedObject).not.toHaveBeenCalled();
	});

	it("fences exact-key stale final multipart candidates before copying", async () => {
		await expect(
			call(completeUploadSession, { sessionId: "session_1" }, context),
		).resolves.toMatchObject({ id: "asset_1", status: "VERIFYING" });

		expect(listMultipartUploads).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/assets/asset_1/versions/version_1/original.png",
		});
		expect(renewMediaUploadSessionFinalizationLeaseTransaction).toHaveBeenCalledWith(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				finalizationToken: "finalize_1",
			},
			expect.anything(),
		);
		expect(abortMultipartUpload).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/assets/asset_1/versions/version_1/original.png",
			uploadId: "stale-final-multipart",
		});
		expect(
			vi.mocked(renewMediaUploadSessionFinalizationLeaseTransaction).mock.invocationCallOrder[0],
		).toBeLessThan(vi.mocked(abortMultipartUpload).mock.invocationCallOrder[0] ?? Infinity);
		expect(promoteStagedObject).toHaveBeenCalledWith(
			expect.objectContaining({
				staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
				final: {
					bucket: "media",
					key: "users/user_1/assets/asset_1/versions/version_1/original.png",
				},
				contentLength: 16,
				contentType: "image/png",
				promotion: expect.objectContaining({
					onMultipartUploadCreated: expect.any(Function),
				}),
			}),
		);
		expect(recordMediaUploadPromotionMultipartTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session_1",
				ownerId: "user_1",
				finalizationToken: "finalize_1",
				multipartUploadId: "final-multipart-1",
				promotionToken: expect.any(String),
			}),
			expect.anything(),
		);
		expect(completeMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				finalizationToken: "finalize_1",
				checksum: "a".repeat(64),
				promotion: {
					multipartUploadId: "final-multipart-1",
					promotionToken: expect.any(String),
				},
			}),
			expect.anything(),
		);
	});

	it("reuses a durable final multipart upload without aborting it as stale", async () => {
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValueOnce(
			finalizationClaim({
				promotionMultipartUploadId: "durable-final-multipart",
				promotionToken: "durable-promotion-token",
			}) as never,
		);

		await expect(
			call(completeUploadSession, { sessionId: "session_1" }, context),
		).resolves.toMatchObject({ id: "asset_1" });

		expect(listMultipartUploads).not.toHaveBeenCalled();
		expect(renewMediaUploadSessionFinalizationLeaseTransaction).not.toHaveBeenCalled();
		expect(recordMediaUploadPromotionMultipartTransaction).not.toHaveBeenCalled();
		expect(promoteStagedObject).toHaveBeenCalledWith(
			expect.objectContaining({
				promotion: { uploadId: "durable-final-multipart" },
			}),
		);
		expect(completeMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				promotion: {
					multipartUploadId: "durable-final-multipart",
					promotionToken: "durable-promotion-token",
				},
			}),
			expect.anything(),
		);
	});

	it("clears only a missing durable final multipart before retrying with a fresh promotion", async () => {
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValueOnce(
			finalizationClaim({
				promotionMultipartUploadId: "lost-final-multipart",
				promotionToken: "lost-promotion-token",
			}) as never,
		);
		vi.mocked(promoteStagedObject)
			.mockRejectedValueOnce(
				Object.assign(new Error("final multipart expired"), { name: "NoSuchUpload" }),
			)
			.mockImplementationOnce(async (input) => {
				await input.promotion?.onMultipartUploadCreated?.({
					uploadId: "replacement-final-multipart",
				});
				return {
					bytes: 16,
					sha256: "a".repeat(64),
					etag: "final-etag",
					versionId: "final-version",
				};
			});

		await expect(
			call(completeUploadSession, { sessionId: "session_1" }, context),
		).resolves.toMatchObject({ id: "asset_1" });

		expect(clearMediaUploadPromotionMultipartTransaction).toHaveBeenCalledWith(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				finalizationToken: "finalize_1",
				multipartUploadId: "lost-final-multipart",
				promotionToken: "lost-promotion-token",
			},
			expect.anything(),
		);
		expect(listMultipartUploads).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/assets/asset_1/versions/version_1/original.png",
		});
		expect(recordMediaUploadPromotionMultipartTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ multipartUploadId: "replacement-final-multipart" }),
			expect.anything(),
		);
		expect(promoteStagedObject).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ promotion: { uploadId: "lost-final-multipart" } }),
		);
		expect(promoteStagedObject).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				promotion: expect.objectContaining({ onMultipartUploadCreated: expect.any(Function) }),
			}),
		);
	});

	it("does not abort candidates discovered before a lost finalization lease", async () => {
		vi.mocked(listMultipartUploads).mockResolvedValueOnce(["newer-claimant-multipart"]);
		vi.mocked(renewMediaUploadSessionFinalizationLeaseTransaction).mockRejectedValueOnce(
			new Error("Upload session finalization is not owned by this token"),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/not owned/i,
		);

		expect(listMultipartUploads).toHaveBeenCalledOnce();
		expect(abortMultipartUpload).not.toHaveBeenCalled();
		expect(promoteStagedObject).not.toHaveBeenCalled();
	});

	it("returns an in-progress response without starting a second promotion while another lease is active", async () => {
		vi.mocked(requireOwnedUploadSession).mockResolvedValueOnce(
			uploadSession({ status: "FINALIZING", expiresAt: new Date("2026-08-13T23:59:00Z") }) as never,
		);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValueOnce({
			outcome: "IN_PROGRESS",
			asset: { id: "asset_1" },
		} as never);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/in progress/i,
		);
		expect(promoteStagedObject).not.toHaveBeenCalled();
		expect(completeMediaUploadSessionTransaction).not.toHaveBeenCalled();
	});

	it("recovers a multipart finalization from persisted parts after multipart completion crashed", async () => {
		const persistedParts = [{ partNumber: 1, etag: "persisted-etag" }];
		vi.mocked(requireOwnedUploadSession).mockResolvedValueOnce(
			uploadSession({
				status: "FINALIZING",
				expectedBytes: BigInt(8 * 1024 * 1024),
				expiresAt: new Date("2026-08-13T23:59:00Z"),
				multipartUploadId: "multipart_1",
				stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
				asset: {
					id: "asset_1",
					ownerType: "USER",
					ownerId: "user_1",
					objectKey: "users/user_1/assets/asset_1/versions/version_1/original.mp4",
					mimeType: "video/mp4",
				},
			}) as never,
		);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValueOnce(
			finalizationClaim({
				multipartUploadId: "multipart_1",
				stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
				finalizationParts: persistedParts,
				asset: {
					id: "asset_1",
					objectKey: "users/user_1/assets/asset_1/versions/version_1/original.mp4",
					mimeType: "video/mp4",
				},
			}) as never,
		);
		vi.mocked(completeMultipartUpload).mockRejectedValueOnce(
			Object.assign(new Error("already completed"), { name: "NoSuchUpload" }),
		);
		vi.mocked(promoteStagedObject).mockResolvedValueOnce({
			bytes: 8 * 1024 * 1024,
			sha256: "b".repeat(64),
			etag: "final-etag",
			versionId: null,
		});
		vi.mocked(completeMediaUploadSessionTransaction).mockResolvedValueOnce({
			id: "asset_1",
			status: "VERIFYING",
			mimeType: "video/mp4",
			byteSize: BigInt(8 * 1024 * 1024),
		} as never);

		await expect(
			call(completeUploadSession, { sessionId: "session_1" }, context),
		).resolves.toMatchObject({ id: "asset_1" });
		expect(completeMultipartUpload).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/staging/session_1/nonce.mp4",
			uploadId: "multipart_1",
			parts: persistedParts,
		});
		expect(promoteStagedObject).toHaveBeenCalledOnce();
	});

	it("leaves a claimed session recoverable when database completion is temporarily unavailable", async () => {
		vi.mocked(completeMediaUploadSessionTransaction).mockRejectedValueOnce(
			new Error("database connection reset"),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/connection reset/i,
		);
		expect(promoteStagedObject).toHaveBeenCalledOnce();
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it("terminalizes a claimed session with a token CAS when staging is deterministically absent", async () => {
		vi.mocked(promoteStagedObject).mockRejectedValueOnce(
			Object.assign(new Error("staging object missing"), {
				name: "NoSuchKey",
				$metadata: { httpStatusCode: 404 },
			}),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/staging object missing/i,
		);
		expect(failMediaUploadSessionFinalizationTransaction).toHaveBeenCalledWith(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				finalizationToken: "finalize_1",
				reason: "UPLOAD_FINALIZATION_VALIDATION_FAILED",
			},
			expect.anything(),
		);
		expect(completeMediaUploadSessionTransaction).not.toHaveBeenCalled();
	});

	it("terminalizes a claimed session when staging bytes fail deterministic media validation", async () => {
		vi.mocked(promoteStagedObject).mockRejectedValueOnce(
			new MediaValidationError(
				"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
				"Provider output has an unsupported media signature",
			),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/unsupported media signature/i,
		);
		expect(failMediaUploadSessionFinalizationTransaction).toHaveBeenCalledWith(
			{
				sessionId: "session_1",
				ownerId: "user_1",
				finalizationToken: "finalize_1",
				reason: "UPLOAD_FINALIZATION_VALIDATION_FAILED",
			},
			expect.anything(),
		);
		expect(completeMediaUploadSessionTransaction).not.toHaveBeenCalled();
	});

	it("keeps a claimed session recoverable when staging inspection fails transiently", async () => {
		vi.mocked(promoteStagedObject).mockRejectedValueOnce(
			Object.assign(new Error("storage timeout"), {
				name: "TimeoutError",
				$metadata: { httpStatusCode: 503 },
			}),
		);

		await expect(call(completeUploadSession, { sessionId: "session_1" }, context)).rejects.toThrow(
			/storage timeout/i,
		);
		expect(failMediaUploadSessionFinalizationTransaction).not.toHaveBeenCalled();
	});
});
