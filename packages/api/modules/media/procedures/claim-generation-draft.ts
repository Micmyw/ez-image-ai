import { claimGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";

import { dispatchCommittedTask } from "../../../lib/dispatch-committed-task";
import { protectedProcedure } from "../../../orpc/procedures";
import { publicAccountInputCopyStatus } from "../lib/account-input-copy-status";
import { withDraftClaimRecovery } from "../lib/draft-claim-recovery";
import { getCurrentExecutableEzPicProducts } from "../lib/executable-route-graph";

export const claimGenerationDraft = protectedProcedure
	.route({ method: "POST", path: "/media/drafts/claim", tags: ["Media"] })
	.handler(async ({ context }) =>
		withDraftClaimRecovery(context, async (claimTokenHash, markStage) => {
			markStage("catalog");
			const allowedProductKeys = (await getCurrentExecutableEzPicProducts()).map(
				(product) => product.key,
			);
			if (allowedProductKeys.length === 0) throw new Error("DRAFT_SERVICE_UNAVAILABLE");
			markStage("ownership");
			const draft = await claimGenerationDraftTransaction(
				{
					claimTokenHash,
					userId: context.user.id,
					allowedProductKeys,
				},
				db,
			);
			markStage("preparation");
			if (draft.preparation?.status === "COPYING")
				await dispatchCommittedTask(
					"media-copy-account-input",
					{ promotionId: draft.preparation.promotionId },
					`account-input-copy:${draft.preparation.promotionId}`,
					context.defer,
				);
			return {
				id: draft.id,
				productKey: draft.productKey,
				input: draft.input,
				...(draft.preparation
					? { preparation: publicAccountInputCopyStatus(draft.preparation) }
					: {}),
			};
		}),
	);
