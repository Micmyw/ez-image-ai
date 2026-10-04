import {
	videoVisualSafetyProfileSchema,
	type VideoVisualSafetyProfile,
} from "@repo/config/video-safety";

import type { HttpClientOptions } from "../providers/http";
import { SeeapiSafetyAdapter } from "./seeapi";
import { SeeapiVideoSafetyAdapter } from "./seeapi-video";
import type {
	MediaSafetyAdapter,
	ModerationDecision,
	RetrieveModerationInput,
	SubmitVideoInput,
} from "./types";

function error(reasonCode: string, ruleVersion: string): ModerationDecision {
	return { decision: "ERROR", reasonCode, ruleVersion };
}

/** Only SeeAPI visual review is executable. Text review is owned by the jobs Waffo path. */
export function createConfiguredVideoSafetyAdapter(
	environment: Record<string, string | undefined>,
	options: HttpClientOptions = {},
	profile?: VideoVisualSafetyProfile,
): MediaSafetyAdapter {
	const frozenProfile = profile ? videoVisualSafetyProfileSchema.parse(profile) : undefined;
	const visualProvider = frozenProfile?.provider ?? environment.VIDEO_V1_VIDEO_SAFETY_ADAPTER;
	const unavailableReason =
		visualProvider === "sightengine"
			? "VIDEO_VISUAL_PROVIDER_RETIRED"
			: "VIDEO_MODERATION_NOT_CONFIGURED";
	function bindProfile<T extends SubmitVideoInput | RetrieveModerationInput>(input: T): T {
		if (!frozenProfile) return input;
		if (
			input.ruleVersion !== frozenProfile.ruleVersion ||
			(input.visualSafetyProfile &&
				JSON.stringify(videoVisualSafetyProfileSchema.parse(input.visualSafetyProfile)) !==
					JSON.stringify(frozenProfile))
		)
			throw new Error("VIDEO_SAFETY_PROFILE_INVALID");
		return { ...input, visualSafetyProfile: frozenProfile };
	}
	const credentials = { ...options, apiKey: environment.SEEAPI_API_KEY ?? "" };
	const video = new SeeapiVideoSafetyAdapter(credentials);
	const image =
		environment.VIDEO_V1_IMAGE_SAFETY_ADAPTER === "seeapi"
			? new SeeapiSafetyAdapter(credentials)
			: null;
	return {
		async moderateText(input) {
			return error("VIDEO_TEXT_MODERATION_USE_WAFFO", input.ruleVersion);
		},
		async moderateImage(input) {
			// SeeAPI image review requires a durable asynchronous submission and key.
			return error("MODERATION_ASYNC_IMAGE_REQUIRED", input.ruleVersion);
		},
		async submitVideo(input) {
			if (visualProvider !== "seeapi") throw new Error(unavailableReason);
			return video.submitVideo(bindProfile(input));
		},
		async retrieveVideo(input) {
			if (visualProvider !== "seeapi") return error(unavailableReason, input.ruleVersion);
			return video.retrieveVideo(bindProfile(input));
		},
		...(image
			? {
					submitImage: image.submitImage.bind(image),
					retrieveImage: image.retrieveImage.bind(image),
				}
			: {}),
	};
}
