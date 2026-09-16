import { getBaseUrl } from "@shared/lib/base-url";

import { getPublicImageSitemapEntries } from "../../modules/public-content/lib/image-sitemap";

export const dynamic = "force-static";

function escapeXml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function GET() {
	const entries = getPublicImageSitemapEntries(getBaseUrl());
	const body = entries
		.map(({ url, images }) =>
			[
				"<url>",
				`<loc>${escapeXml(url)}</loc>`,
				...images.map(
					(src) => `<image:image><image:loc>${escapeXml(src)}</image:loc></image:image>`,
				),
				"</url>",
			].join("\n"),
		)
		.join("\n");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`,
		{ headers: { "Content-Type": "application/xml; charset=utf-8" } },
	);
}
