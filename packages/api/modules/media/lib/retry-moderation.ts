import {
	fingerprintGenerationQuoteSecurityPayload,
	type CreateGenerationQuoteInput,
	type CreateModeratedGenerationQuoteInput,
} from "@repo/database/media-quotes";

interface ApprovedSourceQuote {
	moderationDecision: string;
	moderationProvider: string;
	moderationRuleVersion: string;
	moderationReasonCode: string;
}

export function buildApprovedRetryQuote(input: {
	sourceQuote: ApprovedSourceQuote;
	quote: CreateGenerationQuoteInput;
	expectedRuleVersion: string;
}): CreateModeratedGenerationQuoteInput {
	if (
		input.sourceQuote.moderationDecision !== "ALLOW" ||
		input.sourceQuote.moderationRuleVersion !== input.expectedRuleVersion
	) {
		throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
	}
	return {
		...input.quote,
		moderation: {
			decision: "ALLOW",
			provider: input.sourceQuote.moderationProvider,
			ruleVersion: input.sourceQuote.moderationRuleVersion,
			reasonCode: input.sourceQuote.moderationReasonCode,
			inputFingerprint: fingerprintGenerationQuoteSecurityPayload(input.quote),
		},
	};
}
