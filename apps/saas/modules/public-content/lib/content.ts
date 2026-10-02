import { publicChangelogEntries } from "../../../content/changelog/releases";
import { privacyPolicyDocuments } from "../../../content/legal/privacy-policy";
import { termsDocuments } from "../../../content/legal/terms";
import { promptEditingDocuments } from "../../../content/posts/ai-image-editing-prompts";
import { blogDocuments } from "../../../content/posts/private-image-editing-workflow";
import { getEffectRecordsForValidation, getPublishedEffectById } from "../../effects/lib/content";
import type { BlogPost } from "./blog-types";
import { validateBlogPosts } from "./blog-validation";

export type { BlogPost } from "./blog-types";

export type LegalPage = {
	path: string;
	updatedAt?: string;
	locale: string;
	title: string;
	description: string;
	body: string;
};

export type PublicChangelogEntry = {
	date: string;
	title: string;
	changes: readonly string[];
};

const legalDocuments: readonly LegalPage[] = [...privacyPolicyDocuments, ...termsDocuments];
const posts: readonly BlogPost[] = [...blogDocuments, ...promptEditingDocuments];
validateBlogPosts(posts, getEffectRecordsForValidation());

export function getLegalPageByPath(path: string, options: { locale: string }): LegalPage | null {
	return selectLocalizedDocument(legalDocuments, "path", path, options.locale);
}

export function getAllPublishedBlogPosts(locale: string): BlogPost[] {
	return uniqueValues(posts, "slug")
		.map((slug) => selectLocalizedDocument(posts, "slug", slug, locale))
		.filter((post): post is BlogPost => post?.published === true)
		.map(publicBlogPost)
		.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

export function getBlogPostBySlug(slug: string, locale: string): BlogPost | null {
	const post = selectLocalizedDocument(posts, "slug", slug, locale);
	return post?.published ? publicBlogPost(post) : null;
}

/** Effects obtain related tutorials from the Blog relationship, never from a second list. */
export function getBlogPostsForEffect(effectId: string, locale: string): BlogPost[] {
	if (!getPublishedEffectById(effectId)) return [];
	return getAllPublishedBlogPosts(locale).filter((post) =>
		post.relatedEffectIds.includes(effectId),
	);
}

export function getRelatedBlogPosts(post: BlogPost, locale: string, limit = 3): BlogPost[] {
	return getAllPublishedBlogPosts(locale)
		.filter(
			(candidate) =>
				candidate.id !== post.id &&
				(candidate.categoryId === post.categoryId ||
					candidate.tags.some((tag) => post.tags.includes(tag)) ||
					candidate.relatedEffectIds.some((id) => post.relatedEffectIds.includes(id))),
		)
		.slice(0, limit);
}

function publicBlogPost(post: BlogPost): BlogPost {
	const relatedEffectIds = post.relatedEffectIds.filter((id) => getPublishedEffectById(id));
	return {
		...post,
		relatedEffectIds,
		primaryEffectId:
			post.primaryEffectId && relatedEffectIds.includes(post.primaryEffectId)
				? post.primaryEffectId
				: undefined,
		contentBlocks: post.contentBlocks?.filter((block) => relatedEffectIds.includes(block.effectId)),
		tests: post.tests?.filter(
			(test) => !test.preset || relatedEffectIds.includes(test.preset.effectId),
		),
	};
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
