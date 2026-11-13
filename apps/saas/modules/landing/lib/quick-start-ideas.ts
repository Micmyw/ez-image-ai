import type { HOMEPAGE_QUICK_START_IDEAS } from "@repo/config/homepage-ideas";

export const QUICK_START_PROMPTS = {
	"restore-photo": "restorePhoto",
	"birthday-card": "birthdayCard",
	watercolor: "watercolor",
	"vintage-photo": "vintagePhoto",
} as const;

export function quickStartPromptKey(value: string | null) {
	return value && Object.hasOwn(QUICK_START_PROMPTS, value)
		? QUICK_START_PROMPTS[value as keyof typeof QUICK_START_PROMPTS]
		: null;
}

export type QuickStartIdea = (typeof HOMEPAGE_QUICK_START_IDEAS)[number];
