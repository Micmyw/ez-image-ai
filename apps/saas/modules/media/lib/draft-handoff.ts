import {
	assertMarketingOrigin,
	getDraftClaimCookie,
} from "@repo/api/modules/media/lib/draft-security";
import { NextResponse } from "next/server";

export const DRAFT_HANDOFF_INTENT = "continue-marketing-draft";

interface DraftHandoffOptions {
	marketingOrigin: string;
	saasOrigin: string;
	secure: boolean;
	isAuthenticated: boolean;
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
	if (form.get("intent") !== DRAFT_HANDOFF_INTENT) throw new Error("INVALID_DRAFT_HANDOFF");
	const claimToken = form.get("claimToken");
	if (typeof claimToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claimToken)) {
		throw new Error("INVALID_DRAFT_HANDOFF");
	}
	const target = options.isAuthenticated ? "/draft/continue" : "/login?redirectTo=/draft/continue";
	const response = NextResponse.redirect(new URL(target, options.saasOrigin), 303);
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("Referrer-Policy", "no-referrer");
	response.headers.append("Set-Cookie", getDraftClaimCookie(claimToken, options.secure));
	return response;
}
