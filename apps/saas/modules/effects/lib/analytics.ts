import {
	clearBrowserGrowthContentAttribution,
	growthContentAttributionSchema,
	setBrowserGrowthAnalyticsSuppressed,
	setBrowserGrowthContentAttribution,
	trackBrowserGrowthEvent,
	type GrowthAnalyticsTrackResult,
	type GrowthContentAttribution,
} from "@repo/utils";

import type { EffectPageContent } from "./types";

export type EffectAnalyticsOptions = {
	sourceBlogId?: string;
	/** The server derives this list from published articles related to this effect. */
	allowedSourceBlogIds?: readonly string[];
	internalSource?: GrowthContentAttribution["internal_source"];
	preview?: boolean;
};

export type BlogAnalyticsPost = {
	id: string;
	slug: string;
	published: boolean;
};

type AnalyticsEffect = Pick<EffectPageContent, "id" | "slug" | "status"> & {
	presets: readonly { id: string; version: number }[];
};

/** Receives only server-selected public content, never the draft catalog or query payloads. */
export function createEffectAnalyticsContext(
	effect: AnalyticsEffect,
	presetId: string,
	options: EffectAnalyticsOptions = {},
): GrowthContentAttribution | undefined {
	if (options.preview || effect.status !== "published") return undefined;
	const preset = effect.presets.find((candidate) => candidate.id === presetId);
	if (!preset) return undefined;
	const sourceBlogId =
		options.sourceBlogId && options.allowedSourceBlogIds?.includes(options.sourceBlogId)
			? options.sourceBlogId
			: undefined;
	const parsed = growthContentAttributionSchema.safeParse({
		effect_id: effect.id,
		preset_id: preset.id,
		preset_version: preset.version,
		...(sourceBlogId ? { source_blog_id: sourceBlogId } : {}),
		internal_source: sourceBlogId
			? "blog"
			: options.internalSource === "blog"
				? "effect"
				: (options.internalSource ?? "effect"),
		entry_path: `/blog/${effect.slug}`,
	});
	return parsed.success ? parsed.data : undefined;
}

export function createBlogAnalyticsContext(
	post: BlogAnalyticsPost,
): GrowthContentAttribution | undefined {
	if (!post.published) return undefined;
	const parsed = growthContentAttributionSchema.safeParse({
		source_blog_id: post.id,
		internal_source: "blog",
		entry_path: `/blog/${post.slug}`,
	});
	return parsed.success ? parsed.data : undefined;
}

export function setEffectAnalyticsContext(
	effect: AnalyticsEffect,
	presetId: string,
	options: EffectAnalyticsOptions = {},
): boolean {
	const suppressed = options.preview === true || effect.status !== "published";
	setBrowserGrowthAnalyticsSuppressed(suppressed);
	const context = createEffectAnalyticsContext(effect, presetId, options);
	if (!context) {
		clearBrowserGrowthContentAttribution();
		return false;
	}
	return setBrowserGrowthContentAttribution(context);
}

export function recordEffectViewed(
	effect: AnalyticsEffect,
	presetId: string,
	options: EffectAnalyticsOptions = {},
): Promise<GrowthAnalyticsTrackResult> {
	const context = createEffectAnalyticsContext(effect, presetId, options);
	const enabled = setEffectAnalyticsContext(effect, presetId, options);
	if (!context || !enabled) return Promise.resolve("blocked");
	return trackBrowserGrowthEvent(
		{ name: "effect_viewed", properties: { ...context, status: "viewed" } },
		{ dedupeKey: `effect-viewed:${effect.id}` },
	);
}

export function recordEffectPresetSelected(
	effect: AnalyticsEffect,
	presetId: string,
	options: EffectAnalyticsOptions = {},
): Promise<GrowthAnalyticsTrackResult> {
	const context = createEffectAnalyticsContext(effect, presetId, options);
	const enabled = setEffectAnalyticsContext(effect, presetId, options);
	if (!context || !enabled) return Promise.resolve("blocked");
	return trackBrowserGrowthEvent({
		name: "preset_selected",
		properties: { ...context, status: "selected" },
	});
}

/** Call after the copy succeeds. Copying another card does not change the active editor attribution. */
export function recordEffectPromptCopied(
	effect: AnalyticsEffect,
	presetId: string,
	options: EffectAnalyticsOptions = {},
): Promise<GrowthAnalyticsTrackResult> {
	const context = createEffectAnalyticsContext(effect, presetId, options);
	if (!context) return Promise.resolve("blocked");
	return trackBrowserGrowthEvent({
		name: "prompt_copied",
		properties: { ...context, status: "copied" },
	});
}

export function recordBlogViewed(
	post: BlogAnalyticsPost,
	preview = false,
): Promise<GrowthAnalyticsTrackResult> {
	setBrowserGrowthAnalyticsSuppressed(preview || !post.published);
	const context = preview ? undefined : createBlogAnalyticsContext(post);
	if (!context) {
		clearBrowserGrowthContentAttribution();
		return Promise.resolve("blocked");
	}
	if (!setBrowserGrowthContentAttribution(context)) return Promise.resolve("blocked");
	return trackBrowserGrowthEvent(
		{ name: "blog_viewed", properties: { ...context, status: "viewed" } },
		{ dedupeKey: `blog-viewed:${post.id}` },
	);
}

export function recordBlogPromptCopied(
	post: BlogAnalyticsPost,
	preset?: { effect: AnalyticsEffect; presetId: string; allowedSourceBlogIds: readonly string[] },
): Promise<GrowthAnalyticsTrackResult> {
	const blog = createBlogAnalyticsContext(post);
	if (!blog) return Promise.resolve("blocked");
	const effect = preset
		? createEffectAnalyticsContext(preset.effect, preset.presetId, {
				sourceBlogId: post.id,
				allowedSourceBlogIds: preset.allowedSourceBlogIds,
			})
		: undefined;
	if (preset && (!effect || effect.source_blog_id !== post.id)) return Promise.resolve("rejected");
	return trackBrowserGrowthEvent({
		name: "prompt_copied",
		properties: { ...effect, ...blog, status: "copied" },
	});
}
