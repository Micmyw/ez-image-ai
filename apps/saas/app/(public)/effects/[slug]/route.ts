import { getBaseUrl } from "@shared/lib/base-url";
import { notFound } from "next/navigation";
import { NextRequest, NextResponse } from "next/server";

import { legacyPhotoIdeaRedirect } from "../../../../modules/public-content/lib/photo-idea-legacy";

/** A route response also preserves a short-lived claimed draft issued before the URL migration. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
	const slug = (await params).slug;
	const query = Object.fromEntries(
		[...new Set(request.nextUrl.searchParams.keys())].map((key) => {
			const values = request.nextUrl.searchParams.getAll(key);
			return [key, values.length === 1 ? values[0] : values];
		}),
	);
	const target = legacyPhotoIdeaRedirect(slug, query);
	if (!target) notFound();
	const destination = new URL(target, getBaseUrl());
	const response = NextResponse.redirect(destination, 308);
	response.headers.set("Cache-Control", "private, no-store");
	const draftId = request.cookies.get("media_claimed_draft")?.value;
	if (!draftId || draftId.length > 128) return response;
	const [{ getSession }, { isAnonymousUser }] = await Promise.all([
		import("@auth/lib/server"),
		import("@repo/auth/lib/anonymous-boundary"),
	]);
	const session = await getSession();
	if (!session || isAnonymousUser(session.user)) return response;
	const [{ getClaimedGenerationDraft }, { db }] = await Promise.all([
		import("@repo/database"),
		import("@repo/database/client"),
	]);
	const draft = await getClaimedGenerationDraft({ draftId, userId: session.user.id }, db);
	if (!draft) return response;
	const cookieOptions = {
		httpOnly: true,
		sameSite: "lax" as const,
		secure: process.env.NODE_ENV === "production",
	};
	response.cookies.set("media_claimed_draft", draftId, {
		...cookieOptions,
		path: destination.pathname,
		maxAge: 300,
	});
	// Append separately: ResponseCookies keys by name, while these cookies have distinct paths.
	const expired = new NextResponse();
	expired.cookies.set("media_claimed_draft", "", {
		...cookieOptions,
		path: `/effects/${slug}`,
		maxAge: 0,
	});
	for (const cookie of expired.headers.getSetCookie())
		response.headers.append("Set-Cookie", cookie);
	return response;
}
