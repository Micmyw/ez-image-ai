import { getSession } from "@auth/lib/server";
import { createDraftHandoffResponse } from "@media/lib/draft-handoff";
import { getDraftClaimFailure } from "@repo/api/modules/media/lib/draft-claim-recovery";
import {
	getExpiredDraftClaimCookie,
	getExpiredGuestBootstrapCookie,
	resolveGuestPublicOrigin,
} from "@repo/api/modules/media/lib/draft-security";
import { claimGenerationDraft } from "@repo/api/modules/media/procedures/claim-generation-draft";
import { claimGuestDraft } from "@repo/api/modules/media/procedures/claim-guest-draft";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import { logger } from "@repo/logs";
import { getBaseUrl } from "@shared/lib/base-url";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { readEffectEditorReturnCookie } from "../../../modules/effects/lib/editor-return";
import { resolvePublishedEffectReturnPath } from "../../../modules/effects/lib/editor-return.server";
import { sanitizeToolReturnPath } from "../../../modules/media/lib/tool-return-path";

function resolveDraftReturnPath(value: unknown) {
	return sanitizeToolReturnPath(value) ?? resolvePublishedEffectReturnPath(value);
}

export async function POST(request: Request) {
	const saasOrigin = process.env.NEXT_PUBLIC_SAAS_URL;
	if (!saasOrigin) return new Response(null, { status: 403 });
	try {
		const publicOrigin = resolveGuestPublicOrigin(request.headers.get("origin"), {
			saasOrigin,
		});
		const session = await getSession();
		return await createDraftHandoffResponse(request, {
			publicOrigin,
			saasOrigin,
			secure: process.env.NODE_ENV === "production",
			isRegistered: Boolean(session && !isAnonymousUser(session.user)),
			hasSession: Boolean(session),
			resolveEffectReturnPath: resolveDraftReturnPath,
		});
	} catch {
		return new Response(null, { status: 403 });
	}
}

export async function GET(request: Request) {
	const inline = request.headers.get("accept") === "application/json";
	const saasOrigin = getBaseUrl();
	const responseHeaders = new Headers();
	let session: Awaited<ReturnType<typeof getSession>> = null;
	let effectReturn: string | null = null;
	let stage = "identity";
	try {
		session = await getSession();
		if (!session) {
			return inline
				? inlineResponse({ code: "GUEST_SESSION_REQUIRED" }, 401)
				: anonymousBootstrapPostResponse();
		}
		if (inline && !isAnonymousUser(session.user)) {
			return inlineResponse({ code: "ACCOUNT_HANDOFF_REQUIRED" }, 409);
		}
		stage = "return-path";
		effectReturn = resolveDraftReturnPath(
			readEffectEditorReturnCookie(request.headers.get("cookie")),
		);
		stage = "claim";
		const draft = await (
			isAnonymousUser(session.user) ? claimGuestDraft : claimGenerationDraft
		).callable({
			context: { headers: await headers(), responseHeaders },
		})({});
		const target = isAnonymousUser(session.user) ? "/try" : (effectReturn ?? "/create");
		const response = inline
			? inlineResponse({ status: "READY" })
			: draftRedirect(target, saasOrigin);
		for (const [name, value] of responseHeaders) response.headers.append(name, value);
		if (!isAnonymousUser(session.user)) {
			response.cookies.set("media_claimed_draft", draft.id, {
				httpOnly: true,
				sameSite: "lax",
				secure: process.env.NODE_ENV === "production",
				path: effectReturn ? new URL(effectReturn, saasOrigin).pathname : "/create",
				// Only an owner-checked recovery pointer; this grants no guest asset access.
				maxAge: 24 * 60 * 60,
			});
		}
		expireHandoffCookies(response);
		return response;
	} catch (error) {
		const failure = getDraftClaimFailure(error);
		logger.warn("media.draft.handoff.failed", { stage, ...failure });
		if (inline) {
			const response = inlineResponse(
				{ code: failure.recoverable ? "DRAFT_RETRY_REQUIRED" : "DRAFT_UNAVAILABLE" },
				failure.recoverable ? 503 : 410,
			);
			if (!failure.recoverable) expireHandoffCookies(response);
			return response;
		}
		if (failure.recoverable) {
			// Preserve the original HttpOnly claim/bootstrap cookies and their TTL.
			// Retrying the same owner-bound claim cannot create a generation job.
			return draftRedirect("/draft/retry", saasOrigin);
		}
		const target =
			session && isAnonymousUser(session.user)
				? "/try?draftError=unavailable"
				: effectReturn
					? `${effectReturn}${effectReturn.includes("?") ? "&" : "?"}draftError=unavailable`
					: "/create?draftError=unavailable";
		const response = draftRedirect(target, saasOrigin);
		expireHandoffCookies(response);
		return response;
	}
}

function inlineResponse(body: { status?: string; code?: string }, status = 200): NextResponse {
	return NextResponse.json(body, {
		status,
		headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
	});
}

function draftRedirect(target: string, origin: string): NextResponse {
	const response = NextResponse.redirect(new URL(target, origin));
	response.headers.set("Cache-Control", "private, no-store");
	response.headers.set("Referrer-Policy", "origin");
	response.headers.set("X-Robots-Tag", "noindex, nofollow");
	return response;
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
