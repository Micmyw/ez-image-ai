import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), published: vi.fn(), preview: vi.fn() }));
vi.mock("@auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("404");
	},
}));
vi.mock("../modules/effects/lib/content", () => ({
	getPublishedEffectBySlug: mocks.published,
	getEffectPreviewContent: mocks.preview,
}));
vi.mock("../modules/effects/components/EffectDetailPage", () => ({ EffectDetailPage: () => null }));

import PreviewPage from "./(public)/effects-preview/[slug]/page";
import EffectPage, { generateMetadata } from "./(public)/effects/[slug]/page";

const effect = {
	id: "test-effect",
	slug: "test-effect",
	title: "A test effect",
	status: "published",
	seoTitle: "A tested photo recipe",
	seoDescription: "A recipe description.",
	cover: { src: "/images/effects/test/cover.webp", alt: "Test cover", width: 800, height: 1000 },
};

afterEach(() => {
	vi.resetAllMocks();
	vi.unstubAllEnvs();
});

describe("Effects public and protected route boundaries", () => {
	it("returns 404 without draft metadata on public draft and unknown paths", async () => {
		mocks.published.mockReturnValue(null);
		const props = {
			params: Promise.resolve({ slug: "1980s-ai-photo" }),
			searchParams: Promise.resolve({}),
		};
		await expect(EffectPage(props)).rejects.toThrow("404");
		await expect(generateMetadata(props)).rejects.toThrow("404");
		expect(mocks.preview).not.toHaveBeenCalled();
	});
	it("uses one absolute canonical regardless of preset or source parameters", async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://ezimageai.test");
		mocks.published.mockReturnValue(effect);
		const metadata = await generateMetadata({
			params: Promise.resolve({ slug: effect.slug }),
			searchParams: Promise.resolve({ preset: "one", source: "guide" }),
		});
		expect(metadata.alternates?.canonical).toBe("https://ezimageai.test/effects/test-effect");
		expect(metadata.robots).toEqual({ index: true, follow: true });
		expect(metadata.openGraph?.images).toEqual([
			{ url: effect.cover.src, width: 800, height: 1000, alt: "Test cover" },
		]);
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
		},
	);
	it("passes only an authenticated administrator through the preview reader", async () => {
		mocks.session.mockResolvedValue({ user: { role: "admin", isAnonymous: false } });
		mocks.preview.mockReturnValue({ ...effect, status: "draft" });
		const page = await PreviewPage({
			params: Promise.resolve({ slug: "1980s-ai-photo" }),
			searchParams: Promise.resolve({ preset: "one" }),
		});
		expect(page.props.preview).toBe(true);
		expect(page.props.presetId).toBe("one");
	});
	it("drops unregistered internal source values before analytics", async () => {
		mocks.published.mockReturnValue(effect);
		const page = await EffectPage({
			params: Promise.resolve({ slug: effect.slug }),
			searchParams: Promise.resolve({ from: "https://private.example/image?token=x" }),
		});
		expect(page.props.internalSource).toBeUndefined();
	});
});
