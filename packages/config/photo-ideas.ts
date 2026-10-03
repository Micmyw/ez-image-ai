/** Public route identities only; article publication and preset membership stay server-validated. */
export const PHOTO_IDEA_RECIPE_ROUTES = [
	{ slug: "1980s-ai-photo", recipeId: "1980s-ai-photo" },
] as const;

export function isPhotoIdeaRoute(slug: string): boolean {
	return PHOTO_IDEA_RECIPE_ROUTES.some((route) => route.slug === slug);
}
