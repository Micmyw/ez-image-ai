import { claimGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { publicAccountInputCopyStatus } from "../lib/account-input-copy-status";
import {
	DRAFT_CLAIM_COOKIE,
	getExpiredDraftClaimCookie,
	hashDraftClaimToken,
} from "../lib/draft-security";
import { getCurrentExecutableEzPicProducts } from "../lib/executable-route-graph";

export const claimGenerationDraft = protectedProcedure
	.route({ method: "POST", path: "/media/drafts/claim", tags: ["Media"] })
	.handler(async ({ context }) => {
		const token = readCookie(context.headers.get("cookie"), DRAFT_CLAIM_COOKIE);
		if (!token) throw new Error("DRAFT_UNAVAILABLE");
		try {
			const allowedProductKeys = (await getCurrentExecutableEzPicProducts()).map(
				(product) => product.key,
			);
			if (allowedProductKeys.length === 0) throw new Error("DRAFT_UNAVAILABLE");
			const draft = await claimGenerationDraftTransaction(
				{
					claimTokenHash: hashDraftClaimToken(token),
					userId: context.user.id,
					allowedProductKeys,
				},
				db,
			);
			return {
				id: draft.id,
				productKey: draft.productKey,
				input: draft.input,
				...(draft.preparation
					? { preparation: publicAccountInputCopyStatus(draft.preparation) }
					: {}),
			};
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
