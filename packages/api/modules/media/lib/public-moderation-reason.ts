import { isImageContentRejection, type ModerationDecision } from "@repo/ai";
import type { PublicModerationReason } from "@repo/config/client";

function categoryForReasonCode(reasonCode?: string): PublicModerationReason {
	switch (reasonCode) {
		case "SEXUAL_CONTENT":
			return "sexualContent";
		case "GRAPHIC_CONTENT":
		case "VIOLENT_CONTENT":
		case "WEAPON_THREAT":
			return "violence";
		case "SELF_HARM_CONTENT":
			return "selfHarm";
		case "HATE_CONTENT":
			return "hate";
		default:
			return "restrictedContent";
	}
}

export function publicImageModerationReason(
	result: { status: string; reasonCode?: string } | undefined,
): PublicModerationReason | null {
	// SeeAPI confirms the block, but its label taxonomy is not a public reason contract.
	return isImageContentRejection(result) ||
		(result?.status === "REJECTED" && result.reasonCode === "ADMIN_CONTENT_REJECTED")
		? categoryForReasonCode(result?.reasonCode)
		: null;
}

function publicTextModerationReason(result: ModerationDecision): PublicModerationReason | null {
	if (result.decision !== "REJECT") return null;
	const waffo = result.evidence?.waffo;
	if (result.reasonCode === "WAFFO_RESTRICTED_CONTENT" && waffo?.action === "block") {
		const categories = new Set(waffo.matchedCategories);
		if (categories.has("csam_minor")) return "minorSafety";
		if (
			["sexual_violence_nonconsensual", "undress_transform", "bestiality_restricted"].some(
				(category) => categories.has(category),
			)
		)
			return "sexualExploitation";
		if (categories.has("face_swap_identity")) return "identityMisuse";
		if (categories.has("adult_nsfw")) return "sexualContent";
	}
	return categoryForReasonCode(result.reasonCode);
}

/** Carries only a safe category across the API error boundary, never detector evidence. */
export class TextModerationError extends Error {
	readonly moderationReason: PublicModerationReason | null;
	readonly publicCode:
		| "CONTENT_NOT_ALLOWED"
		| "CONTENT_REVIEW_REQUIRED"
		| "TEXT_LANGUAGE_UNSUPPORTED"
		| "SAFETY_CHECK_UNAVAILABLE";
	constructor(result: ModerationDecision) {
		super(`TEXT_MODERATION_${result.decision}`);
		this.name = "TextModerationError";
		this.moderationReason = publicTextModerationReason(result);
		this.publicCode =
			result.decision === "REJECT"
				? "CONTENT_NOT_ALLOWED"
				: result.decision === "REVIEW"
					? result.reasonCode === "UNSUPPORTED_TEXT_LANGUAGE"
						? "TEXT_LANGUAGE_UNSUPPORTED"
						: "CONTENT_REVIEW_REQUIRED"
					: "SAFETY_CHECK_UNAVAILABLE";
	}
}
