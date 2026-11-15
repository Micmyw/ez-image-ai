import { claimGuestGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";

import { guestMediaProcedure } from "../guest-procedure";
import { withDraftClaimRecovery } from "../lib/draft-claim-recovery";
import { getCurrentExecutableEzPicProducts } from "../lib/executable-route-graph";

export const claimGuestDraft = guestMediaProcedure
	.route({
		method: "POST",
		path: "/media/guest-drafts/claim",
		tags: ["Media"],
		summary: "Claim a bootstrap-backed guest draft",
		description: "Consumes only a READY draft bound to the current anonymous Better Auth owner.",
	})
	.handler(async ({ context }) =>
		withDraftClaimRecovery(context, async (claimTokenHash, markStage) => {
			markStage("catalog");
			const allowedProductKeys = (await getCurrentExecutableEzPicProducts()).map(
				(product) => product.key,
			);
			if (allowedProductKeys.length === 0) throw new Error("DRAFT_SERVICE_UNAVAILABLE");
			markStage("ownership");
			return await claimGuestGenerationDraftTransaction(
				{
					claimTokenHash,
					userId: context.user.id,
					allowedProductKeys,
				},
				db,
			);
		}),
	);
