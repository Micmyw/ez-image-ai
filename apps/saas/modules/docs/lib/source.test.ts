import type { Metadata } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const canonicalOrigin = "https://www.ezpic.test";
const requiredDocsPaths = [
	"/docs",
	"/docs/quick-start",
	"/docs/image-editing",
	"/docs/credits",
	"/docs/privacy",
] as const;
const reservedDocsSlugs = ["api", "og", "llms.txt", "llms-full.txt", "llms.mdx"] as const;

type DocsPage = {
	data: {
		description?: string;
		title: string;
	};
	slugs: string[];
	url: string;
};

type DocsSourceModule = {
	getPageImage: (page: DocsPage) => { url: string };
	isReservedDocsSlug: (slug: string) => boolean;
	source: {
		getPages: () => DocsPage[];
	};
};

type DocsSearchRouteModule = {
	GET: (request: Request) => Response | Promise<Response>;
};

type DocsPageModule = {
	generateMetadata?: (props: unknown) => Metadata | Promise<Metadata>;
};

describe("same-origin Docs source", () => {
	beforeEach(() => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", canonicalOrigin);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("publishes the five required factual Docs topics at stable /docs paths", async () => {
		const sourceModule = await loadOptionalModule<DocsSourceModule>("./source");
		expect(sourceModule, "the SaaS Docs source module must exist").not.toBeNull();
		if (!sourceModule) return;

		const pages = sourceModule.source.getPages();
		const pageUrls = pages.map(({ url }) => url);
		for (const path of requiredDocsPaths) {
			expect(pageUrls, `${path} must be a generated Docs page`).toContain(path);
		}
		expect(new Set(pageUrls).size).toBe(pageUrls.length);

		for (const page of pages) {
			expect(page.url === "/docs" || page.url.startsWith("/docs/")).toBe(true);
			expect(page.data.title.trim()).not.toBe("");
			expect(page.data.description?.trim()).toBeTruthy();
			const expectedImageUrl = `${page.url === "/docs" ? "/docs/og" : page.url.replace("/docs", "/docs/og")}/image.png`;
			expect(sourceModule.getPageImage(page).url).toBe(expectedImageUrl);
			expect(JSON.stringify(page.data)).not.toMatch(/acme|lorem ipsum|my app/i);
		}
	});

	it("exports a validator that reserves every endpoint-owned top-level slug", async () => {
		const sourceModule = await loadOptionalModule<DocsSourceModule>("./source");
		expect(sourceModule, "the SaaS Docs source module must exist").not.toBeNull();
		if (!sourceModule) return;

		expect(sourceModule.isReservedDocsSlug).toBeTypeOf("function");
		for (const slug of reservedDocsSlugs) {
			expect(sourceModule.isReservedDocsSlug(slug), `${slug} must be reserved`).toBe(true);
		}
		for (const slug of ["quick-start", "image-editing", "credits", "privacy"]) {
			expect(sourceModule.isReservedDocsSlug(slug), `${slug} must remain usable`).toBe(false);
		}
	});

	it("serves search results from the namespaced Docs endpoint", async () => {
		const searchRoute = await loadOptionalModule<DocsSearchRouteModule>(
			"../../../app/docs/api/search/route",
		);
		expect(searchRoute, "/docs/api/search must have a route handler").not.toBeNull();
		if (!searchRoute) return;

		const response = await searchRoute.GET(
			new Request("https://www.ezpic.test/docs/api/search?query=EzPic"),
		);
		expect(response.status).toBe(200);
		const payload = await response.text();
		expect(payload).toContain("/docs");
		expect(payload).not.toMatch(/acme|lorem ipsum|my app/i);
	});

	it.each([
		{ path: "/docs", slug: undefined },
		{ path: "/docs/quick-start", slug: ["quick-start"] },
	] as const)("exports explicit noindex metadata for $path", async ({ path, slug }) => {
		const pageModule = await loadOptionalModule<DocsPageModule>(
			"../../../app/docs/[[...slug]]/page",
		);
		expect(pageModule, "the nested SaaS Docs page module must exist").not.toBeNull();
		if (!pageModule) return;

		expect(pageModule.generateMetadata).toBeTypeOf("function");
		if (!pageModule.generateMetadata) return;
		const metadata = await pageModule.generateMetadata({
			params: Promise.resolve({ slug }),
		});
		expect(canonicalUrl(metadata)).toBe(new URL(path, canonicalOrigin).href);
		expect(metadata.title).toBeTruthy();
		expect(String(metadata.description ?? "").trim()).not.toBe("");
		expect(JSON.stringify(metadata)).not.toMatch(/acme|lorem ipsum|my app/i);
		const directives = metadataRobotsDirectives(metadata);
		expect(directives.has("noindex")).toBe(true);
		expect(directives.has("follow")).toBe(true);
	});
});

function canonicalUrl(metadata: Metadata): string | undefined {
	const canonical = metadata.alternates?.canonical;
	if (typeof canonical === "string") return canonical;
	if (canonical instanceof URL) return canonical.href;
	if (canonical && typeof canonical === "object" && "url" in canonical) {
		return String(canonical.url);
	}
	return undefined;
}

function metadataRobotsDirectives(metadata: Metadata): Set<string> {
	if (typeof metadata.robots === "string") {
		return new Set(metadata.robots.split(",").map((directive) => directive.trim().toLowerCase()));
	}

	const directives = new Set<string>();
	if (metadata.robots?.index === true) directives.add("index");
	if (metadata.robots?.index === false) directives.add("noindex");
	if (metadata.robots?.follow === true) directives.add("follow");
	if (metadata.robots?.follow === false) directives.add("nofollow");
	return directives;
}

async function loadOptionalModule<T>(specifier: string): Promise<T | null> {
	try {
		return (await import(/* @vite-ignore */ specifier)) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const requestedPath = specifier.replaceAll("\\", "/").replace(/^(?:\.\.\/|\.\/)+/, "");
		if (
			/failed to load url|cannot find module|cannot find package|unknown variable dynamic import/i.test(
				message,
			) &&
			message.replaceAll("\\", "/").includes(requestedPath)
		) {
			return null;
		}
		throw error;
	}
}
