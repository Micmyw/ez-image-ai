import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	renameImageEditSessionForOwner: vi.fn(),
}));

vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database", () => ({
	renameImageEditSessionForOwner: mocks.renameImageEditSessionForOwner,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));

import { renameEditSession } from "./rename-edit-session";

describe("renameEditSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { id: "auth-session-1" },
		} as never);
	});

	it("renames only the authenticated user's session with a normalized title", async () => {
		mocks.renameImageEditSessionForOwner.mockResolvedValue({
			id: "session-1",
			title: "Hero refinements",
			updatedAt: new Date("2026-08-25T03:00:00.000Z"),
		});

		const result = await call(
			renameEditSession,
			{ sessionId: "session-1", title: "  Hero refinements  " },
			{ context: { headers: new Headers() } },
		);

		expect(result).toEqual({
			id: "session-1",
			title: "Hero refinements",
			updatedAt: "2026-08-25T03:00:00.000Z",
		});
		expect(mocks.renameImageEditSessionForOwner).toHaveBeenCalledWith(
			{
				ownerType: "USER",
				ownerId: "user-1",
				sessionId: "session-1",
				title: "Hero refinements",
			},
			expect.anything(),
		);
	});

	it("returns NOT_FOUND without revealing a foreign session", async () => {
		mocks.renameImageEditSessionForOwner.mockResolvedValue(null);

		await expect(
			call(
				renameEditSession,
				{ sessionId: "session-foreign", title: "Stolen" },
				{ context: { headers: new Headers() } },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
