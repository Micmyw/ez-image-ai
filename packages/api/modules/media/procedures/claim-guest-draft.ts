import { claimGuestGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";

import { guestMediaProcedure } from "../guest-procedure";
import {
	DRAFT_CLAIM_COOKIE,
	getExpiredDraftClaimCookie,
	hashDraftClaimToken,
} from "../lib/draft-security";
import { getCurrentExecutableEzPicProducts } from "../lib/executable-route-graph";

export const claimGuestDraft = guestMediaProcedure
	.route({
		method: "POST",
		path: "/media/guest-drafts/claim",
		tags: ["Media"],
		summary: "Claim a bootstrap-backed guest draft",
		description: "Consumes only a READY draft bound to the current anonymous Better Auth owner.",
	})
	.handler(async ({ context }) => {
		const token = readCookie(context.headers.get("cookie"), DRAFT_CLAIM_COOKIE);
		if (!token) throw new Error("DRAFT_UNAVAILABLE");
		try {
			const allowedProductKeys = (await getCurrentExecutableEzPicProducts())
				.filter((product) => product.key === "image-fast")
				.map((product) => product.key);
			if (allowedProductKeys.length === 0) throw new Error("DRAFT_UNAVAILABLE");
			return await claimGuestGenerationDraftTransaction(
				{
					claimTokenHash: hashDraftClaimToken(token),
					userId: context.user.id,
					allowedProductKeys,
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
