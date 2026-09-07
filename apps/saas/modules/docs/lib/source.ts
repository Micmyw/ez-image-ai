import { docs } from "@docs-source/server";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

export const DOCS_RESERVED_SLUGS = ["api", "og", "llms.txt", "llms-full.txt", "llms.mdx"] as const;

const reservedDocsSlugs = new Set<string>(DOCS_RESERVED_SLUGS);

export function isReservedDocsSlug(slug: string): boolean {
	return reservedDocsSlugs.has(slug.trim().toLowerCase());
}

export const source = loader({
	baseUrl: "/docs",
	source: docs.toFumadocsSource(),
	plugins: [lucideIconsPlugin()],
});

for (const page of source.getPages()) {
	const topLevelSlug = page.slugs[0];
	if (topLevelSlug && isReservedDocsSlug(topLevelSlug)) {
		throw new Error(`Docs page slug is reserved by an endpoint: ${topLevelSlug}`);
	}
}

export function getPageImage(page: InferPageType<typeof source>) {
	const segments = [...page.slugs, "image.png"];

	return {
		segments,
		url: `/docs/og/${segments.join("/")}`,
	};
}

export function getPageMarkdownUrl(page: InferPageType<typeof source>): string {
	return page.slugs.length === 0
		? "/docs/llms.mdx"
		: `/docs/llms.mdx/${page.slugs.map(encodeURIComponent).join("/")}`;
}

export async function getLLMText(page: InferPageType<typeof source>) {
	const processed = await page.data.getText("processed");

	return `# ${page.data.title}\n\n${processed}`;
}
