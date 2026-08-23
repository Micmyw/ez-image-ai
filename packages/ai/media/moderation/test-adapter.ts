import type {
	MediaSafetyAdapter,
	ModerateAssetInput,
	ModerateTextInput,
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
} from "./types";
export class TestMediaSafetyAdapter implements MediaSafetyAdapter {
	constructor(private readonly result: ModerationDecision["decision"] = "ALLOW") {}
	async moderateText(input: ModerateTextInput): Promise<ModerationDecision> {
		return this.decision(input.ruleVersion);
	}
	async moderateImage(input: ModerateAssetInput): Promise<ModerationDecision> {
		return this.decision(input.ruleVersion);
	}
	async submitVideo(input: ModerateAssetInput): Promise<ModerationSubmission> {
		return {
			moderationTaskId: `test:${input.assetUrl}`,
			status: "QUEUED",
			ruleVersion: input.ruleVersion,
		};
	}
	async retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision> {
		return this.decision(input.ruleVersion);
	}
	private decision(ruleVersion: string): ModerationDecision {
		return { decision: this.result, reasonCode: "TEST_DECISION", ruleVersion };
	}
}
