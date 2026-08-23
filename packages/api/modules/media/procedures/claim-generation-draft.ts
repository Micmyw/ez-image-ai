import { claimGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import {
	DRAFT_CLAIM_COOKIE,
	getExpiredDraftClaimCookie,
	hashDraftClaimToken,
} from "../lib/draft-security";

export const claimGenerationDraft = protectedProcedure
	.route({ method: "POST", path: "/media/drafts/claim", tags: ["Media"] })
	.handler(async ({ context }) => {
		const token = readCookie(context.headers.get("cookie"), DRAFT_CLAIM_COOKIE);
		if (!token) throw new Error("DRAFT_UNAVAILABLE");
		try {
			return await claimGenerationDraftTransaction(
				{
					claimTokenHash: hashDraftClaimToken(token),
					userId: context.user.id,
				},
				db,
			);
		} finally {
			context.responseHeaders?.append(
				"Set-Cookie",
				getExpiredDraftClaimCookie(process.env.NODE_ENV === "production"),
			);
		}
	});

function readCookie(header: string | null, name: string): string | null {
	for (const entry of header?.split(";") ?? []) {
		const [key, ...value] = entry.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return null;
}
