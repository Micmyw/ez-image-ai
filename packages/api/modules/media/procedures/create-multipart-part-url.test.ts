import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/storage", () => ({
	signMultipartPart: vi.fn(async () => "https://storage.test/part"),
}));
vi.mock("../lib/asset-authorization", () => ({ requireOwnedUploadSession: vi.fn() }));

import { auth } from "@repo/auth";
import { signMultipartPart } from "@repo/storage";

import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { createMultipartPartUrl } from "./create-multipart-part-url";

describe("createMultipartPartUrl", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1" },
			session: { id: "auth-session_1" },
		} as never);
		vi.mocked(requireOwnedUploadSession).mockResolvedValue({
			id: "upload_1",
			status: "PENDING",
			multipartUploadId: "multipart_1",
			stagingObjectKey: "users/user_1/staging/upload_1/nonce.mp4",
			expectedBytes: BigInt(16 * 1024 * 1024),
			expiresAt: new Date("2026-08-14T00:00:00Z"),
			asset: {
				objectKey: "users/user_1/assets/asset_1/versions/version_1/original.mp4",
			},
		} as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("signs multipart parts against the session staging key, never the immutable final key", async () => {
		await call(
			createMultipartPartUrl,
			{ sessionId: "upload_1", partNumber: 1 },
			{ context: { headers: new Headers() } },
		);

		expect(signMultipartPart).toHaveBeenCalledWith(
			expect.objectContaining({
				key: "users/user_1/staging/upload_1/nonce.mp4",
				uploadId: "multipart_1",
			}),
		);
	});
});
