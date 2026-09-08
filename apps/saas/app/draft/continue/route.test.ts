import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		mocks.claimRegistered.mockReturnValue(async () => ({ id: "draft_1" }));
		mocks.claimGuest.mockReturnValue(async () => ({ id: "draft_1" }));
	});

	afterEach(() => vi.unstubAllEnvs());

	it.each([
		{ anonymous: true, failed: false, target: "/try" },
		{ anonymous: false, failed: false, target: "/create" },
		{ anonymous: true, failed: true, target: "/try?draftError=unavailable" },
		{ anonymous: false, failed: true, target: "/create?draftError=unavailable" },
	])(
		"keeps $target on the canonical site when the internal request host differs",
		async ({ anonymous, failed, target }) => {
			vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://public.ezpic.test");
			mocks.getSession.mockResolvedValue({ user: { id: "session-user", isAnonymous: anonymous } });
			const selectedClaim = anonymous ? mocks.claimGuest : mocks.claimRegistered;
			if (failed)
				selectedClaim.mockReturnValue(async () => {
					throw new Error("DRAFT_UNAVAILABLE");
				});

			const response = await GET(new Request("http://localhost:3100/draft/continue"));

			expect(response.headers.get("location")).toBe(`https://public.ezpic.test${target}`);
			expect(selectedClaim).toHaveBeenCalledOnce();
			const cookies = response.headers.getSetCookie();
			expect(cookies).toEqual(
				expect.arrayContaining([
					expect.stringContaining("media_draft_claim=;"),
					expect.stringContaining("media_guest_bootstrap=;"),
				]),
			);
			if (!anonymous && !failed) {
				expect(cookies).toEqual(
					expect.arrayContaining([expect.stringContaining("media_claimed_draft=draft_1;")]),
				);
			}
		},
	);

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

	it("returns a no-store origin-only anonymous bootstrap POST for a missing session", async () => {
		mocks.getSession.mockResolvedValue(null);
		const response = await GET(new Request("https://app.test/draft/continue"));
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("origin");
		expect(body).toContain("/api/auth/sign-in/anonymous?handoff=1");
		expect(body).toContain('<meta name="referrer" content="origin">');
		expect(body).not.toMatch(/claimToken|media_draft_claim|prompt|asset/i);
	});
});
