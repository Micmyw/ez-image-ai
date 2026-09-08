import { z } from "zod";

import { fetchJson, type HttpClientOptions } from "../providers/http";
import {
	assessSightengineImage,
	assessSightengineText,
	SIGHTENGINE_IMAGE_MODELS,
	SIGHTENGINE_TEXT_MODELS,
	sightengineSuccessSchema,
} from "./sightengine-policy";
import type {
	MediaSafetyAdapter,
	ModerateAssetInput,
	ModerateTextInput,
	ModerationDecision,
	ModerationSubmission,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

const videoSchema = sightengineSuccessSchema.extend({
	data: z.object({ id: z.string().min(1).optional(), status: z.string().optional() }).passthrough(),
});
export interface SightengineOptions extends HttpClientOptions {
	apiUser: string;
	apiSecret: string;
	baseUrl?: string;
}
export class SightengineSafetyAdapter implements MediaSafetyAdapter {
	constructor(private readonly options: SightengineOptions) {}
	async moderateText(input: ModerateTextInput): Promise<ModerationDecision> {
		try {
			if (!input.text.trim() || input.text.length > 10_000) {
				return decision("ERROR", "MODERATION_INVALID_INPUT", input.ruleVersion);
			}
			// This release supports English. Other scripts must not silently pass an
			// English-only classifier. Latin script is not a full language detector.
			const letters = input.text.normalize("NFKC").match(/\p{Letter}/gu) ?? [];
			if (letters.some((letter) => !/\p{Script_Extensions=Latin}/u.test(letter))) {
				return decision("REVIEW", "UNSUPPORTED_TEXT_LANGUAGE", input.ruleVersion);
			}
			const data = await this.call("/text/check.json", {
				text: input.text,
				mode: "ml",
				lang: "en",
				models: SIGHTENGINE_TEXT_MODELS.join(","),
			});
			return assessSightengineText(data, input.ruleVersion);
		} catch {
			return decision("ERROR", "MODERATION_UNAVAILABLE", input.ruleVersion);
		}
	}
	async moderateImage(input: ModerateAssetInput): Promise<ModerationDecision> {
		try {
			const data = await this.call("/check.json", {
				url: input.assetUrl,
				models: SIGHTENGINE_IMAGE_MODELS.join(","),
			});
			return assessSightengineImage(data, input.ruleVersion);
		} catch {
			return decision("ERROR", "MODERATION_UNAVAILABLE", input.ruleVersion);
		}
	}
	async submitVideo(input: SubmitVideoInput): Promise<ModerationSubmission> {
		const data = videoSchema.parse(
			await this.call("/video/check.json", {
				stream_url: input.assetUrl,
				models: SIGHTENGINE_IMAGE_MODELS.join(","),
			}),
		);
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
		try {
			const data = videoSchema.parse(
				await this.call(`/video/byid/${encodeURIComponent(input.moderationTaskId)}.json`, {}),
			);
			if (data.data?.status !== "finished")
				return decision("REVIEW", "VIDEO_PROCESSING", input.ruleVersion);
			// Legacy video retrieval is not certified by the static-image integration.
			// Never approve its historical incomplete nudity-only result shape.
			return assessSightengineImage(
				{ ...data.data, status: "success", request: data.request },
				input.ruleVersion,
			);
		} catch {
			return decision("ERROR", "MODERATION_UNAVAILABLE", input.ruleVersion);
		}
	}
	private async call(
		path: string,
		body: Record<string, string>,
	): Promise<z.infer<typeof sightengineSuccessSchema>> {
		if (!this.options.apiUser.trim() || !this.options.apiSecret.trim()) {
			throw new Error("Sightengine credentials are missing");
		}
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
			{ maxResponseBytes: 1024 * 1024, ...this.options },
		);
		if (!ok) throw new Error("Sightengine request failed");
		return sightengineSuccessSchema.parse(data);
	}
}
function decision(
	value: ModerationDecision["decision"],
	reasonCode: string,
	ruleVersion: string,
): ModerationDecision {
	return { decision: value, reasonCode, ruleVersion };
}
