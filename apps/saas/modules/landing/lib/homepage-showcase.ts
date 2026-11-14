import { HOMEPAGE_SHOWCASE_IDEAS } from "@repo/config/homepage-ideas";

/** Legacy storage key retained to cover visitors who saw the earlier one-time preview. */
export const HOMEPAGE_SHOWCASE_SEEN_KEY = "ezpic:homepage-showcase:2026-11-13-v2";

export const HOMEPAGE_SHOWCASE_KEYS = HOMEPAGE_SHOWCASE_IDEAS;

export type HomepageShowcaseSlide = {
	key: (typeof HOMEPAGE_SHOWCASE_KEYS)[number];
	title: string;
	label: string;
	action: string;
	description: string;
	href: string;
	poster: string;
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

export function canAutoShowHomepageShowcase(search: string, hash: string) {
	// A direct editor/task link should resume that work immediately.
	const params = new URLSearchParams(search);
	return !hash && [...params.keys()].every((key) => key === "lang" || key.startsWith("utm_"));
}
