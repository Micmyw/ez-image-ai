import type { ModerateTextInput, ModerationDecision } from "@repo/ai/media/moderation/types";
import { VIDEO_TEXT_SAFETY_RULE_VERSION } from "@repo/config/video-text-safety";
import { createWaffoPromptScanner } from "@repo/payments/waffo-content-safety";

/** Reuse the merchant-signed scanner, without the image admission outage bypass. */
export async function moderateVideoText(
	input: ModerateTextInput,
	environment: Record<string, string | undefined>,
): Promise<ModerationDecision> {
	if (input.ruleVersion !== VIDEO_TEXT_SAFETY_RULE_VERSION)
		return {
			decision: "ERROR",
			reasonCode: "VIDEO_TEXT_SAFETY_PROFILE_INVALID",
			ruleVersion: input.ruleVersion,
		};
	if (!environment.WAFFO_MERCHANT_ID?.trim() || !environment.WAFFO_PRIVATE_KEY?.trim())
		return {
			decision: "ERROR",
			reasonCode: "MODERATION_CONFIGURATION_ERROR",
			ruleVersion: input.ruleVersion,
		};
	try {
		const result = await createWaffoPromptScanner(environment)(input.text);
		return {
			decision: result.decision,
			reasonCode: result.reasonCode,
			ruleVersion: input.ruleVersion,
			...(result.evidence
				? {
						evidence: {
							requestId: result.evidence.requestId,
							models: ["waffo-prompt-sift"],
							operations: 1,
							scores: {},
							waffo: result.evidence,
						},
					}
				: {}),
		};
	} catch {
		return {
			decision: "ERROR",
			reasonCode: "MODERATION_UNAVAILABLE",
			ruleVersion: input.ruleVersion,
		};
	}
}
