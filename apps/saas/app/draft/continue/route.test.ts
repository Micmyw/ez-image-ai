import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	claimRegistered: vi.fn(),
	claimGuest: vi.fn(),
	headers: vi.fn(async () => new Headers()),
	effectReturn: vi.fn(),
}));

vi.mock("@auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/api/modules/media/procedures/claim-generation-draft", () => ({
	claimGenerationDraft: { callable: mocks.claimRegistered },
}));
vi.mock("@repo/api/modules/media/procedures/claim-guest-draft", () => ({
	claimGuestDraft: { callable: mocks.claimGuest },
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("../../../modules/effects/lib/editor-return.server", () => ({
	resolvePublishedEffectReturnPath: mocks.effectReturn,
}));

import { GET } from "./route";

describe("draft continuation identity router", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		mocks.claimRegistered.mockReturnValue(async () => ({ id: "draft_1" }));
		mocks.claimGuest.mockReturnValue(async () => ({ id: "draft_1" }));
		mocks.effectReturn.mockReturnValue(null);
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
	it.each(["/blog/1980s-ai-photo", "/effects/1980s-ai-photo"])(
		"keeps a registered draft and its cookie on the validated article route from %s",
		async (pathname) => {
			const savedReturn = `${pathname}?preset=studio-portrait`;
			const canonical = "/blog/1980s-ai-photo?preset=studio-portrait";
			mocks.getSession.mockResolvedValue({ user: { id: "user_1", isAnonymous: false } });
			mocks.effectReturn.mockReturnValue(canonical);
			const response = await GET(
				new Request("https://app.test/draft/continue", {
					headers: { cookie: `media_effect_return=${encodeURIComponent(savedReturn)}` },
				}),
			);
			expect(mocks.effectReturn).toHaveBeenCalledWith(savedReturn);
			expect(response.headers.get("location")).toBe(`https://app.test${canonical}`);
			expect(response.headers.getSetCookie().join("\n")).toContain("Path=/blog/1980s-ai-photo");
			expect(response.headers.getSetCookie().join("\n")).not.toContain("Path=/effects/");
		},
	);

	it("keeps an unavailable draft on its validated article and selected preset", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user_1", isAnonymous: false } });
		mocks.effectReturn.mockReturnValue("/blog/1980s-ai-photo?preset=studio-portrait");
		mocks.claimRegistered.mockReturnValue(async () => {
			throw new Error("DRAFT_UNAVAILABLE");
		});
		const response = await GET(new Request("https://app.test/draft/continue"));
		expect(response.headers.get("location")).toBe(
			"https://app.test/blog/1980s-ai-photo?preset=studio-portrait&draftError=unavailable",
		);
		expect(response.headers.getSetCookie().join("\n")).not.toContain("media_claimed_draft=");
	});

	it("falls back to the ordinary editor when an article return fails publication validation", async () => {
		mocks.getSession.mockResolvedValue({ user: { id: "user_1", isAnonymous: false } });
		const savedReturn = "/blog/unpublished-photo-idea?preset=studio-portrait";
		const response = await GET(
			new Request("https://app.test/draft/continue", {
				headers: { cookie: `media_effect_return=${encodeURIComponent(savedReturn)}` },
			}),
		);
		expect(mocks.effectReturn).toHaveBeenCalledWith(savedReturn);
		expect(response.headers.get("location")).toBe("https://app.test/create");
		expect(response.headers.getSetCookie().join("\n")).toContain("Path=/create");
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
