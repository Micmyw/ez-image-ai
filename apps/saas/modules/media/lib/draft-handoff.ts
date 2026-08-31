import {
	assertMarketingOrigin,
	getDraftClaimCookie,
	getGuestBootstrapCookie,
} from "@repo/api/modules/media/lib/draft-security";
import { EZPIC_ANALYTICS_SESSION_COOKIE } from "@repo/utils";
import { NextResponse } from "next/server";

export const DRAFT_HANDOFF_INTENT = "continue-marketing-draft";
export const ACCOUNT_DRAFT_HANDOFF_INTENT = "continue-account-draft";

interface DraftHandoffOptions {
	marketingOrigin: string;
	saasOrigin: string;
	secure: boolean;
	isRegistered: boolean;
}

export async function createDraftHandoffResponse(
	request: Request,
	options: DraftHandoffOptions,
): Promise<NextResponse> {
	assertMarketingOrigin(request.headers.get("origin"), options.marketingOrigin);
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/x-www-form-urlencoded")) {
		throw new Error("INVALID_DRAFT_HANDOFF");
	}
	const form = await request.formData();
	const intent = form.get("intent");
	if (intent !== DRAFT_HANDOFF_INTENT && intent !== ACCOUNT_DRAFT_HANDOFF_INTENT) {
		throw new Error("INVALID_DRAFT_HANDOFF");
	}
	const claimToken = form.get("claimToken");
	if (typeof claimToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claimToken)) {
		throw new Error("INVALID_DRAFT_HANDOFF");
	}
	const analyticsConsent = form.get("analyticsConsent");
	const anonymousSessionHash = form.get("anonymousSessionHash");
	if (
		(analyticsConsent !== null || anonymousSessionHash !== null) &&
		(analyticsConsent !== "true" ||
			typeof anonymousSessionHash !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(anonymousSessionHash))
	) {
		throw new Error("INVALID_DRAFT_HANDOFF");
	}
	const destination =
		intent === ACCOUNT_DRAFT_HANDOFF_INTENT && !options.isRegistered
			? "/login?redirectTo=%2Fdraft%2Fcontinue"
			: "/draft/continue";
	const response = NextResponse.redirect(new URL(destination, options.saasOrigin), 303);
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("Referrer-Policy", "no-referrer");
	if (analyticsConsent === "true" && typeof anonymousSessionHash === "string") {
		const analyticsCookieOptions = {
			httpOnly: false,
			sameSite: "lax" as const,
			secure: options.secure,
			path: "/",
			maxAge: 30 * 24 * 60 * 60,
		};
		response.cookies.set("consent", "true", analyticsCookieOptions);
		response.cookies.set(
			EZPIC_ANALYTICS_SESSION_COOKIE,
			anonymousSessionHash,
			analyticsCookieOptions,
		);
	}
	response.headers.append("Set-Cookie", getDraftClaimCookie(claimToken, options.secure));
	if (!options.isRegistered && intent === DRAFT_HANDOFF_INTENT) {
		response.headers.append("Set-Cookie", getGuestBootstrapCookie(claimToken, options.secure));
	}
	return response;
}
