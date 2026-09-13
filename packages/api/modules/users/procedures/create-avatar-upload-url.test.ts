import { call } from "@orpc/server";
import { auth } from "@repo/auth";
import { getSignedUploadUrl } from "@repo/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("@repo/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/storage")>()),
	getSignedUploadUrl: vi.fn(),
}));

import { createAvatarUploadUrl } from "./create-avatar-upload-url";

describe("avatar upload authorization", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "avatar-owner", isAnonymous: false, emailVerified: true },
			session: { id: "session-1" },
		} as never);
		vi.mocked(getSignedUploadUrl).mockResolvedValue("https://storage.test/bounded-avatar");
	});

	it.each([
		{},
		{ contentType: "image/png" },
		{ contentType: "image/png", contentLength: 0 },
		{ contentType: "image/png", contentLength: -1 },
		{ contentType: "image/png", contentLength: 1.5 },
		{ contentType: "image/png", contentLength: "100" },
		{ contentType: "image/png", contentLength: 2_000_001 },
		{ contentType: "image/svg+xml", contentLength: 100 },
		{ contentType: "image/png", contentLength: 100, ownerId: "another-owner" },
	])("rejects an unsafe upload declaration before signing: %j", async (input) => {
		await expect(
			call(createAvatarUploadUrl, input as never, { context: { headers: new Headers() } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(getSignedUploadUrl).not.toHaveBeenCalled();
	});

	it("signs a bounded PNG for the authenticated owner", async () => {
		await expect(
			call(createAvatarUploadUrl, { contentType: "image/png", contentLength: 2_000_000 } as never, {
				context: { headers: new Headers() },
			}),
		).resolves.toEqual({
			signedUploadUrl: "https://storage.test/bounded-avatar",
			path: "avatar-owner.png",
		});
		expect(getSignedUploadUrl).toHaveBeenCalledWith("avatar-owner.png", {
			bucket: "avatars",
			contentType: "image/png",
			contentLength: 2_000_000,
		});
	});
});
