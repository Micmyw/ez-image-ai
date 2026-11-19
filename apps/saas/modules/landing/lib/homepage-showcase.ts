import { HOMEPAGE_SHOWCASE_IDEAS } from "@repo/config/homepage-ideas";

/** Legacy storage key retained to cover visitors who saw the earlier one-time preview. */
export const HOMEPAGE_SHOWCASE_SEEN_KEY = "ezpic:homepage-showcase:2026-11-13-v2";

export const HOMEPAGE_SHOWCASE_KEYS = HOMEPAGE_SHOWCASE_IDEAS;

export const HOMEPAGE_SHOWCASE_PRELOAD_ID = "homepage-showcase-preload";
export const HOMEPAGE_SHOWCASE_DELAY_MS = 1400;
export const HOMEPAGE_SHOWCASE_COMPACT_QUERY = "(max-width: 430px)";
export const HOMEPAGE_SHOWCASE_COMPACT_COMPARISON = {
	before: "/images/landing/variants/showcase-watercolor-before-768.95f579c21424d27e.webp",
	poster: "/images/landing/variants/showcase-watercolor-after-768.2786af48f282d462.webp",
} as const;

export const HOMEPAGE_SHOWCASE_MEDIA = {
	watercolor: {
		kind: "comparison",
		// The comparison stage always center-crops both photos to 16:9.
		before: "/images/landing/variants/showcase-watercolor-before-960.acff06934970ac6e.webp",
		poster: "/images/landing/variants/showcase-watercolor-after-960.92300fb2394dfd6d.webp",
		thumbnail: "/images/landing/variants/showcase-watercolor-144.a1e4ca22593a1c33.webp",
	},
	"vintage-photo": {
		kind: "portrait",
		before: "/images/effects/1980s-ai-photo/input-adult-v1.webp",
		poster: "/images/effects/1980s-ai-photo/family-snapshot-v3.webp",
		thumbnail: "/images/landing/variants/showcase-vintage-photo-144.ad493183107c5383.webp",
	},
	christmas: {
		kind: "gallery",
		poster: "/images/christmas/globe.webp",
		thumbnail: "/images/landing/variants/showcase-christmas-144.b466b559d0f85ddf.webp",
		images: [
			"/images/christmas/street.webp",
			"/images/christmas/globe.webp",
			"/images/christmas/pet.webp",
		],
	},
	"green-booth-freestyle": {
		kind: "video",
		poster: "/videos/homepage-showcase/green-booth-freestyle.webp",
		thumbnail: "/images/landing/variants/showcase-green-booth-freestyle-144.ff01d4ac8ea0531e.webp",
		video: "/videos/homepage-showcase/green-booth-freestyle.mp4",
	},
} as const;

export type HomepageShowcaseSlide = {
	key: (typeof HOMEPAGE_SHOWCASE_KEYS)[number];
	title: string;
	label: string;
	action: string;
	description: string;
	href: string;
	poster: string;
	thumbnail: string;
	prompt?: string;
} & (
	| { kind: "comparison" | "portrait"; before: string }
	| { kind: "gallery"; images: readonly string[] }
	| { kind: "video"; video: string }
);

export type HomepageShowcaseCopy = {
	trigger: string;
	eyebrow: string;
	image: string;
	video: string;
	before: string;
	after: string;
	compare: string;
	close: string;
	previous: string;
	next: string;
	play: string;
	pause: string;
	mute: string;
	unmute: string;
	retry: string;
	progress: string;
};

export function allowsHomepageShowcaseQuery(keys: Iterable<string>) {
	// A direct editor/task link should resume that work immediately.
	return [...keys].every((key) => key === "lang" || key.startsWith("utm_"));
}

export function canAutoShowHomepageShowcase(search: string, hash: string) {
	return !hash && allowsHomepageShowcaseQuery(new URLSearchParams(search).keys());
}
