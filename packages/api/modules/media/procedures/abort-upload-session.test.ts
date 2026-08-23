import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/media-assets", () => ({
	abortMediaUploadSessionTransaction: vi.fn(async () => ({ id: "asset_1", status: "DELETED" })),
}));
vi.mock("../lib/asset-authorization", () => ({ requireOwnedUploadSession: vi.fn() }));

import { auth } from "@repo/auth";
import { abortMediaUploadSessionTransaction } from "@repo/database/media-assets";

import { requireOwnedUploadSession } from "../lib/asset-authorization";
import { abortUploadSession } from "./abort-upload-session";

describe("abortUploadSession", () => {
	beforeEach(() => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user_1" },
			session: { id: "session_1" },
		} as never);
		vi.mocked(requireOwnedUploadSession).mockResolvedValue({
			id: "upload_1",
			assetId: "asset_1",
			status: "PENDING",
			multipartUploadId: "multipart_1",
			asset: { objectKey: "users/user_1/assets/asset_1/original.mp4" },
		} as never);
	});

	afterEach(() => vi.clearAllMocks());

	it("commits the abort and its durable cleanup request without calling storage", async () => {
		await expect(
			call(abortUploadSession, { sessionId: "upload_1" }, { context: { headers: new Headers() } }),
		).resolves.toEqual({ assetId: "asset_1", status: "DELETED" });
		expect(abortMediaUploadSessionTransaction).toHaveBeenCalledWith(
			{ sessionId: "upload_1", ownerId: "user_1" },
			expect.anything(),
		);
	});
});
