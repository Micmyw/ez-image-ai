import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), detail: vi.fn() }));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({
	listAdminPromptContent: mocks.list,
	getAdminPromptContent: mocks.detail,
}));
vi.mock("@repo/database/client", () => ({ db: {} }));
import { adminPromptContentDetail, adminPromptContentList } from "./admin-prompt-content";

const context = () => ({ context: { headers: new Headers(), responseHeaders: new Headers() } });
const at = new Date("2026-11-14T00:00:00Z");
const result = () => ({ items: [], nextCursor: null, from: at, to: new Date(at.getTime() + 1000) });
beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({
		user: { id: "admin-from-session", role: "admin", isAnonymous: false },
		session: { id: "session" },
	});
	mocks.list.mockResolvedValue(result());
});

describe("administrator prompt content API", () => {
	it.each([null, "user"])("denies %s before any private read", async (role) => {
		mocks.session.mockResolvedValue(
			role ? { user: { id: "customer", role, isAnonymous: false }, session: {} } : null,
		);
		for (const [procedure, input] of [
			[adminPromptContentList, {}],
			[adminPromptContentDetail, { recordKind: "JOB", id: "job" }],
		] as const)
			await expect(
				call(procedure as typeof adminPromptContentList, input as never, context()),
			).rejects.toMatchObject({ code: role ? "FORBIDDEN" : "UNAUTHORIZED" });
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.detail).not.toHaveBeenCalled();
	});
	it("derives the administrator identity, disables caching and rejects oversized or spoofed input", async () => {
		const options = context();
		expect(
			await call(adminPromptContentList, { text: "balloon", ownerId: "owner" }, options),
		).toEqual(result());
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 25,
				outcome: "FAILURES",
				text: "balloon",
				ownerId: "owner",
			}),
			"admin-from-session",
			expect.anything(),
		);
		expect(options.context.responseHeaders.get("Cache-Control")).toBe("private, no-store");
		expect(options.context.responseHeaders.get("X-Robots-Tag")).toBe("noindex, nofollow");
		for (const input of [
			{ limit: 51 },
			{ text: "x".repeat(201) },
			{ actorUserId: "someone" },
			{ from: new Date("2025-01-01"), to: new Date("2026-01-01") },
		])
			await expect(call(adminPromptContentList, input as never, context())).rejects.toBeDefined();
	});
	it("maps a missing blocked audit or job to NOT_FOUND", async () => {
		mocks.detail.mockRejectedValue(new Error("ADMIN_PROMPT_CONTENT_NOT_FOUND"));
		await expect(
			call(adminPromptContentDetail, { recordKind: "BLOCKED_REQUEST", id: "missing" }, context()),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("accepts search filters in a POST body at the declared HTTP route", async () => {
		const headers = new Headers({ "content-type": "application/json" });
		const responseHeaders = new Headers();
		const handled = await new OpenAPIHandler({ prompts: adminPromptContentList }).handle(
			new Request("https://example.test/api/admin/media/prompt-content/search", {
				method: "POST",
				headers,
				body: JSON.stringify({ text: "balloon", email: "customer@example.test" }),
			}),
			{ prefix: "/api", context: { headers, responseHeaders } },
		);
		expect(handled.matched).toBe(true);
		expect(handled.response?.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({ text: "balloon", email: "customer@example.test" }),
			"admin-from-session",
			expect.anything(),
		);
	});
});
