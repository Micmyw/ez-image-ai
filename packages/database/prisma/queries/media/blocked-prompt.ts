import { recordTextModerationOutcome } from "./moderation-operations";
import type { CreateModeratedGenerationQuoteInput, MediaTransactionClient } from "./types";

export interface BlockedPromptContext {
	userId: string;
	/** Server-observed at submission; never infer historical audience from today's account. */
	audience?: "GUEST" | "ACCOUNT";
	/** Comes only from the server-verified guest cookie, never a client field. */
	browserSubjectHash?: string;
	prompt: string;
	productKey: string;
	sourceAssetId: string | null;
}

export async function recordBlockedPromptAttempt(
	moderation: CreateModeratedGenerationQuoteInput["moderation"],
	context: BlockedPromptContext,
	client: MediaTransactionClient,
) {
	await client.$transaction(async (tx) => {
		await recordTextModerationOutcome(
			{ targetType: "TEXT_ATTEMPT", targetId: moderation.inputFingerprint, moderation },
			tx,
		);
		await tx.auditLog.create({
			data: {
				actorUserId: context.userId,
				action: "MEDIA_TEXT_MODERATION_BLOCKED",
				targetType: "GENERATION_QUOTE_REQUEST",
				targetId: moderation.inputFingerprint,
				after: { ...moderation },
				metadata: {
					schemaVersion: 1,
					...(context.audience ? { audience: context.audience } : {}),
					...(context.audience === "GUEST" &&
					context.browserSubjectHash &&
					/^[a-f0-9]{64}$/.test(context.browserSubjectHash)
						? { guestBrowserIdentityVersion: 1, browserSubjectHash: context.browserSubjectHash }
						: {}),
					prompt: context.prompt,
					productKey: context.productKey,
					sourceAssetId: context.sourceAssetId,
				},
			},
		});
	});
}
