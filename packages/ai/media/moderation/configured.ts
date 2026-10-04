import { assertTestModerationConfiguration, moderationConfiguration } from "@repo/config";

import { SeeapiSafetyAdapter } from "./seeapi";
import { TestMediaSafetyAdapter } from "./test-adapter";
import type { MediaSafetyAdapter, ModerationDecision } from "./types";

export function createConfiguredImageSafetyAdapter(
	environment: Record<string, string | undefined>,
): MediaSafetyAdapter {
	const unavailable = (ruleVersion: string): ModerationDecision => ({
		decision: "ERROR",
		reasonCode: "MODERATION_CONFIGURATION_ERROR",
		ruleVersion,
	});
	const closed: MediaSafetyAdapter = {
		async moderateText(input) {
			return unavailable(input.ruleVersion);
		},
		async moderateImage(input) {
			return unavailable(input.ruleVersion);
		},
		async submitVideo() {
			throw new Error("VIDEO_MODERATION_NOT_CONFIGURED");
		},
		async retrieveVideo(input) {
			return unavailable(input.ruleVersion);
		},
	};
	try {
		if (environment.MEDIA_SAFETY_ADAPTER === "test") {
			assertTestModerationConfiguration(environment);
			return new TestMediaSafetyAdapter();
		}
		if (environment.MEDIA_SAFETY_ADAPTER !== "configured") return closed;
		const config = moderationConfiguration(environment);
		if (!config.imageSeeapi || !environment.SEEAPI_API_KEY?.trim()) return closed;
		const seeapi = new SeeapiSafetyAdapter({ apiKey: environment.SEEAPI_API_KEY });
		return {
			...closed,
			submitImage: seeapi.submitImage.bind(seeapi),
			retrieveImage: seeapi.retrieveImage.bind(seeapi),
		};
	} catch {
		return closed;
	}
}
