import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	claimRegistered: vi.fn(),
	claimGuest: vi.fn(),
	headers: vi.fn(async () => new Headers()),
}));

vi.mock("@auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/modules/media/procedures/claim-generation-draft", () => ({
	claimGenerationDraft: { callable: mocks.claimRegistered },
}));
vi.mock("@repo/api/modules/media/procedures/claim-guest-draft", () => ({
	claimGuestDraft: { callable: mocks.claimGuest },
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));

import { GET } from "./route";

describe("draft continuation identity router", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.claimRegistered.mockReturnValue(async () => ({ id: "draft_1" }));
		mocks.claimGuest.mockReturnValue(async () => ({ id: "draft_1" }));
	});

	it("claims for a registered session and routes to the existing editor", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user_1", isAnonymous: false } });
		const response = await GET(new Request("https://app.test/draft/continue"));

		expect(response.headers.get("location")).toBe("https://app.test/create");
		expect(mocks.claimRegistered).toHaveBeenCalledOnce();
		expect(mocks.claimGuest).not.toHaveBeenCalled();
	});

	it("claims only a guest-ready bootstrap draft for an anonymous session", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "guest_1", isAnonymous: true } });
		const response = await GET(new Request("https://app.test/draft/continue"));

		expect(response.headers.get("location")).toBe("https://app.test/try");
		expect(mocks.claimGuest).toHaveBeenCalledOnce();
		expect(mocks.claimRegistered).not.toHaveBeenCalled();
	});

	it("returns a no-store same-origin anonymous bootstrap POST for a missing session", async () => {
		mocks.getSession.mockResolvedValue(null);
		const response = await GET(new Request("https://app.test/draft/continue"));
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(body).toContain("/api/auth/sign-in/anonymous?handoff=1");
		expect(body).not.toMatch(/claimToken|media_draft_claim|prompt|asset/i);
	});
});
