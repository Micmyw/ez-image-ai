export type ModerationDecisionType = "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
export interface ModerateTextInput {
	text: string;
	ruleVersion: string;
}
export interface ModerateAssetInput {
	assetUrl: string;
	ruleVersion: string;
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
}
export interface MediaSafetyAdapter {
	moderateText(input: ModerateTextInput): Promise<ModerationDecision>;
	moderateImage(input: ModerateAssetInput): Promise<ModerationDecision>;
	submitVideo(input: ModerateAssetInput): Promise<ModerationSubmission>;
	retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision>;
}
