import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import type {
	MediaSafetyAdapter,
	ModerateAssetInput,
	ModerateTextInput,
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

const sightengineSchema = z
	.object({
		status: z.string(),
		nudity: z.object({ sexual_activity: z.number().optional() }).optional(),
		weapon: z.number().optional(),
		data: z
			.object({
				id: z.string().optional(),
				status: z.string().optional(),
				nudity: z.object({ sexual_activity: z.number().optional() }).optional(),
			})
			.optional(),
	})
	.passthrough();
export interface SightengineOptions extends HttpClientOptions {
	apiUser: string;
	apiSecret: string;
	baseUrl?: string;
}
export class SightengineSafetyAdapter implements MediaSafetyAdapter {
	constructor(private readonly options: SightengineOptions) {}
	async moderateText(input: ModerateTextInput): Promise<ModerationDecision> {
		try {
			const data = await this.call("/text/check.json", { text: input.text });
			return scoreDecision(
				Math.max(data.nudity?.sexual_activity ?? 0, data.weapon ?? 0),
				input.ruleVersion,
			);
		} catch {
			return decision("ERROR", "MODERATION_UNAVAILABLE", input.ruleVersion);
		}
	}
	async moderateImage(input: ModerateAssetInput): Promise<ModerationDecision> {
		try {
			const data = await this.call("/check.json", { url: input.assetUrl });
			return scoreDecision(data.nudity?.sexual_activity ?? 0, input.ruleVersion);
		} catch {
			return decision("ERROR", "MODERATION_UNAVAILABLE", input.ruleVersion);
		}
	}
	async submitVideo(input: SubmitVideoInput): Promise<ModerationSubmission> {
		const data = await this.call("/video/check.json", { stream_url: input.assetUrl });
		const id = data.data?.id;
		if (!id) throw new Error("Sightengine video submission was malformed");
		return {
			moderationTaskId: id,
			status: "QUEUED",
			ruleVersion: input.ruleVersion,
			idempotency: {
				key: input.idempotencyKey,
				providerSupported: false,
				replayed: false,
			},
		};
	}
	async retrieveVideo(input: RetrieveModerationInput): Promise<ModerationDecision> {
		const data = await this.call(
			`/video/byid/${encodeURIComponent(input.moderationTaskId)}.json`,
			{},
		);
		if (data.data?.status !== "finished")
			return decision("REVIEW", "VIDEO_PROCESSING", input.ruleVersion);
		return scoreDecision(data.data.nudity?.sexual_activity ?? 0, input.ruleVersion);
	}
	private async call(
		path: string,
		body: Record<string, string>,
	): Promise<z.infer<typeof sightengineSchema>> {
		const params = new URLSearchParams({
			...body,
			api_user: this.options.apiUser,
			api_secret: this.options.apiSecret,
		});
		const { ok, data } = await fetchJson(
			`${this.options.baseUrl ?? "https://api.sightengine.com/1.0"}${path}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: params,
			},
			this.options,
		);
		if (!ok) throw new Error("Sightengine request failed");
		return sightengineSchema.parse(data);
	}
}
function scoreDecision(score: number, version: string): ModerationDecision {
	if (score >= 0.85) return decision("REJECT", "SEXUAL_CONTENT", version);
	if (score >= 0.4) return decision("REVIEW", "AMBIGUOUS_SEXUAL_CONTENT", version);
	return decision("ALLOW", "NO_POLICY_MATCH", version);
}
function decision(
	value: ModerationDecision["decision"],
	reasonCode: string,
	ruleVersion: string,
): ModerationDecision {
	return { decision: value, reasonCode, ruleVersion };
}
