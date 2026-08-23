import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	claimMediaUploadSessionFinalizationTransaction: vi.fn(),
	completeMediaUploadSessionTransaction: vi.fn(),
	failMediaUploadSessionFinalizationTransaction: vi.fn(),
	MediaUploadSessionExpiredError: class MediaUploadSessionExpiredError extends Error {
		constructor() {
			super("Upload session expired");
		}
	},
}));
vi.mock("@repo/storage", () => ({
	abortMultipartUpload: vi.fn(async () => undefined),
	completeMultipartUpload: vi.fn(async () => undefined),
	deleteObject: vi.fn(async () => undefined),
	promoteStagedObject: vi.fn(),
}));
vi.mock("../lib/asset-authorization", () => ({ requireOwnedUploadSession: vi.fn() }));

import { auth } from "@repo/auth";
import {
	claimMediaUploadSessionFinalizationTransaction,
	completeMediaUploadSessionTransaction,
	failMediaUploadSessionFinalizationTransaction,
	MediaUploadSessionExpiredError,
} from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	completeMultipartUpload,
	deleteObject,
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
		vi.mocked(promoteStagedObject).mockResolvedValue({
			bytes: 16,
			sha256: "a".repeat(64),
			etag: "final-etag",
			versionId: "final-version",
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

	it("promotes only the claimed staging object into the private final key", async () => {
		await expect(
			call(completeUploadSession, { sessionId: "session_1" }, context),
		).resolves.toMatchObject({ id: "asset_1", status: "VERIFYING" });

		expect(promoteStagedObject).toHaveBeenCalledWith({
			staging: { bucket: "media", key: "users/user_1/staging/session_1/nonce.png" },
			final: {
				bucket: "media",
				key: "users/user_1/assets/asset_1/versions/version_1/original.png",
			},
			contentLength: 16,
			contentType: "image/png",
		});
		expect(completeMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				finalizationToken: "finalize_1",
				checksum: "a".repeat(64),
			}),
			expect.anything(),
		);
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
