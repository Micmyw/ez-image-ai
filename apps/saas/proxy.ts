import { isLocale } from "@repo/i18n";
import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
	if (/^\/video(?:\/|$)/.test(request.nextUrl.pathname)) {
		// Authenticated workspace routes keep account locale-cookie behavior.
		const response = NextResponse.next();
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
		return response;
	}
	// Legacy recipe routes resolve through Blog publication checks in their handler.
	const headers = new Headers(request.headers);
	// Bare public URLs stay English. Explicit language views retain the canonical
	// English URL and are excluded from indexing; account cookies stay independent.
	const requested = request.nextUrl.searchParams.get("lang");
	const locale = isLocale(requested) ? requested : "en";
	headers.set("X-NEXT-INTL-LOCALE", locale);
	const response = NextResponse.next({ request: { headers } });
	if (locale !== "en") response.headers.set("X-Robots-Tag", "noindex, follow");
	if (
		request.nextUrl.pathname === "/photo-to-coloring-page" &&
		["asset", "guestAsset", "guestJob", "job", "reuseJob"].some((key) =>
			request.nextUrl.searchParams.has(key),
		)
	)
		response.headers.set("X-Robots-Tag", "noindex, follow");
	if (request.nextUrl.pathname.startsWith("/effects-preview/"))
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	return response;
}

export const config = {
	matcher: [
		"/",
		"/create",
		"/video/:path*",
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
