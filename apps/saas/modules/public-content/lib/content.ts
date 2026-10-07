import { publicChangelogEntries } from "../../../content/changelog/releases";
import { privacyPolicyDocuments } from "../../../content/legal/privacy-policy";
import { termsDocuments } from "../../../content/legal/terms";
import { eightiesPhotoDocuments } from "../../../content/posts/1980s-ai-photo";
import { promptEditingDocuments } from "../../../content/posts/ai-image-editing-prompts";
import { hotelLobbyVideoDocuments } from "../../../content/posts/hotel-lobby-ai-video";
import { blogDocuments } from "../../../content/posts/private-image-editing-workflow";
import { raindanceDocuments } from "../../../content/posts/raindance-ai-trend";
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
const posts: readonly BlogPost[] = [
	...blogDocuments,
	...promptEditingDocuments,
	...eightiesPhotoDocuments,
	...hotelLobbyVideoDocuments,
	...raindanceDocuments,
];

export function getLegalPageByPath(path: string, options: { locale: string }): LegalPage | null {
	return selectLocalizedDocument(legalDocuments, "path", path, options.locale);
}

export function createBlogContentReader(records: readonly BlogPost[]) {
	validateBlogPosts(records, getEffectRecordsForValidation());
	const isPublished = (post: BlogPost | null): post is BlogPost =>
		post?.published === true && (!post.recipeId || Boolean(getPublishedEffectById(post.recipeId)));
	const hasPublishedArticle = (recipeId: string) =>
		records.some((post) => post.recipeId === recipeId && isPublished(post));

	function getAllPublishedBlogPosts(locale: string): BlogPost[] {
		return uniqueValues(records, "slug")
			.map((slug) => selectLocalizedDocument(records, "slug", slug, locale))
			.filter(isPublished)
			.map(publicBlogPost)
			.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
	}

	function getBlogPostBySlug(slug: string, locale: string): BlogPost | null {
		const post = selectLocalizedDocument(records, "slug", slug, locale);
		return isPublished(post) ? publicBlogPost(post) : null;
	}

	/** Effects obtain related tutorials from the Blog relationship, never from a second list. */
	function getBlogPostsForEffect(effectId: string, locale: string): BlogPost[] {
		if (!getPublishedEffectById(effectId)) return [];
		return getAllPublishedBlogPosts(locale).filter((post) =>
			post.relatedEffectIds.includes(effectId),
		);
	}

	function getRelatedBlogPosts(post: BlogPost, locale: string, limit = 3): BlogPost[] {
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
		const relatedEffectIds = post.relatedEffectIds.filter(
			(id) => getPublishedEffectById(id) && hasPublishedArticle(id),
		);
		return {
			...post,
			relatedEffectIds,
			primaryEffectId:
				post.primaryEffectId && relatedEffectIds.includes(post.primaryEffectId)
					? post.primaryEffectId
					: undefined,
			contentBlocks: post.contentBlocks?.filter((block) =>
				relatedEffectIds.includes(block.effectId),
			),
			tests: post.tests?.filter(
				(test) => !test.preset || relatedEffectIds.includes(test.preset.effectId),
			),
		};
	}

	function getPublishedBlogPostPaths(): string[] {
		return uniqueValues(records.filter(isPublished), "slug");
	}

	function getPublishedPhotoIdeaBySlug(slug: string, locale = "en") {
		const post = getBlogPostBySlug(slug, locale);
		const recipe = post?.recipeId ? getPublishedEffectById(post.recipeId) : null;
		return post && recipe ? { post, recipe } : null;
	}

	function getFeaturedPhotoIdeas(locale: string, limit = 4): BlogPost[] {
		return getAllPublishedBlogPosts(locale)
			.filter((post) => post.articleType === "photo-ideas" && post.featuredOrder !== undefined)
			.sort((left, right) => (left.featuredOrder ?? 0) - (right.featuredOrder ?? 0))
			.slice(0, Math.max(0, Math.min(4, Math.trunc(limit))));
	}

	function getPhotoIdeasForProduct(productKey: string, locale: string): BlogPost[] {
		return getAllPublishedBlogPosts(locale).filter(
			(post) =>
				post.recipeId &&
				getPublishedEffectById(post.recipeId)?.presets.some(
					(preset) => preset.productKey === productKey,
				),
		);
	}

	/** Authorize an administrator before using this preview-only reader. */
	function getPhotoIdeaForPreview(recipeId: string, locale = "en"): BlogPost | null {
		const record = records.find((post) => post.recipeId === recipeId);
		return record ? selectLocalizedDocument(records, "slug", record.slug, locale) : null;
	}

	return {
		getAllPublishedBlogPosts,
		getBlogPostBySlug,
		getBlogPostsForEffect,
		getRelatedBlogPosts,
		getPublishedBlogPostPaths,
		getPublishedPhotoIdeaBySlug,
		getFeaturedPhotoIdeas,
		getPhotoIdeasForProduct,
		getPhotoIdeaForPreview,
	};
}

export const {
	getAllPublishedBlogPosts,
	getBlogPostBySlug,
	getBlogPostsForEffect,
	getRelatedBlogPosts,
	getPublishedBlogPostPaths,
	getPublishedPhotoIdeaBySlug,
	getFeaturedPhotoIdeas,
	getPhotoIdeasForProduct,
	getPhotoIdeaForPreview,
} = createBlogContentReader(posts);

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
