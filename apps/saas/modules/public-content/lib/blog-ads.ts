export type BlogAdFormat = "banner" | "native";

export type BlogAdSettings = {
	enabled: boolean;
	nativeEnabled: boolean;
};

// Read only in the article's server component. Neither setting changes the site's CSP.
// Keep both off until live inventory and the narrowly scoped frame policy are reviewed.
export function getBlogAdSettings(env: Record<string, string | undefined>): BlogAdSettings {
	return {
		enabled: env.BLOG_ADS_ENABLED === "true",
		nativeEnabled: env.BLOG_ADS_ENABLED === "true" && env.BLOG_NATIVE_ADS_ENABLED === "true",
	};
}

export const BLOG_AD_SANDBOX = "allow-scripts";
export const BLOG_AD_BANNER_WIDTH = 728;
export const BLOG_AD_NATIVE_HEIGHT = 320;

// A srcdoc document inherits the embedding page's fallback base URL even with
// an opaque origin and no-referrer. A static data document avoids exposing the
// article address/query through document.baseURI. The existing app CSP blocks
// this transport; do not widen that policy automatically to activate ads.
export function getBlogAdDocumentUrl(format: BlogAdFormat): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(getBlogAdDocument(format))}`;
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
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${host}; style-src 'unsafe-inline'; img-src https: data:; frame-src https:; connect-src https:; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}img{max-width:100%}</style></head><body>${content}</body></html>`;
}
