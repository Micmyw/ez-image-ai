import type { VideoVisualSafetyProfile } from "@repo/config/video-safety";

export type ModerationDecisionType = "ALLOW" | "REJECT" | "REVIEW" | "ERROR";

/** Only explicit classifier rejections qualify for output-block billing. */
export function isImageContentRejection(
	evidence: { status: string; reasonCode?: string } | undefined,
): boolean {
	return (
		evidence?.status === "REJECTED" &&
		[
			"SEEAPI_CONTENT_NOT_ALLOWED",
			"SEXUAL_CONTENT",
			"GRAPHIC_CONTENT",
			"VIOLENT_CONTENT",
			"WEAPON_THREAT",
			"SELF_HARM_CONTENT",
		].includes(evidence.reasonCode ?? "")
	);
}
export interface ModerateTextInput {
	text: string;
	ruleVersion: string;
}
export interface ModerateAssetInput {
	assetUrl: string;
	ruleVersion: string;
}
export interface SubmitVideoInput extends ModerateAssetInput {
	callbackUrl?: string;
	visualSafetyProfile?: VideoVisualSafetyProfile;
	idempotencyKey: string;
	video?: { durationMillis: number; audioTrackIds: number[] };
}
export interface RetrieveModerationInput {
	visualSafetyProfile?: VideoVisualSafetyProfile;
	moderationTaskId: string;
	ruleVersion: string;
	video?: { durationMillis: number; audioTrackIds: number[] };
}
export interface ModerationDecision {
	decision: ModerationDecisionType;
	reasonCode: string;
	ruleVersion: string;
	/** Server-only allowlisted diagnostics; never raw provider payloads or input media. */
	evidence?: ModerationEvidence;
}
export type ModerationEvidence = {
	video?: {
		complete: true;
		durationMillis?: number;
		frameCount: number;
		firstFrameSeconds: number;
		lastFrameSeconds: number;
	};
	audio?: {
		complete: true;
		trackIds: number[];
		durationMillis: number;
		language: string;
		transcriptModerated: true;
		policyVersion: string;
	};
	requestId: string;
	models: string[];
	operations: number;
	scores: Record<string, number>;
	waffo?: {
		requestId: string;
		action: "allow" | "review" | "block";
		semanticStatus: string;
		matchedCategories: string[];
	};
	seeapi?: { taskId: string; flagged: boolean; nsfw: string[]; specialCare: string[] };
	seeapiVideo?: {
		taskId: string;
		model: "video-nsfw-filter";
		scope: "sampled_frames";
		samplingComplete: true;
		requestedFrames: number;
		checkedFrames: number;
		maxFrameGapSeconds: number;
		timestampSource: "frame_index_div_fps_estimate";
		reportSchemaVersion: 5;
		thresholdOffset: 0;
		strictSpecialCare: true;
		returnFrames: "none";
		flagged: boolean;
		flaggedFrameCount: number;
		nsfw: string[];
		specialCare?: string[];
		specialCareReportedFrames: number;
	};
};
export interface ModerationSubmission {
	/** Optional immediate terminal evidence; old image consumers may continue polling. */
	completedDecision?: ModerationDecision;
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
	submitImage?(input: SubmitVideoInput): Promise<ModerationSubmission>;
	retrieveImage?(
		input: RetrieveModerationInput & { assetUrl: string },
	): Promise<ModerationDecision>;
	submitVideo(input: SubmitVideoInput): Promise<ModerationSubmission>;
	retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision>;
}
export const MEDIA_VERIFICATION_RULE_VERSION = "media-safety-2026-09-08.1";
export const MEDIA_VERIFICATION_POLICY_VERSION = "media-policy-2026-09-08.2";
