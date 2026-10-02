import { isLocale } from "@repo/i18n";
import { type NextRequest, NextResponse } from "next/server";

import { getRetiredEffectBySlug } from "./modules/effects/lib/content";

export function proxy(request: NextRequest) {
	const effectSlug = /^\/effects\/([a-z0-9-]+)$/.exec(request.nextUrl.pathname)?.[1];
	const retired = effectSlug ? getRetiredEffectBySlug(effectSlug) : null;
	if (retired?.redirectTo)
		return NextResponse.redirect(new URL(retired.redirectTo, request.url), 308);
	if (retired)
		return new NextResponse(
			'<!doctype html><html lang="en"><head><title>Effect retired | EzImageAI</title><meta name="robots" content="noindex, follow"></head><body><main><h1>This effect has been retired</h1><p>This recipe is no longer available.</p><a href="/effects">Explore AI Effects</a></main></body></html>',
			{
				status: 410,
				headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, follow" },
			},
		);
	const headers = new Headers(request.headers);
	// Bare public URLs stay English. Explicit language views retain the canonical
	// English URL and are excluded from indexing; account cookies stay independent.
	const requested = request.nextUrl.searchParams.get("lang");
	const locale = isLocale(requested) ? requested : "en";
	headers.set("X-NEXT-INTL-LOCALE", locale);
	const response = NextResponse.next({ request: { headers } });
	if (locale !== "en") response.headers.set("X-Robots-Tag", "noindex, follow");
	if (request.nextUrl.pathname.startsWith("/effects-preview/"))
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	return response;
}

export const config = {
	matcher: [
		"/",
		"/create",
		"/examples",
		"/effects/:path*",
		"/effects-preview/:path*",
		"/image-to-image",
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
