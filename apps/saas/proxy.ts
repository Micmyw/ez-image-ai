import { isLocale } from "@repo/i18n";
import { type NextRequest, NextResponse } from "next/server";

import { publicPageIndexing } from "./modules/public-content/lib/indexing";

export function proxy(request: NextRequest) {
	if (/^\/video(?:\/|$)/.test(request.nextUrl.pathname)) {
		// Authenticated workspace routes keep account locale-cookie behavior.
		const response = NextResponse.next();
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
		return response;
	}
	// Legacy recipe routes resolve through Blog publication checks in their handler.
	const headers = new Headers(request.headers);
	// Bare public URLs stay English; translated pages have explicit canonical
	// language views. Account cookies stay independent from public URL language.
	const requested = request.nextUrl.searchParams.get("lang");
	const locale = isLocale(requested) ? requested : "en";
	headers.set("X-NEXT-INTL-LOCALE", locale);
	const response = NextResponse.next({ request: { headers } });
	const search = Object.fromEntries(
		[...request.nextUrl.searchParams.keys()].map((key) => [
			key,
			request.nextUrl.searchParams.getAll(key),
		]),
	);
	const policy = publicPageIndexing(request.nextUrl.pathname, search);
	if (!policy.index)
		response.headers.set("X-Robots-Tag", `noindex, ${policy.follow ? "follow" : "nofollow"}`);
	if (request.nextUrl.pathname.startsWith("/effects-preview/"))
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	return response;
}

export const config = {
	matcher: [
		"/",
		"/create",
		"/video/:path*",
		"/video-effects/:path*",
		"/examples",
		"/effects/:path*",
		"/effects-preview/:path*",
		"/image-to-image",
		"/photo-to-coloring-page",
		"/models/:path*",
		"/pricing",
		"/privacy",
		"/terms",
		"/blog/:path*",
		"/changelog",
		"/contact",
		"/docs/:path*",
	],
};
