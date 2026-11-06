/** Only list languages whose main page content is actually translated. */
export const PUBLIC_PAGE_LANGUAGES: Record<string, readonly string[]> = {
	"/": ["en", "de", "es", "fr"],
	"/create": ["en", "de", "es", "fr"],
	"/examples": ["en", "de", "es", "fr"],
	"/image-to-image": ["en", "de", "es", "fr"],
	"/pricing": ["en", "de", "es", "fr"],
	"/contact": ["en", "de", "es", "fr"],
	"/privacy": ["en", "de"],
	"/video-templates": ["en", "de", "es", "fr"],
	"/video-templates/original-rap": ["en", "de", "es", "fr"],
	"/video-templates/rap-orange-studio": ["en", "de", "es", "fr"],
	"/video-templates/rap-street-cypher": ["en", "de", "es", "fr"],
	"/video-templates/rap-neon-rap": ["en", "de", "es", "fr"],
	"/video-templates/rap-funny-rap": ["en", "de", "es", "fr"],
	"/video-templates/bulin-47": ["en", "de", "es", "fr"],
	"/video-templates/spin-me-round": ["en", "de", "es", "fr"],
	"/video-templates/58th-floor": ["en", "de", "es", "fr"],
	"/video-templates/green-booth-freestyle": ["en", "de", "es", "fr"],
	"/video-templates/kung-fu-cat": ["en", "de", "es", "fr"],
	"/video-templates/paws-at-you": ["en", "de", "es", "fr"],
	"/video-templates/source-hotel-lobby": ["en", "de", "es", "fr"],
	"/video-templates/flying-car": ["en", "de", "es", "fr"],
	"/video-templates/flying-car-curved-ramp-showcase": ["en", "de", "es", "fr"],
	"/video-templates/flying-car-curved-ramp": ["en", "de", "es", "fr"],
	"/video-templates/flying-car-fleet-side": ["en", "de", "es", "fr"],
	"/video-templates/flying-car-fleet-front": ["en", "de", "es", "fr"],
};

export type PublicSearchParams = Record<string, string | string[] | undefined>;
export type PublicMetadataProps = { searchParams?: Promise<PublicSearchParams> };

// These views can resume an upload, draft, personal job or payment flow. Presence,
// including an empty value, excludes them from indexing. Authentication still
// protects the underlying data; robots directives are never access control.
const PRIVATE_QUERY_KEYS = [
	"asset",
	"guestAsset",
	"guestJob",
	"job",
	"videoJob",
	"reuseJob",
	"parentJob",
	"resume",
	"draftError",
	"upgrade",
	"returnTo",
] as const;

export function publicPagePath(path: string, locale: string): string {
	return locale === "en" ? path : `${path}?lang=${locale}`;
}

export function publicPageIndexing(path: string, search: PublicSearchParams = {}) {
	const pathname = new URL(path, "https://public.invalid").pathname;
	const requested = Array.isArray(search.lang) ? search.lang[0] : search.lang;
	const locale = ["de", "es", "fr"].includes(requested ?? "") ? requested! : "en";
	const languages = PUBLIC_PAGE_LANGUAGES[pathname] ?? ["en"];
	const translated = languages.includes(locale);
	const privateView = PRIVATE_QUERY_KEYS.some((key) => search[key] !== undefined);
	const filteredBlog =
		pathname === "/blog" &&
		["q", "category", "tag"].some((key) =>
			Boolean(Array.isArray(search[key]) ? search[key][0] : search[key]),
		);
	const effectMode = pathname === "/blog/raindance-ai-trend" && search.mode !== undefined;
	// Discovery can precede release; imported templates have no target acceptance evidence yet.
	const pendingTemplates =
		pathname === "/video-templates" || pathname.startsWith("/video-templates/");
	return {
		locale,
		languages,
		canonicalPath: translated ? publicPagePath(path, locale) : path,
		index: translated && !privateView && !filteredBlog && !effectMode && !pendingTemplates,
		follow: !privateView,
	};
}
