import { call } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));
vi.mock("@repo/database/client", () => ({
	db: {
		mediaAsset: {
			findMany: vi.fn(() => {
				throw new Error("listAssets must use the moderation-aware database read boundary");
			}),
		},
	},
}));
vi.mock("@repo/database/media-assets", () => ({
	listReadableMediaAssets: vi.fn(),
}));

import { auth } from "@repo/auth";
import { listReadableMediaAssets } from "@repo/database/media-assets";

import { listAssets } from "./list-assets";

describe("listAssets", () => {
	beforeEach(() => {
		vi.stubEnv("MEDIA_SAFETY_ADAPTER", "sightengine");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "auth-session-1" },
		} as never);
		vi.mocked(listReadableMediaAssets).mockResolvedValue({
			items: [
				{
					id: "asset-1",
					kind: "IMAGE",
					mimeType: "image/png",
					byteSize: 1024n,
					createdAt: new Date("2026-08-24T00:00:00.000Z"),
					jobBindings: [{ jobId: "job-1" }],
				},
			],
			hasMore: false,
		} as never);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("lists only assets authorized by the current moderation boundary", async () => {
		const result = await call(
			listAssets,
			{ limit: 20, kind: "image" },
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({
			items: [
				{
					id: "asset-1",
					kind: "IMAGE",
					mimeType: "image/png",
					byteSize: "1024",
					createdAt: "2026-08-24T00:00:00.000Z",
					sourceJobId: "job-1",
				},
			],
			nextCursor: null,
		});
		expect(listReadableMediaAssets).toHaveBeenCalledWith(
			expect.objectContaining({
				ownerType: "USER",
				ownerId: "user-1",
				take: 20,
				mimeTypePrefix: "image/",
				verification: expect.objectContaining({
					provider: "sightengine",
					ruleVersion: "media-safety-2026-08-23.1",
					policyVersion: "media-policy-2026-08-23.1",
				}),
			}),
		);
	});
});
