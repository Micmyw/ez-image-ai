import { collectFirstTouchAttribution } from "./acquisition-attribution-core";
import { acquisitionSource } from "./analytics-dimensions";
import { publicAnalyticsPath } from "./analytics-page";

export const AGGREGATE_SOURCES = [
	"direct",
	"chatgpt.com",
	"perplexity.ai",
	"claude.ai",
	"google",
	"bing",
	"reddit",
	"facebook",
	"instagram",
	"x",
	"other",
] as const;
export const AGGREGATE_PATHS = [
	"/",
	"/pricing",
	"/image-pass",
	"/create",
	"/try",
	"/image-to-image",
	"/photo-to-coloring-page",
	"/models",
	"/blog",
	"/docs",
	"/examples",
	"/privacy",
	"/terms",
	"/contact",
	"/changelog",
	"/video-effects/hotel-lobby-ai",
] as const;
export type AggregateSource = (typeof AGGREGATE_SOURCES)[number];

/** Finite categories, not user-provided strings or complete referrer URLs. */
export function aggregateSource(href: string, referrer: string): AggregateSource {
	const source = acquisitionSource(collectFirstTouchAttribution(href, referrer)) ?? "other";
	if (["chatgpt", "chatgpt.com", "chat.openai.com"].includes(source)) return "chatgpt.com";
	if (["perplexity", "perplexity.ai"].includes(source)) return "perplexity.ai";
	if (["claude", "claude.ai"].includes(source)) return "claude.ai";
	if (/^(?:[a-z]+\.)?google\.[a-z.]+$/.test(source) || source === "google") return "google";
	for (const name of ["bing", "reddit", "facebook", "instagram"] as const)
		if (source === name || source === `${name}.com` || source.endsWith(`.${name}.com`)) return name;
	if (["x", "x.com", "twitter", "twitter.com", "t.co"].includes(source)) return "x";
	return source === "direct" ? "direct" : "other";
}

export function aggregatePath(url: URL): (typeof AGGREGATE_PATHS)[number] | null {
	const path = publicAnalyticsPath(url);
	if (!path) return null;
	const group = path.replace(/^\/(blog|docs|models)\/.*$/, "/$1");
	return AGGREGATE_PATHS.find((allowed) => allowed === group) ?? null;
}
