import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	preview: vi.fn(),
	previewPost: vi.fn(),
	draft: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("@repo/database", () => ({ getClaimedGenerationDraft: mocks.draft }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("404");
	},
	permanentRedirect: (target: string) => {
		throw new Error(`308:${target}`);
	},
}));
vi.mock("../modules/effects/lib/content", async (importOriginal) => ({
	...(await importOriginal<typeof import("../modules/effects/lib/content")>()),
	getEffectPreviewContent: mocks.preview,
}));
vi.mock("../modules/public-content/lib/content", async (importOriginal) => ({
	...(await importOriginal<typeof import("../modules/public-content/lib/content")>()),
	getPhotoIdeaForPreview: mocks.previewPost,
}));
vi.mock("../modules/public-content/components/PhotoIdeaArticle", () => ({
	PhotoIdeaArticle: () => null,
}));

import * as blogContent from "../modules/public-content/lib/content";
import { legacyPhotoIdeaRedirect } from "../modules/public-content/lib/photo-idea-legacy";
import PreviewPage, { metadata as previewMetadata } from "./(public)/effects-preview/[slug]/page";
import { GET as legacyEffect } from "./(public)/effects/[slug]/route";

const recipe = { id: "1980s-ai-photo", slug: "1980s-ai-photo", status: "draft" };

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

const request = (slug = "1980s-ai-photo", cookie?: string) =>
	new NextRequest(`https://ezimageai.test/effects/${slug}`, {
		headers: cookie ? { cookie } : undefined,
	});

describe("Photo Idea migration and preview boundaries", () => {
	it("permanently redirects a published legacy detail to its unique Blog article", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		const response = await legacyEffect(request(), {
			params: Promise.resolve({ slug: "1980s-ai-photo" }),
		});
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe("https://ezimageai.test/blog/1980s-ai-photo");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(mocks.session).not.toHaveBeenCalled();
		expect(mocks.draft).not.toHaveBeenCalled();
	});
	it("preserves only registered preset, article source, internal entry and interface language", () => {
		expect(
			legacyPhotoIdeaRedirect("1980s-ai-photo", {
				preset: "family-snapshot",
				source: "ai-image-editing-prompts",
				from: "home",
				lang: "de",
				prompt: "private",
				token: "private",
			}),
		).toBe(
			"/blog/1980s-ai-photo?preset=family-snapshot&source=ai-image-editing-prompts&from=home&lang=de",
		);
		expect(
			legacyPhotoIdeaRedirect("1980s-ai-photo", {
				preset: "unknown",
				source: "unpublished",
				from: "https://evil.test",
				lang: "unknown",
				resume: "text",
			}),
		).toBe("/blog/1980s-ai-photo?resume=text");
		expect(
			legacyPhotoIdeaRedirect("1980s-ai-photo", {
				preset: ["studio-portrait", "family-snapshot"],
				source: ["ai-image-editing-prompts"],
				lang: ["fr"],
			}),
		).toBe("/blog/1980s-ai-photo");
	});
	it("returns 404 for unknown, draft or unavailable article/recipe identities", async () => {
		await expect(
			legacyEffect(request("missing"), { params: Promise.resolve({ slug: "missing" }) }),
		).rejects.toThrow("404");
		vi.spyOn(blogContent, "getPublishedPhotoIdeaBySlug").mockReturnValue(null);
		await expect(
			legacyEffect(request(), { params: Promise.resolve({ slug: "1980s-ai-photo" }) }),
		).rejects.toThrow("404");
		expect(mocks.preview).not.toHaveBeenCalled();
	});
	it("transfers only a registered user's owned claimed draft to the new scoped path", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		mocks.session.mockResolvedValue({ user: { id: "owner", isAnonymous: false } });
		mocks.draft.mockResolvedValue({ input: { prompt: "private" } });
		const response = await legacyEffect(
			request("1980s-ai-photo", "media_claimed_draft=owned-draft"),
			{ params: Promise.resolve({ slug: "1980s-ai-photo" }) },
		);
		expect(mocks.draft).toHaveBeenCalledWith({ draftId: "owned-draft", userId: "owner" }, {});
		const cookies = response.headers.getSetCookie();
		expect(
			cookies.some(
				(cookie) =>
					cookie.includes("media_claimed_draft=owned-draft") &&
					cookie.includes("Path=/blog/1980s-ai-photo") &&
					cookie.includes("HttpOnly"),
			),
		).toBe(true);
		expect(
			cookies.some(
				(cookie) => cookie.includes("Path=/effects/1980s-ai-photo") && cookie.includes("Max-Age=0"),
			),
		).toBe(true);
		expect(response.headers.get("location")).not.toContain("draft");
	});
	it.each([
		null,
		{ user: { id: "guest", isAnonymous: true } },
		{ user: { id: "other", isAnonymous: false } },
	])("does not transfer an unauthenticated, guest or unowned draft", async (session) => {
		mocks.session.mockResolvedValue(session);
		mocks.draft.mockResolvedValue(null);
		const response = await legacyEffect(
			request("1980s-ai-photo", "media_claimed_draft=other-draft"),
			{ params: Promise.resolve({ slug: "1980s-ai-photo" }) },
		);
		expect(response.status).toBe(308);
		expect(response.headers.getSetCookie()).toEqual([]);
	});
	it.each([null, { user: { role: "user" } }, { user: { role: "admin", isAnonymous: true } }])(
		"authorizes preview before reading any draft",
		async (session) => {
			mocks.session.mockResolvedValue(session);
			await expect(
				PreviewPage({
					params: Promise.resolve({ slug: "1980s-ai-photo" }),
					searchParams: Promise.resolve({}),
				}),
			).rejects.toThrow("404");
			expect(mocks.preview).not.toHaveBeenCalled();
			expect(mocks.previewPost).not.toHaveBeenCalled();
		},
	);
	it("previews the same article renderer for an administrator and stays noindex", async () => {
		mocks.session.mockResolvedValue({ user: { role: "admin", isAnonymous: false } });
		mocks.preview.mockReturnValue(recipe);
		mocks.previewPost.mockReturnValue({ id: "1980s-ai-photo", published: false });
		const page = await PreviewPage({
			params: Promise.resolve({ slug: "1980s-ai-photo" }),
			searchParams: Promise.resolve({ preset: "studio-portrait" }),
		});
		expect(page.props.preview).toBe(true);
		expect(page.props.recipe).toBe(recipe);
		expect(page.props.post.published).toBe(false);
		expect(previewMetadata.robots).toEqual({ index: false, follow: false });
	});
});
