import {
	collectFirstTouchAttribution,
	sanitizeAttributionPath,
} from "./acquisition-attribution-core";

const publicPaths = new Set([
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
]);

/** Only reviewed public route shapes; never send private IDs, prompts or arbitrary query values. */
export function publicAnalyticsPath(url: URL): string | null {
	const path = sanitizeAttributionPath(url.pathname, url.origin);
	return path && (publicPaths.has(path) || /^\/(blog|docs|models)\//.test(path)) ? path : null;
}

export function analyticsPageLocation(url: URL): string {
	const path = publicAnalyticsPath(url);
	if (!path) return `${url.origin}/`;
	const attribution = collectFirstTouchAttribution(url.href, "");
	const safe = new URL(path, url.origin);
	for (const [parameter, value] of [
		["utm_source", attribution.utmSource],
		["utm_medium", attribution.utmMedium],
		["utm_campaign", attribution.utmCampaign],
		["utm_term", attribution.utmTerm],
		["utm_content", attribution.utmContent],
	])
		if (value) safe.searchParams.set(parameter!, value);
	return safe.href;
}
