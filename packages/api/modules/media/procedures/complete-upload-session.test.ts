import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
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
	headObject: vi.fn(),
	readMediaHeader: vi.fn(),
}));
vi.mock("../lib/asset-authorization", () => ({
	requireOwnedUploadSession: vi.fn(),
}));

import { auth } from "@repo/auth";
import { completeMediaUploadSessionTransaction } from "@repo/database/media-assets";
import {
	abortMultipartUpload,
	completeMultipartUpload,
	headObject,
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
			asset: {
				id: "asset_1",
				ownerType: "USER",
				ownerId: "user_1",
				objectKey: "users/user_1/assets/asset_1/original.mp4",
				mimeType: "video/mp4",
			},
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
			key: "users/user_1/assets/asset_1/original.mp4",
		});
	});
});
