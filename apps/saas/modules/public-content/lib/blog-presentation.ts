import { getReadingMinutes } from "./blog-markdown";
import { BLOG_EDITORIAL_TEAM, blogPath, type BlogCardContent, type BlogPost } from "./blog-types";

export function formatBlogDate(value: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
		new Date(`${value}T00:00:00.000Z`),
	);
}

export function toBlogCard(post: BlogPost, locale: string): BlogCardContent {
	const date = post.updatedAt ?? post.publishedAt;
	return {
		id: post.id,
		slug: post.slug,
		title: post.title,
		description: post.description,
		categoryId: post.categoryId,
		tags: post.tags,
		cover: post.cover,
		date,
		dateLabel: formatBlogDate(date, locale),
		readingMinutes: getReadingMinutes(post.body),
	};
}

export function blogStructuredData(
	post: BlogPost,
	baseUrl: string,
	labels: { home: string; blog: string },
) {
	const url = new URL(blogPath(post), baseUrl).href;
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "BlogPosting",
				"@id": `${url}#article`,
				url,
				mainEntityOfPage: { "@type": "WebPage", "@id": url },
				headline: post.title,
				description: post.description,
				datePublished: post.publishedAt,
				...(post.updatedAt ? { dateModified: post.updatedAt } : {}),
				inLanguage: post.locale,
				author: { "@type": BLOG_EDITORIAL_TEAM.type, name: BLOG_EDITORIAL_TEAM.name },
				...(post.cover ? { image: new URL(post.cover.src, baseUrl).href } : {}),
			},
			{
				"@type": "BreadcrumbList",
				itemListElement: [
					{ "@type": "ListItem", position: 1, name: labels.home, item: new URL("/", baseUrl).href },
					{
						"@type": "ListItem",
						position: 2,
						name: labels.blog,
						item: new URL("/blog", baseUrl).href,
					},
					{ "@type": "ListItem", position: 3, name: post.title, item: url },
				],
			},
		],
	};
}

export function serializeBlogJsonLd(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
