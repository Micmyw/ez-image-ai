export type ModerationDecisionType = "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
export interface ModerateTextInput {
	text: string;
	ruleVersion: string;
}
export interface ModerateAssetInput {
	assetUrl: string;
	ruleVersion: string;
}
export interface SubmitVideoInput extends ModerateAssetInput {
	idempotencyKey: string;
}
export interface RetrieveModerationInput {
	moderationTaskId: string;
	ruleVersion: string;
}
export interface ModerationDecision {
	decision: ModerationDecisionType;
	reasonCode: string;
	ruleVersion: string;
}
export interface ModerationSubmission {
	moderationTaskId: string;
	status: "QUEUED" | "RUNNING";
	ruleVersion: string;
	idempotency: {
		key: string;
		providerSupported: boolean;
		replayed: boolean;
	};
}
export interface MediaSafetyAdapter {
	moderateText(input: ModerateTextInput): Promise<ModerationDecision>;
	moderateImage(input: ModerateAssetInput): Promise<ModerationDecision>;
	submitVideo(input: SubmitVideoInput): Promise<ModerationSubmission>;
	retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision>;
}
export const MEDIA_VERIFICATION_RULE_VERSION = "media-safety-2026-08-23.1";
export const MEDIA_VERIFICATION_POLICY_VERSION = "media-policy-2026-08-23.1";
