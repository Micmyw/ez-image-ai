import * as analytics from "@analytics";
import { describe, expect, it, vi } from "vitest";

type Track = (
	event: unknown,
	options?: { dedupeKey?: string },
) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;

type MarketingGrowthAnalyticsModule = {
	createMarketingGrowthFunnel: (track: Track) => {
		landingViewed: () => Promise<string>;
		examplePromptSelected: () => Promise<string>;
		sourceUploadStarted: (
			attemptKey: string,
			productKey: "image-fast" | "image-quality",
		) => Promise<string>;
		sourceUploadCompleted: (
			attemptKey: string,
			productKey: "image-fast" | "image-quality",
		) => Promise<string>;
		marketingDraftCreated: (
			attemptKey: string,
			productKey: "image-fast" | "image-quality",
		) => Promise<string>;
		authHandoffStarted: (
			attemptKey: string,
			productKey: "image-fast" | "image-quality",
		) => Promise<string>;
	};
};

const growthAnalytics = analytics as typeof analytics & Partial<MarketingGrowthAnalyticsModule>;

describe("marketing editing funnel triggers", () => {
	it("emits the six marketing events with only approved low-sensitivity properties", async () => {
		const createFunnel = growthAnalytics.createMarketingGrowthFunnel;
		expect(createFunnel).toBeTypeOf("function");
		if (!createFunnel) return;

		const track = vi.fn<Track>().mockResolvedValue("sent");
		const funnel = createFunnel(track);

		await funnel.landingViewed();
		await funnel.examplePromptSelected();
		await funnel.sourceUploadStarted("upload-attempt-1", "image-fast");
		await funnel.sourceUploadCompleted("upload-attempt-1", "image-fast");
		await funnel.marketingDraftCreated("draft-attempt-1", "image-quality");
		await funnel.authHandoffStarted("draft-attempt-1", "image-quality");

		expect(track.mock.calls).toEqual([
			[{ name: "landing_viewed", properties: { status: "viewed" } }, { dedupeKey: "landing" }],
			[
				{ name: "example_prompt_selected", properties: { status: "selected" } },
				{ dedupeKey: "example-prompt" },
			],
			[
				{
					name: "source_upload_started",
					properties: { productKey: "image-fast", status: "started" },
				},
				{ dedupeKey: "source-upload-started:upload-attempt-1" },
			],
			[
				{
					name: "source_upload_completed",
					properties: { productKey: "image-fast", status: "completed" },
				},
				{ dedupeKey: "source-upload-completed:upload-attempt-1" },
			],
			[
				{
					name: "marketing_draft_created",
					properties: { productKey: "image-quality", status: "created" },
				},
				{ dedupeKey: "marketing-draft-created:draft-attempt-1" },
			],
			[
				{
					name: "auth_handoff_started",
					properties: { productKey: "image-quality", status: "started" },
				},
				{ dedupeKey: "auth-handoff-started:draft-attempt-1" },
			],
		]);
	});

	it("never places internal attempt keys in the outbound payload", async () => {
		const createFunnel = growthAnalytics.createMarketingGrowthFunnel;
		expect(createFunnel).toBeTypeOf("function");
		if (!createFunnel) return;

		const track = vi.fn<Track>().mockResolvedValue("sent");
		const funnel = createFunnel(track);
		await funnel.marketingDraftCreated("claim-token-like-internal-value", "image-fast");

		const [event, options] = track.mock.calls[0] ?? [];
		expect(JSON.stringify(event)).not.toContain("claim-token-like-internal-value");
		expect(options).toEqual({
			dedupeKey: "marketing-draft-created:claim-token-like-internal-value",
		});
	});
});
