import { getSession } from "@auth/lib/server";
import { createDraftHandoffResponse } from "@media/lib/draft-handoff";
import { claimGenerationDraft } from "@repo/api/modules/media/procedures/claim-generation-draft";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
	const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL;
	if (!marketingOrigin) return new Response(null, { status: 403 });
	try {
		return await createDraftHandoffResponse(request, {
			marketingOrigin,
			secure: process.env.NODE_ENV === "production",
			isAuthenticated: Boolean(await getSession()),
		});
	} catch {
		return new Response(null, { status: 403 });
	}
}

export async function GET(request: Request) {
	if (!(await getSession())) {
		return NextResponse.redirect(new URL("/login?redirectTo=%2Fdraft%2Fcontinue", request.url));
	}
	const responseHeaders = new Headers();
	try {
		const draft = await claimGenerationDraft.callable({
			context: { headers: await headers(), responseHeaders },
		})({});
		const response = NextResponse.redirect(new URL("/create", request.url));
		for (const [name, value] of responseHeaders) response.headers.append(name, value);
		response.cookies.set("media_claimed_draft", draft.id, {
			httpOnly: true,
			sameSite: "lax",
			secure: process.env.NODE_ENV === "production",
			path: "/create",
			maxAge: 300,
		});
		return response;
	} catch {
		return NextResponse.redirect(new URL("/create", request.url));
	}
}
