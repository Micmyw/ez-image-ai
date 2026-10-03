import "server-only";
import { getPublishedEffectById } from "../../effects/lib/content";
import type {
	PublicEffect,
	PublicEffectExample,
	PublicEffectPreset,
} from "../../effects/lib/types";
import { toBlogCard } from "../lib/blog-presentation";
import type { BlogPost } from "../lib/blog-types";
import type { BlogCardData } from "./BlogCard";

export type BlogVisual = {
	effect: PublicEffect;
	preset: PublicEffectPreset;
	example: PublicEffectExample;
};

/** A Blog visual follows its authored relationship and a matching, published preset version. */
export function resolveBlogVisual(
	post: BlogPost,
	effects: readonly PublicEffect[],
): BlogVisual | null {
	const ids = [
		...new Set(
			[post.primaryEffectId, ...post.relatedEffectIds].filter((id): id is string => Boolean(id)),
		),
	];
	for (const id of ids) {
		if (!post.relatedEffectIds.includes(id)) continue;
		const effect = effects.find(
			(candidate) => candidate.id === id && candidate.status === "published",
		);
		if (!effect) continue;
		const blocks = post.contentBlocks?.filter((block) => block.effectId === effect.id) ?? [];
		const exampleReference = blocks.find((block) => block.type === "before-after");
		const explicitExample =
			exampleReference?.type === "before-after"
				? effect.examples.find((example) => example.id === exampleReference.exampleId)
				: undefined;
		if (exampleReference && !explicitExample) continue;
		const presetReference = blocks.find((block) => block.type !== "before-after");
		const presetId =
			explicitExample?.presetId ??
			(presetReference && "presetId" in presetReference
				? presetReference.presetId
				: effect.defaultPresetId);
		const preset = effect.presets.find((candidate) => candidate.id === presetId);
		if (!preset) continue;
		const example =
			explicitExample ??
			effect.examples.find(
				(candidate) =>
					candidate.presetId === preset.id &&
					candidate.presetVersion === preset.version &&
					preset.exampleIds.includes(candidate.id),
			);
		if (
			!example ||
			example.presetVersion !== preset.version ||
			!preset.exampleIds.includes(example.id)
		)
			continue;
		return { effect, preset, example };
	}
	return null;
}

export function getBlogVisual(post: BlogPost): BlogVisual | null {
	const effects = post.relatedEffectIds
		.map(getPublishedEffectById)
		.filter((effect) => effect !== null);
	return resolveBlogVisual(post, effects);
}

export function toVisualBlogCard(post: BlogPost, locale: string): BlogCardData {
	const card = toBlogCard(post, locale);
	if (post.cover) return card;
	const visual = getBlogVisual(post);
	return visual
		? { ...card, cover: visual.example.output, comparisonInput: visual.example.input }
		: card;
}

export function withBlogVisualCover(post: BlogPost): BlogPost {
	if (post.cover) return post;
	const visual = getBlogVisual(post);
	return visual ? { ...post, cover: visual.example.output } : post;
}
