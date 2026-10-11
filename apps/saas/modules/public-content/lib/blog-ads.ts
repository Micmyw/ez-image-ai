import { BLOG_AD_ORIGIN, isBlogAdArticlePath } from "./blog-ad-routing";

export type BlogAdFormat = "banner" | "native";

export type BlogAdSettings = {
	enabled: boolean;
	nativeEnabled: boolean;
	bannerEnabled?: boolean;
	testExpiresAt?: string;
};

// A public, finite test window, not a credential or a permanent inventory activation.
// Only the Tesco article accepts the explicit preview query. The production master
// switches remain false while the independent static source is default-off.
export const BLOG_AD_PREVIEW_EXPIRES_AT = "2026-10-11T16:00:00Z";
export const BLOG_AD_PREVIEW_PATH = "/blog/tesco-ai-meal-planning-assistant";

export function getBlogAdSettings(
	env: Record<string, string | undefined>,
	preview?: { pathname: string; format?: string | string[]; now?: number },
): BlogAdSettings {
	if (
		preview?.pathname === BLOG_AD_PREVIEW_PATH &&
		(preview.format === "banner" || preview.format === "native") &&
		(preview.now ?? Date.now()) < Date.parse(BLOG_AD_PREVIEW_EXPIRES_AT)
	) {
		return {
			enabled: true,
			nativeEnabled: preview.format === "native",
			bannerEnabled: preview.format === "banner",
			testExpiresAt: BLOG_AD_PREVIEW_EXPIRES_AT,
		};
	}
	return {
		enabled: env.BLOG_ADS_ENABLED === "true" && (!preview || isBlogAdArticlePath(preview.pathname)),
		nativeEnabled:
			env.BLOG_ADS_ENABLED === "true" &&
			env.BLOG_NATIVE_ADS_ENABLED === "true" &&
			(!preview || isBlogAdArticlePath(preview.pathname)),
	};
}

export const BLOG_AD_SANDBOX = "allow-scripts";
export const BLOG_AD_BANNER_WIDTH = 728;
export const BLOG_AD_NATIVE_HEIGHT = 320;

// The independent static document has its own response CSP and public base URL.
// Do not send an article address, account identifier, query or resource as a parameter.
export function getBlogAdDocumentUrl(format: BlogAdFormat): string {
	return `${BLOG_AD_ORIGIN}/${format}.html`;
}

// No account, article URL, query string, prompt, photo or asset is interpolated here.
// The opaque origin has no host cookies/storage/DOM access. Do not add same-origin,
// popup, form, download or top-navigation permissions to make inventory work.
export function getBlogAdDocument(format: BlogAdFormat): string {
	const host =
		format === "banner"
			? "https://www.highrevenueformat.com"
			: "https://pl31768149.profitableratecpmnetwork.com";
	const content =
		format === "banner"
			? `<script>atOptions = {'key':'2266a6811e407f9b362831f885d09d1e','format':'iframe','height':90,'width':728,'params':{}};</script><script referrerpolicy="no-referrer" src="${host}/2266a6811e407f9b362831f885d09d1e/invoke.js"></script>`
			: `<script async="async" data-cfasync="false" referrerpolicy="no-referrer" src="${host}/0a9986f36ff843c117e0f20e732a1e08/invoke.js"></script><div id="container-0a9986f36ff843c117e0f20e732a1e08"></div>`;
	// The static-source builder validates this template and emits a response CSP
	// with exact script/style hashes. A child meta policy cannot grant parent permission.
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}img{max-width:100%}</style></head><body>${content}</body></html>`;
}
