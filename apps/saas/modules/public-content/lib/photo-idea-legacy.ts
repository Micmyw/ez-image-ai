import "server-only";
import { effectPath } from "../../effects/lib/types";
import { getBlogPostsForEffect, getPublishedPhotoIdeaBySlug } from "./content";

type Query = Record<string, string | string[] | undefined>;
const languages = ["en", "de", "es", "fr"];
const sources = ["effects-directory", "blog", "home", "image-to-image", "model", "effect"];

/** A legacy address redirects only while its article and tested recipe are both public. */
export function legacyPhotoIdeaRedirect(slug: string, query: Query): string | null {
	const idea = getPublishedPhotoIdeaBySlug(slug);
	if (!idea) return null;
	const presetId = typeof query.preset === "string" ? query.preset : undefined;
	const sourceBlogId =
		typeof query.source === "string" &&
		getBlogPostsForEffect(idea.recipe.id, "en").some((post) => post.id === query.source)
			? query.source
			: undefined;
	const url = new URL(
		effectPath(idea.recipe, presetId, sourceBlogId),
		"https://photo-idea.invalid",
	);
	if (typeof query.from === "string" && sources.includes(query.from))
		url.searchParams.set("from", query.from);
	if (typeof query.lang === "string" && languages.includes(query.lang))
		url.searchParams.set("lang", query.lang);
	if (query.upgrade === "complete" && !query.resume) url.searchParams.set("upgrade", "complete");
	if (query.resume === "text" && !query.upgrade) url.searchParams.set("resume", "text");
	return url.pathname + url.search;
}

export function legacyEffectsDirectoryRedirect(query: Query): string {
	const parameters = new URLSearchParams({ category: "photo-ideas" });
	if (typeof query.lang === "string" && languages.includes(query.lang))
		parameters.set("lang", query.lang);
	return `/blog?${parameters.toString()}`;
}
