import { recordTextModerationOutcome } from "./moderation-operations";
import type { CreateModeratedGenerationQuoteInput, MediaTransactionClient } from "./types";

export interface BlockedPromptContext {
	userId: string;
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
					prompt: context.prompt,
					productKey: context.productKey,
					sourceAssetId: context.sourceAssetId,
				},
			},
		});
	});
}
