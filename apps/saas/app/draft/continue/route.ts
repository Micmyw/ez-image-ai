import { getSession } from "@auth/lib/server";
import { createDraftHandoffResponse } from "@media/lib/draft-handoff";
import {
	getExpiredDraftClaimCookie,
	getExpiredGuestBootstrapCookie,
} from "@repo/api/modules/media/lib/draft-security";
import { claimGenerationDraft } from "@repo/api/modules/media/procedures/claim-generation-draft";
import { claimGuestDraft } from "@repo/api/modules/media/procedures/claim-guest-draft";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
	const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL;
	const saasOrigin = process.env.NEXT_PUBLIC_SAAS_URL;
	if (!marketingOrigin || !saasOrigin) return new Response(null, { status: 403 });
	try {
		const session = await getSession();
		return await createDraftHandoffResponse(request, {
			marketingOrigin,
			saasOrigin,
			secure: process.env.NODE_ENV === "production",
			isRegistered: Boolean(session && !isAnonymousUser(session.user)),
		});
	} catch {
		return new Response(null, { status: 403 });
	}
}

export async function GET(request: Request) {
	const session = await getSession();
	if (!session) return anonymousBootstrapPostResponse();
	const responseHeaders = new Headers();
	try {
		const draft = await (
			isAnonymousUser(session.user) ? claimGuestDraft : claimGenerationDraft
		).callable({
			context: { headers: await headers(), responseHeaders },
		})({});
		const target = isAnonymousUser(session.user) ? "/try" : "/create";
		const response = NextResponse.redirect(new URL(target, request.url));
		for (const [name, value] of responseHeaders) response.headers.append(name, value);
		if (!isAnonymousUser(session.user)) {
			response.cookies.set("media_claimed_draft", draft.id, {
				httpOnly: true,
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				path: "/create",
				maxAge: 300,
			});
		}
		expireHandoffCookies(response);
		return response;
	} catch {
		const target = isAnonymousUser(session.user)
			? "/try?draftError=unavailable"
			: "/create?draftError=unavailable";
		const response = NextResponse.redirect(new URL(target, request.url));
		expireHandoffCookies(response);
		return response;
	}
}

function anonymousBootstrapPostResponse(): Response {
	const body = `<!doctype html><html><head><meta name="referrer" content="origin"></head><body><form method="post" action="/api/auth/sign-in/anonymous?handoff=1"><noscript><button type="submit">Continue</button></noscript></form><script>document.forms[0].submit()</script></body></html>`;
	return new Response(body, {
		status: 200,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/html; charset=utf-8",
			"Referrer-Policy": "origin",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function expireHandoffCookies(response: NextResponse): void {
	const secure = process.env.NODE_ENV === "production";
	response.headers.append("Set-Cookie", getExpiredDraftClaimCookie(secure));
	response.headers.append("Set-Cookie", getExpiredGuestBootstrapCookie(secure));
}
