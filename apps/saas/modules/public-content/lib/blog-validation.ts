import { getContentHeadings } from "./blog-markdown";
import { BLOG_CATEGORIES, BLOG_EDITORIAL_TEAM, type BlogPost } from "./blog-types";
import { PHOTO_IDEA_RECIPE_ROUTES } from "./photo-idea-routes";

type EffectReference = {
	id: string;
	presets: readonly { id: string }[];
	examples?: readonly { id: string }[];
};

export function validateBlogPosts(
	posts: readonly BlogPost[],
	effects: readonly EffectReference[],
): void {
	const ids = new Set<string>();
	const slugs = new Set<string>();
	const effectMap = new Map(effects.map((effect) => [effect.id, effect]));
	const validDate = (value: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().startsWith(value);
	for (const post of posts) {
		const fail = (message: string): never => {
			throw new Error(`Invalid Blog post ${post.id}: ${message}`);
		};
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.id)) fail("invalid stable ID");
		if (
			!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(post.slug) ||
			post.slug.split("/")[0] === "category"
		)
			fail("invalid or reserved slug");
		const localizedId = `${post.locale}:${post.id}`;
		const localizedSlug = `${post.locale}:${post.slug}`;
		if (ids.has(localizedId) || slugs.has(localizedSlug)) fail("duplicate ID or slug");
		ids.add(localizedId);
		slugs.add(localizedSlug);
		if (posts.some((other) => other.id === post.id && other.slug !== post.slug))
			fail("localized slugs must match");
		if (posts.some((other) => other.slug === post.slug && other.id !== post.id))
			fail("localized IDs must match");
		if (!post.title.trim() || !post.description.trim() || !post.body.trim())
			fail("missing article content");
		if (
			!validDate(post.publishedAt) ||
			(post.updatedAt && (!validDate(post.updatedAt) || post.updatedAt < post.publishedAt))
		)
			fail("invalid publication or modification date");
		if (!BLOG_CATEGORIES.includes(post.categoryId)) fail("unknown category");
		if (
			!["photo-ideas", "guides", "prompt-guides", "troubleshooting", "comparisons"].includes(
				post.articleType,
			)
		)
			fail("unknown article type");
		if (post.recipeId) {
			if (post.articleType !== "photo-ideas" || post.categoryId !== "photo-ideas")
				fail("interactive recipes belong to Photo Ideas");
			if (!post.relatedEffectIds.includes(post.recipeId)) fail("recipe must be related");
			if (
				!PHOTO_IDEA_RECIPE_ROUTES.some(
					(route) => route.slug === post.slug && route.recipeId === post.recipeId,
				)
			)
				fail("recipe requires a registered article identity");
			if (posts.some((other) => other.recipeId === post.recipeId && other.id !== post.id))
				fail("a recipe must have one canonical article");
		}
		if (
			post.videoEffect &&
			(post.videoEffect !== "raindance" || post.slug !== "raindance-ai-trend" || post.recipeId)
		)
			fail("unregistered video guide");
		if (
			post.featuredOrder !== undefined &&
			(!Number.isInteger(post.featuredOrder) || post.featuredOrder < 0)
		)
			fail("invalid featured order");
		if (post.authorId !== BLOG_EDITORIAL_TEAM.id) fail("unknown author");
		if (
			new Set(post.relatedEffectIds).size !== post.relatedEffectIds.length ||
			post.relatedEffectIds.some((id) => !effectMap.has(id))
		)
			fail("unknown or duplicate related effect");
		if (post.primaryEffectId && !post.relatedEffectIds.includes(post.primaryEffectId))
			fail("primary effect must be related");
		if (
			post.cover &&
			(!/^\/(?!\/)[^\\?#]+$/.test(post.cover.src) ||
				post.cover.src.includes("..") ||
				!post.cover.alt.trim() ||
				post.cover.width <= 0 ||
				post.cover.height <= 0)
		)
			fail("invalid local cover");
		const headingIds = new Set(getContentHeadings(post.body).map((heading) => heading.id));
		if (
			post.recipeId &&
			(!post.recipePlacement ||
				!headingIds.has(post.recipePlacement.presetsAfterHeadingId) ||
				!headingIds.has(post.recipePlacement.editorAfterHeadingId))
		)
			fail("recipe needs valid article insertion headings");
		if (!post.recipeId && post.recipePlacement) fail("recipe placement needs a recipe");
		for (const block of post.contentBlocks ?? []) {
			if (!post.relatedEffectIds.includes(block.effectId)) fail("content effect must be related");
			const effect = effectMap.get(block.effectId);
			if (block.type === "before-after") {
				if (!effect?.examples?.some((example) => example.id === block.exampleId))
					fail("invalid example reference");
			} else if (!effect?.presets.some((preset) => preset.id === block.presetId)) {
				fail("invalid preset reference");
			}
			if (!headingIds.has(block.afterHeadingId)) fail("missing content insertion heading");
		}
		for (const source of post.sources ?? []) {
			if (
				!source.title.trim() ||
				!/^https:\/\/[^\s]+$/.test(source.url) ||
				(source.accessedAt && !validDate(source.accessedAt))
			)
				fail("invalid source");
		}
		for (const test of post.tests ?? []) {
			if (!validDate(test.testedAt) || !test.context.trim() || !test.result.trim())
				fail("incomplete test context");
			if (
				test.preset &&
				(!post.relatedEffectIds.includes(test.preset.effectId) ||
					!effectMap
						.get(test.preset.effectId)
						?.presets.some((preset) => preset.id === test.preset?.presetId))
			)
				fail("invalid tested preset");
		}
		if (post.published && post.articleType === "comparisons" && !post.tests?.length)
			fail("comparisons need real test records");
	}
}
