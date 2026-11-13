/** Public identifiers shared by homepage click events and their administrator report. */
export const HOMEPAGE_SHOWCASE_IDEAS = [
	"watercolor",
	"vintage-photo",
	"christmas",
	"green-booth-freestyle",
] as const;
export const HOMEPAGE_QUICK_START_IDEAS = [
	"christmas",
	"restore-photo",
	"birthday-card",
	"kung-fu-cat",
] as const;
export const HOMEPAGE_IDEA_KEYS = [
	...HOMEPAGE_SHOWCASE_IDEAS,
	"restore-photo",
	"birthday-card",
	"kung-fu-cat",
] as const;
export const HOMEPAGE_IDEA_PLACEMENTS = ["showcase", "quick-start"] as const;
export const HOMEPAGE_BIRTHDAY_VARIANTS = ["birthday-portrait", "birthday-dog"] as const;
export type HomepageBirthdayVariant = (typeof HOMEPAGE_BIRTHDAY_VARIANTS)[number];
export type HomepageIdeaKey = (typeof HOMEPAGE_IDEA_KEYS)[number];
export type HomepageIdeaPlacement = (typeof HOMEPAGE_IDEA_PLACEMENTS)[number];
