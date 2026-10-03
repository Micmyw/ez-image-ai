import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getFeaturedPhotoIdeas = vi.hoisted(() => vi.fn<() => { slug: string; title: string }[]>());

vi.mock("../../../public-content/lib/content", () => ({ getFeaturedPhotoIdeas }));

vi.mock("next/navigation", () => ({
	usePathname: () => "/blog/1980s-ai-photo",
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ prefetch: vi.fn() }),
}));
vi.mock("next-intl", () => ({
	useLocale: () => "en",
	useTranslations: (namespace?: string) => (key: string) =>
		[namespace, key].filter(Boolean).join("."),
}));
vi.mock("@shared/hooks/use-media-query", () => ({ useMediaQuery: () => false }));
vi.mock("@repo/ui/components/logo", () => ({ Logo: () => <span>EzImageAI</span> }));
vi.mock("./HeaderPurchaseActions", () => ({ HeaderPurchaseActions: () => null }));
vi.mock("./PublicHeaderAccount", () => ({ PublicHeaderAccount: () => null }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { media: { getPublicCatalog: vi.fn() } },
}));
vi.mock("fumadocs-ui/layouts/docs", () => ({
	useDocsLayout: () => ({
		slots: {
			sidebar: {
				trigger: ({ children, ...props }: { children: ReactNode }) => (
					<button {...props}>{children}</button>
				),
			},
		},
	}),
}));

import { DocsHeader } from "../../../docs/components/DocsHeader";
import { PublicFooterLinks } from "../../../public-content/components/PublicFooterLinks";
import { PublicPageShell } from "../../../public-content/components/PublicPageShell";
import { StudioToolNavigation } from "./StudioToolNavigation";

async function renderNavigation(children: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
	client.setQueryData(["media-catalog"], {
		products: [
			{ key: "image-gpt-image-2", skuMatrix: { cells: [{}] } },
			{ key: "image-seedream-5-lite", skuMatrix: { cells: [] } },
		],
	});
	try {
		const stream = await renderToReadableStream(
			<QueryClientProvider client={client}>{children}</QueryClientProvider>,
		);
		return await new Response(stream).text();
	} finally {
		client.clear();
	}
}

describe("public navigation taxonomy", () => {
	beforeEach(() => {
		getFeaturedPhotoIdeas.mockReset();
		getFeaturedPhotoIdeas.mockReturnValue([
			{ slug: "1980s-ai-photo", title: "1980s AI Photo Ideas & Prompts" },
		]);
	});

	it("gives mobile readers separate image, tool, model, and resource groups", async () => {
		const markup = await renderNavigation(<StudioToolNavigation drawer />);
		const groups = [...markup.matchAll(/data-navigation-group="([^"]+)"/g)].map(
			(match) => match[1],
		);
		expect(groups).toEqual(["image", "tools", "models", "resources"]);
		const toolGroup = markup.match(
			/<details[^>]*data-navigation-group="tools"[\s\S]*?<\/details>/,
		)?.[0];
		expect(toolGroup).toContain('href="/photo-to-coloring-page"');
		expect(toolGroup).not.toContain("/blog");
		expect(toolGroup).not.toContain("/effects");
		const resourceGroup = markup.match(
			/<details[^>]*data-navigation-group="resources"[\s\S]*?<\/details>/,
		)?.[0];
		expect(resourceGroup).toContain('href="/blog"');
		expect(resourceGroup).toContain('href="/examples"');
		expect(resourceGroup).toContain('href="/docs"');
	});

	it("keeps available model routes and omits models without usable options", async () => {
		const markup = await renderNavigation(<StudioToolNavigation sidebar />);
		expect(markup).toContain('href="/models/gpt-image-2"');
		expect(markup).toContain('href="/models"');
		expect(markup).not.toContain('href="/models/seedream-5-lite"');
		expect(markup).not.toContain("/effects");
	});

	it.each([
		[
			"editorial pages",
			<PublicPageShell key="editorial-pages" title="Photo ideas" description="Ideas and guides">
				<p>Article</p>
			</PublicPageShell>,
		],
		["Docs", <DocsHeader key="docs" />],
	])("renders the same four menus on %s with the root query provider", async (_label, element) => {
		const markup = await renderNavigation(element);
		for (const group of ["image", "tools", "models", "resources"])
			expect(markup).toContain(`data-test="studio-${group}-menu"`);
		expect(markup).toContain('href="/pricing"');
		expect(markup).not.toContain('href="/effects"');
	});

	it("places the 1980s article under Resources and separates legal links", async () => {
		const markup = await renderNavigation(<PublicFooterLinks />);
		const resources = markup.match(/<nav[^>]*data-footer-group="resources"[\s\S]*?<\/nav>/)?.[0];
		const tools = markup.match(/<nav[^>]*data-footer-group="tools"[\s\S]*?<\/nav>/)?.[0];
		expect(resources).toContain('href="/blog/1980s-ai-photo"');
		expect(tools).not.toContain("1980s");
		expect(markup.match(/data-footer-group=/g)).toHaveLength(4);
		expect(markup).toContain('class="public-footer-legal"');
		expect(markup).toContain('href="/privacy"');
		expect(markup).toContain('href="/terms"');
		expect(markup).not.toContain("/effects");
	});

	it("does not expose a Photo Idea when the published featured reader returns none", async () => {
		getFeaturedPhotoIdeas.mockReturnValue([]);
		const markup = await renderNavigation(<PublicFooterLinks />);
		expect(getFeaturedPhotoIdeas).toHaveBeenCalledWith("en", 2);
		expect(markup).not.toContain("/blog/1980s-ai-photo");
		expect(markup).not.toContain("1980s AI Photo");
		expect(markup).toContain('href="/blog"');
		expect(markup.match(/data-footer-group=/g)).toHaveLength(4);
	});
});
