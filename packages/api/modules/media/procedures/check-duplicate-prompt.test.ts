import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), findMany: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@repo/database/client", () => ({ db: { generationJob: { findMany: mocks.findMany } } }));
vi.mock(
	"@repo/database",
	async () => import("../../../../database/prisma/queries/media/prompt-records"),
);

import { checkDuplicatePrompt } from "./check-duplicate-prompt";

const context = { headers: new Headers(), responseHeaders: new Headers() };
describe("checkDuplicatePrompt", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.getSession.mockResolvedValue({ user: { id: "owner-a" }, session: { id: "session-a" } });
		mocks.findMany.mockResolvedValue([
			{ id: "recent-job", inputSnapshot: { kind: "image-to-image", prompt: "A café\nportrait" } },
		]);
	});
	it("matches whitespace and canonical Unicode without returning private snapshots", async () => {
		await expect(
			call(checkDuplicatePrompt, { prompt: " A cafe\u0301  portrait " }, { context }),
		).resolves.toEqual({ match: { jobId: "recent-job" } });
		expect(context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: { ownerType: "USER", ownerId: "owner-a", executionEngine: "legacy" },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 20,
			select: { id: true, inputSnapshot: true },
		});
	});
	it("does not label different wording as identical", async () => {
		await expect(
			call(checkDuplicatePrompt, { prompt: "A café portrait with flowers" }, { context }),
		).resolves.toEqual({ match: null });
	});
	it.each([null, { user: { id: "guest", isAnonymous: true }, session: { id: "guest-session" } }])(
		"requires a registered authenticated owner",
		async (session) => {
			mocks.getSession.mockResolvedValue(session);
			await expect(
				call(checkDuplicatePrompt, { prompt: "hello" }, { context }),
			).rejects.toMatchObject({ code: "UNAUTHORIZED" });
			expect(mocks.findMany).not.toHaveBeenCalled();
		},
	);
	it.each([" ", "a".repeat(10_001)])("rejects invalid prompt length", async (prompt) => {
		await expect(call(checkDuplicatePrompt, { prompt }, { context })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});
