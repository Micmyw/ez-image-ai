import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
	const headers = new Headers(request.headers);
	// next-intl reads this as requestLocale. Public URLs have one stable language;
	// the account locale cookie is neither read nor overwritten by this boundary.
	headers.set("X-NEXT-INTL-LOCALE", "en");
	return NextResponse.next({ request: { headers } });
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
