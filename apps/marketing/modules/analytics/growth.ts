import {
	trackBrowserGrowthEvent,
	type GrowthAnalyticsEvent,
	type GrowthAnalyticsTrackResult,
} from "@repo/utils";

type MarketingProductKey = "image-fast" | "image-quality";
type TrackGrowthEvent = (
	event: GrowthAnalyticsEvent,
	options?: { dedupeKey?: string },
) => Promise<GrowthAnalyticsTrackResult>;

export function createMarketingGrowthFunnel(track: TrackGrowthEvent = trackBrowserGrowthEvent) {
	return {
		landingViewed: () =>
			track({ name: "landing_viewed", properties: { status: "viewed" } }, { dedupeKey: "landing" }),
		examplePromptSelected: () =>
			track(
				{ name: "example_prompt_selected", properties: { status: "selected" } },
				{ dedupeKey: "example-prompt" },
			),
		sourceUploadStarted: (attemptKey: string, productKey: MarketingProductKey) =>
			track(
				{ name: "source_upload_started", properties: { productKey, status: "started" } },
				{ dedupeKey: `source-upload-started:${attemptKey}` },
			),
		sourceUploadCompleted: (attemptKey: string, productKey: MarketingProductKey) =>
			track(
				{ name: "source_upload_completed", properties: { productKey, status: "completed" } },
				{ dedupeKey: `source-upload-completed:${attemptKey}` },
			),
		marketingDraftCreated: (attemptKey: string, productKey: MarketingProductKey) =>
			track(
				{ name: "marketing_draft_created", properties: { productKey, status: "created" } },
				{ dedupeKey: `marketing-draft-created:${attemptKey}` },
			),
		authHandoffStarted: (attemptKey: string, productKey: MarketingProductKey) =>
			track(
				{ name: "auth_handoff_started", properties: { productKey, status: "started" } },
				{ dedupeKey: `auth-handoff-started:${attemptKey}` },
			),
	};
}

export const marketingGrowthFunnel = createMarketingGrowthFunnel();
