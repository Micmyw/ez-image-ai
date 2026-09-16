import { isLocale } from "@repo/i18n";
import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
	const headers = new Headers(request.headers);
	// Bare public URLs stay English. Explicit language views retain the canonical
	// English URL and are excluded from indexing; account cookies stay independent.
	const requested = request.nextUrl.searchParams.get("lang");
	const locale = isLocale(requested) ? requested : "en";
	headers.set("X-NEXT-INTL-LOCALE", locale);
	const response = NextResponse.next({ request: { headers } });
	if (locale !== "en") response.headers.set("X-Robots-Tag", "noindex, follow");
	return response;
}

export const config = {
	matcher: [
		"/",
		"/create",
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
