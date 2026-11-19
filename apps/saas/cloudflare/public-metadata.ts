import { setPublicDataSecurityHeaders } from "./public-data-headers";
import { hasSessionCookie } from "./public-edge";
import { prerenderedMetadata, publicIcons, webManifestPaths } from "./public-metadata-paths.mjs";

export interface PublicMetadataAssets {
	fetch(request: Request): Promise<Response>;
}

const manifests = new Set(webManifestPaths);
const iconAssets = new Map(Object.entries(publicIcons));
// These exact paths are absent from the product. Leave other URLs, including
// organization slugs, to Next. Public assets at these paths still win upstream.
const absentSoftwarePaths = new Set(["/manager/html", "/wp-admin/install.php"]);
const navigationHeaders = [
	"RSC",
	"Next-Router-State-Tree",
	"Next-Router-Prefetch",
	"Next-Router-Segment-Prefetch",
	"Next-Url",
];
const aliasVary = [
	"Cookie",
	"Accept",
	"Sec-Fetch-Dest",
	"Sec-Fetch-Mode",
	...navigationHeaders,
].join(", ");

/** Run only after the website origin check. */
export function servePublicMetadata(
	request: Request,
	assets?: PublicMetadataAssets,
): Response | Promise<Response | null> | null {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const url = new URL(request.url);
	const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	const staged = Object.hasOwn(prerenderedMetadata, pathname);
	const icon = iconAssets.get(pathname);
	const manifest = manifests.has(pathname);
	const absentSoftware = absentSoftwarePaths.has(pathname);
	if (!staged && !icon && !manifest && !absentSoftware) return null;

	const alias = Boolean(icon || manifest);
	if (alias && authenticatedNavigation(request, url)) return null;
	const https = url.protocol === "https:";
	if (pathname !== url.pathname) {
		const headers = new Headers({
			location: pathname + url.search,
			"cache-control": "no-store",
		});
		setPublicDataSecurityHeaders(headers, https);
		return new Response(null, { status: 308, headers });
	}
	if (absentSoftware || (!assets && alias)) return notFound(request, https);
	if (!assets) return null;

	if (icon) url.pathname = icon;
	return readAsset(icon ? new Request(url, request) : request, assets, alias, https);
}

function authenticatedNavigation(request: Request, url: URL) {
	if (!hasSessionCookie(request.headers.get("cookie") ?? "")) return false;
	const accept = request.headers.get("accept") ?? "";
	const destination = request.headers.get("sec-fetch-dest");
	return (
		request.headers.get("sec-fetch-mode") === "navigate" ||
		destination === "document" ||
		destination === "iframe" ||
		destination === "frame" ||
		/text\/html|application\/xhtml\+xml|text\/x-component/i.test(accept) ||
		navigationHeaders.some((name) => request.headers.has(name)) ||
		url.searchParams.has("_rsc")
	);
}

async function readAsset(
	request: Request,
	assets: PublicMetadataAssets,
	alias: boolean,
	https: boolean,
) {
	const response = await assets.fetch(request);
	if (response.status === 404) {
		await response.body?.cancel();
		return alias ? notFound(request, https) : null;
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (contentType === "text/html" || contentType === "application/xhtml+xml") {
		await response.body?.cancel();
		return null;
	}

	const secured = new Response(response.body, response);
	// A session-bearing document can resolve to a historical organization.
	// Keep the browser-file representation separate from that navigation.
	if (alias && secured.headers.get("vary") !== "*") secured.headers.append("vary", aliasVary);
	setPublicDataSecurityHeaders(secured.headers, https);
	return secured;
}

function notFound(request: Request, https: boolean) {
	const headers = new Headers({
		"cache-control": "no-store",
		"content-type": "text/plain; charset=utf-8",
		"x-robots-tag": "noindex",
	});
	setPublicDataSecurityHeaders(headers, https);
	return new Response(request.method === "HEAD" ? null : "Not found", { status: 404, headers });
}
