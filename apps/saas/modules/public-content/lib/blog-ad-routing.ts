// Keep the article response-policy allowlist exact. Embedded tools and draft posts
// are intentionally absent; its parity with the published reader is tested.
export const BLOG_AD_ORIGIN = "https://ads.ezimageai.com";
export const BLOG_AD_ARTICLE_PATHS = [
	"/blog/private-image-editing-workflow",
	"/blog/ai-image-editing-prompts",
	"/blog/tesco-ai-meal-planning-assistant",
] as const;

export function isBlogAdArticlePath(pathname: string): boolean {
	return BLOG_AD_ARTICLE_PATHS.some((path) => path === pathname);
}

export function requiresArticleDocumentNavigation(
	currentPathname: string,
	destinationPathname: string,
): boolean {
	return (
		currentPathname !== destinationPathname &&
		(isBlogAdArticlePath(currentPathname) || isBlogAdArticlePath(destinationPathname))
	);
}

export type ArticleAnchorNavigation = {
	button: number;
	defaultPrevented?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	target?: string | null;
	download?: boolean;
	disabled?: boolean;
};

/** Resolve only ordinary same-window links crossing an article policy boundary. */
export function getArticleDocumentNavigationTarget(
	currentHref: string,
	destinationHref: string,
	options: ArticleAnchorNavigation,
): string | null {
	if (
		options.button !== 0 ||
		options.defaultPrevented ||
		options.altKey ||
		options.ctrlKey ||
		options.metaKey ||
		options.shiftKey ||
		options.download ||
		options.disabled ||
		(options.target && options.target.toLowerCase() !== "_self")
	)
		return null;
	try {
		const current = new URL(currentHref);
		const destination = new URL(destinationHref, current);
		if (
			!["http:", "https:"].includes(destination.protocol) ||
			destination.origin !== current.origin ||
			destination.username ||
			destination.password ||
			!requiresArticleDocumentNavigation(current.pathname, destination.pathname)
		)
			return null;
		return destination.href;
	} catch {
		return null;
	}
}
