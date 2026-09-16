import { moderationConfiguration } from "@repo/config";

import { SeeapiSafetyAdapter } from "./seeapi";
import { SightengineSafetyAdapter } from "./sightengine";
import { TestMediaSafetyAdapter } from "./test-adapter";
import type { MediaSafetyAdapter, ModerationDecision } from "./types";

export function createConfiguredImageSafetyAdapter(
	environment: Record<string, string | undefined>,
): MediaSafetyAdapter {
	const config = moderationConfiguration(environment);
	if (environment.MEDIA_SAFETY_ADAPTER === "test" || !environment.MEDIA_SAFETY_ADAPTER) {
		return new TestMediaSafetyAdapter(environment.NODE_ENV === "test" ? "ALLOW" : "ERROR");
	}
	const sightengine = config.imageSightengine
		? new SightengineSafetyAdapter({
				apiUser: environment.SIGHTENGINE_API_USER ?? "",
				apiSecret: environment.SIGHTENGINE_API_SECRET ?? "",
			})
		: undefined;
	const seeapi = config.imageSeeapi
		? new SeeapiSafetyAdapter({ apiKey: environment.SEEAPI_API_KEY ?? "" })
		: undefined;
	const unavailable = (ruleVersion: string): ModerationDecision => ({
		decision: "ERROR",
		reasonCode: "MODERATION_CONFIGURATION_ERROR",
		ruleVersion,
	});
	return {
		async moderateText(input) {
			return unavailable(input.ruleVersion);
		},
		async moderateImage(input) {
			return !seeapi && sightengine
				? sightengine.moderateImage(input)
				: unavailable(input.ruleVersion);
		},
		async submitVideo(input) {
			if (!seeapi && sightengine) return sightengine.submitVideo(input);
			throw new Error("VIDEO_MODERATION_NOT_CONFIGURED");
		},
		async retrieveVideo(input) {
			return !seeapi && sightengine
				? sightengine.retrieveVideo(input)
				: unavailable(input.ruleVersion);
		},
		...(seeapi
			? {
					submitImage: seeapi.submitImage.bind(seeapi),
					async retrieveImage(
						input: Parameters<NonNullable<MediaSafetyAdapter["retrieveImage"]>>[0],
					) {
						const primary = await seeapi.retrieveImage(input);
						if (!sightengine || primary.decision === "REJECT" || primary.decision === "REVIEW")
							return primary;
						const secondary = await sightengine.moderateImage(input);
						if (primary.decision === "ERROR" && secondary.decision === "ALLOW") return primary;
						return {
							...secondary,
							...(secondary.evidence
								? {
										evidence: {
											...secondary.evidence,
											models: [...(primary.evidence?.models ?? []), ...secondary.evidence.models],
											operations:
												(primary.evidence?.operations ?? 0) + secondary.evidence.operations,
											seeapi: primary.evidence?.seeapi,
										},
									}
								: {}),
						};
					},
				}
			: {}),
	};
}
