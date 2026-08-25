import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	listImageEditSessionsForOwner: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database", () => ({
	listImageEditSessionsForOwner: mocks.listImageEditSessionsForOwner,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { listEditSessions } from "./list-edit-sessions";

describe("listEditSessions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "auth-session-1" },
		} as never);
	});

	it("lists only USER sessions for the authenticated owner with an opaque stable cursor", async () => {
		mocks.listImageEditSessionsForOwner.mockResolvedValue({
			items: [
				{
					id: "session-2",
					rootAssetId: "asset-root-2",
					title: "Product hero",
					createdAt: new Date("2026-08-25T00:00:00.000Z"),
					updatedAt: new Date("2026-08-25T02:00:00.000Z"),
					_count: { jobs: 3 },
				},
			],
			hasMore: true,
		});

		const result = await call(
			listEditSessions,
			{ limit: 1 },
			{ context: { headers: new Headers() } },
		);

		expect(result.items).toEqual([
			{
				id: "session-2",
				rootAssetId: "asset-root-2",
				title: "Product hero",
				versionCount: 3,
				createdAt: "2026-08-25T00:00:00.000Z",
				updatedAt: "2026-08-25T02:00:00.000Z",
			},
		]);
		expect(result.nextCursor).toEqual(expect.any(String));
		expect(result.nextCursor).not.toContain("2026-08-25");
		expect(mocks.listImageEditSessionsForOwner).toHaveBeenCalledWith(
			{
				ownerType: "USER",
				ownerId: "user-1",
				take: 1,
				cursor: undefined,
			},
			expect.anything(),
		);
	});
});
