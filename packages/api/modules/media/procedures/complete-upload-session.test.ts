import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	claimMediaUploadSessionFinalizationTransaction: vi.fn(),
	completeMediaUploadSessionTransaction: vi.fn(),
	failMediaUploadSessionTransaction: vi.fn(async () => undefined),
	expireMediaUploadSessionTransaction: vi.fn(async () => undefined),
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
	detectMediaType: vi.fn(() => "image/png"),
	headObject: vi.fn(),
	promoteStagedObject: vi.fn(),
	readMediaHeader: vi.fn(),
}));
vi.mock("../lib/asset-authorization", () => ({
	requireOwnedUploadSession: vi.fn(),
}));

import { auth } from "@repo/auth";
import {
	claimMediaUploadSessionFinalizationTransaction,
	completeMediaUploadSessionTransaction,
} from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	completeMultipartUpload,
	headObject,
	promoteStagedObject,
	readMediaHeader,
} from "@repo/storage";

import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { completeUploadSession } from "./complete-upload-session";

const context = { context: { headers: new Headers() } };

describe("completeUploadSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1" },
			session: { id: "auth_session_1" },
		} as never);
		vi.mocked(requireOwnedUploadSession).mockResolvedValue({
			id: "session_1",
			assetId: "asset_1",
			status: "PENDING",
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			multipartUploadId: "multipart_1",
			stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
		} as never);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValue({
			id: "session_1",
			status: "FINALIZING",
			finalizationToken: "finalize_1",
			asset: { id: "asset_1", objectKey: "users/user_1/assets/asset_1/original.mp4" },
		} as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("rejects an expired session before multipart completion or object inspection", async () => {
		await expect(
			call(
				completeUploadSession,
				{ sessionId: "session_1", parts: [{ partNumber: 1, etag: "etag-1" }] },
				context,
			),
		).rejects.toThrow(/expired/i);

		expect(abortMultipartUpload).toHaveBeenCalledOnce();
		expect(completeMultipartUpload).not.toHaveBeenCalled();
		expect(headObject).not.toHaveBeenCalled();
		expect(readMediaHeader).not.toHaveBeenCalled();
		expect(completeMediaUploadSessionTransaction).not.toHaveBeenCalled();
	});

	it("ends the session and deletes a finalized multipart object when validation fails", async () => {
		const { failMediaUploadSessionTransaction } = await import("@repo/database/media-assets");
		vi.mocked(requireOwnedUploadSession).mockResolvedValueOnce({
			id: "session_1",
			assetId: "asset_1",
			status: "PENDING",
			expectedBytes: BigInt(16 * 1024 * 1024),
			expiresAt: new Date("2026-08-15T00:00:00Z"),
			multipartUploadId: "multipart_1",
			stagingObjectKey: "users/user_1/staging/session_1/nonce.mp4",
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
		} as never);
		vi.mocked(headObject).mockResolvedValueOnce({
			contentLength: 17,
			contentType: "video/mp4",
			etag: "etag",
			metadata: {},
		});
		vi.mocked(readMediaHeader).mockResolvedValueOnce(
			Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
		);
		vi.mocked(promoteStagedObject).mockRejectedValueOnce(
			new Error("Staging object size does not match the upload session"),
		);

		await expect(
			call(
				completeUploadSession,
				{
					sessionId: "session_1",
					parts: [
						{ partNumber: 1, etag: "etag-1" },
						{ partNumber: 2, etag: "etag-2" },
					],
				},
				context,
			),
		).rejects.toThrow(/size/i);

		expect(completeMultipartUpload).toHaveBeenCalledOnce();
		expect(failMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session_1", ownerId: "user_1" }),
			expect.anything(),
		);
		const { deleteObject } = await import("@repo/storage");
		expect(deleteObject).toHaveBeenCalledWith({
			bucket: "media",
			key: "users/user_1/staging/session_1/nonce.mp4",
		});
	});

	it("promotes the verified staging object into the private final asset key", async () => {
		const { claimMediaUploadSessionFinalizationTransaction } =
			await import("@repo/database/media-assets");
		vi.mocked(requireOwnedUploadSession).mockResolvedValueOnce({
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
		} as never);
		vi.mocked(claimMediaUploadSessionFinalizationTransaction).mockResolvedValueOnce({
			id: "session_1",
			status: "FINALIZING",
			finalizationToken: "finalize_1",
			asset: {
				id: "asset_1",
				objectKey: "users/user_1/assets/asset_1/versions/version_1/original.png",
				mimeType: "image/png",
			},
		} as never);
		vi.mocked(promoteStagedObject).mockResolvedValueOnce({
			bytes: 16,
			sha256: "a".repeat(64),
			etag: "final-etag",
			versionId: "final-version",
		});
		vi.mocked(completeMediaUploadSessionTransaction).mockResolvedValueOnce({
			id: "asset_1",
			status: "VERIFYING",
			mimeType: "image/png",
			byteSize: 16n,
		} as never);
		vi.mocked(headObject).mockResolvedValueOnce({
			contentLength: 16,
			contentType: "image/png",
			etag: "staging-etag",
			metadata: {},
		});
		vi.mocked(readMediaHeader).mockResolvedValueOnce(
			Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
		);

		await call(completeUploadSession, { sessionId: "session_1" }, context);

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
				checksum: "a".repeat(64),
				storageEtag: "final-etag",
				storageVersionId: "final-version",
			}),
			expect.anything(),
		);
	});
});
