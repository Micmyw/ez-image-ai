import { publicChangelogEntries } from "../../../content/changelog/releases";
import { privacyPolicyDocuments } from "../../../content/legal/privacy-policy";
import { termsDocuments } from "../../../content/legal/terms";
import { blogDocuments } from "../../../content/posts/private-image-editing-workflow";

export type LegalPage = {
	path: string;
	locale: string;
	title: string;
	description: string;
	body: string;
};

export type BlogPost = {
	slug: string;
	locale: string;
	title: string;
	description: string;
	publishedAt: string;
	tags: readonly string[];
	published: boolean;
	body: string;
};

export type PublicChangelogEntry = {
	date: string;
	title: string;
	changes: readonly string[];
};

const legalDocuments: readonly LegalPage[] = [...privacyPolicyDocuments, ...termsDocuments];
const posts: readonly BlogPost[] = blogDocuments;

export function getLegalPageByPath(path: string, options: { locale: string }): LegalPage | null {
	return selectLocalizedDocument(legalDocuments, "path", path, options.locale);
}

export function getAllPublishedBlogPosts(locale: string): BlogPost[] {
	return uniqueValues(posts, "slug")
		.map((slug) => selectLocalizedDocument(posts, "slug", slug, locale))
		.filter((post): post is BlogPost => post?.published === true)
		.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export function getBlogPostBySlug(slug: string, locale: string): BlogPost | null {
	const post = selectLocalizedDocument(posts, "slug", slug, locale);
	return post?.published ? post : null;
}

export function getPublishedBlogPostPaths(): string[] {
	return uniqueValues(
		posts.filter((post) => post.published),
		"slug",
	);
}

export function getPublicChangelogEntries(): readonly PublicChangelogEntry[] {
	return publicChangelogEntries;
}

function selectLocalizedDocument<
	K extends "path" | "slug",
	T extends { locale: string } & Record<K, string>,
>(documents: readonly T[], key: K, value: string, locale: string): T | null {
	const matches = documents.filter((document) => document[key] === value);
	const normalizedLocale = locale.trim().toLowerCase().split("-")[0] ?? "en";
	return (
		matches.find((document) => document.locale === normalizedLocale) ??
		matches.find((document) => document.locale === "en") ??
		null
	);
}

function uniqueValues<T, K extends keyof T>(documents: readonly T[], key: K): Array<T[K] & string> {
	return [...new Set(documents.map((document) => document[key] as T[K] & string))];
}
