import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	createMediaUploadSessionTransaction: vi.fn(async () => undefined),
}));
vi.mock("@repo/storage", () => ({
	createFinalAssetObjectKey: vi.fn(
		() => "users/user_1/assets/asset_1/versions/version_1/original.png",
	),
	createMultipartUpload: vi.fn(),
	createSignedUpload: vi.fn(async ({ key }) => `https://storage.test/${key}`),
	createStagingObjectKey: vi.fn(() => "users/user_1/staging/session_1/nonce.png"),
	getMediaByteLimit: vi.fn(() => 25 * 1024 * 1024),
}));
vi.mock("../lib/rate-limit", () => ({
	enforceMediaRateLimit: vi.fn(async () => undefined),
}));

import { auth } from "@repo/auth";
import { createMediaUploadSessionTransaction } from "@repo/database/media-assets";
import { createSignedUpload } from "@repo/storage";

import { createUploadSession } from "./create-upload-session";

describe("createUploadSession", () => {
	beforeEach(() => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1" },
			session: { id: "auth_session_1" },
		} as never);
	});

	it("signs only a staging key and persists a distinct immutable final key", async () => {
		const result = await call(
			createUploadSession,
			{ contentType: "image/png", byteSize: 100 },
			{ context: { headers: new Headers() } },
		);

		expect(result.method).toBe("PUT");
		expect(vi.mocked(createSignedUpload).mock.calls[0]?.[0].key).toContain("/staging/");
		expect(result.uploadUrl).toContain("/staging/");
		expect(createMediaUploadSessionTransaction).toHaveBeenCalledWith(
			expect.objectContaining({
				objectKey: expect.stringContaining("/assets/"),
				stagingObjectKey: expect.stringContaining("/staging/"),
			}),
			expect.anything(),
		);
	});
});
