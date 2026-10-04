import { moderationConfiguration } from "@repo/config";

import { SeeapiSafetyAdapter } from "./seeapi";
import { TestMediaSafetyAdapter } from "./test-adapter";
import type { MediaSafetyAdapter, ModerationDecision } from "./types";

export function createConfiguredImageSafetyAdapter(
	environment: Record<string, string | undefined>,
): MediaSafetyAdapter {
	if (
		environment.MEDIA_SAFETY_ADAPTER === "test" &&
		(environment.NODE_ENV === "test" || environment.NODE_ENV === "development") &&
		environment.MEDIA_ALLOW_TEST_SAFETY_ADAPTER === "true"
	) {
		return new TestMediaSafetyAdapter();
	}
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
	if (environment.MEDIA_SAFETY_ADAPTER !== "configured") return closed;
	try {
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
