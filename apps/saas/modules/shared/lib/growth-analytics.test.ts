import * as utils from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

type Track = (
	event: unknown,
	options?: { dedupeKey?: string },
) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;

type SaasGrowthAnalyticsModule = {
	createSaasGrowthFunnel: (track: Track) => {
		draftClaimed: (key: string, productKey: "image-fast" | "image-quality") => Promise<string>;
		quoteCreated: (
			key: string,
			productKey: "image-fast" | "image-quality",
			credits: number,
		) => Promise<string>;
		generationConfirmed: (
			key: string,
			productKey: "image-fast" | "image-quality",
		) => Promise<string>;
		generationSucceeded: (
			key: string,
			productKey: "image-fast" | "image-quality",
			latencyMs: number,
		) => Promise<string>;
		generationFailed: (
			key: string,
			productKey: "image-fast" | "image-quality",
			latencyMs: number,
		) => Promise<string>;
		resultCompared: (key: string, productKey: "image-fast" | "image-quality") => Promise<string>;
		resultDownloaded: (key: string, productKey: "image-fast" | "image-quality") => Promise<string>;
		editAgainStarted: (key: string, productKey: "image-fast" | "image-quality") => Promise<string>;
		editSessionOpened: (key: string) => Promise<string>;
		upgradePromptViewed: (productKey: "image-fast" | "image-quality") => Promise<string>;
		checkoutStarted: (key: string, plan: "creator" | "studio") => Promise<string>;
		subscriptionActivated: (plan: "creator" | "studio") => Promise<string>;
	};
};

const growthAnalytics = utils as typeof utils & Partial<SaasGrowthAnalyticsModule>;

describe("authenticated EzPic growth funnel", () => {
	it("emits every authenticated funnel event with enum and bucket properties only", async () => {
		const createFunnel = growthAnalytics.createSaasGrowthFunnel;
		expect(createFunnel).toBeTypeOf("function");
		if (!createFunnel) return;

		const track = vi.fn<Track>().mockResolvedValue("sent");
		const funnel = createFunnel(track);
		await funnel.draftClaimed("draft-1", "image-fast");
		await funnel.quoteCreated("quote-1", "image-quality", 10);
		await funnel.generationConfirmed("quote-1", "image-quality");
		await funnel.generationSucceeded("job-1", "image-quality", 16_000);
		await funnel.generationFailed("job-2", "image-fast", 4_500);
		await funnel.resultCompared("asset-1", "image-quality");
		await funnel.resultDownloaded("asset-1", "image-quality");
		await funnel.editAgainStarted("job-1", "image-quality");
		await funnel.editSessionOpened("session-1");
		await funnel.upgradePromptViewed("image-quality");
		await funnel.checkoutStarted("checkout-attempt-1", "creator");
		await funnel.subscriptionActivated("studio");

		expect(track.mock.calls.map(([event]) => event)).toEqual([
			{ name: "draft_claimed", properties: { productKey: "image-fast", status: "claimed" } },
			{
				name: "editor_quote_created",
				properties: {
					creditsBucket: "10-24",
					productKey: "image-quality",
					status: "created",
				},
			},
			{
				name: "editor_generation_confirmed",
				properties: { productKey: "image-quality", status: "confirmed" },
			},
			{
				name: "editor_generation_succeeded",
				properties: {
					latencyBucket: "15-59s",
					productKey: "image-quality",
					status: "succeeded",
				},
			},
			{
				name: "editor_generation_failed",
				properties: {
					latencyBucket: "1-4s",
					productKey: "image-fast",
					status: "failed",
				},
			},
			{
				name: "result_compared",
				properties: { productKey: "image-quality", status: "compared" },
			},
			{
				name: "result_downloaded",
				properties: { productKey: "image-quality", status: "downloaded" },
			},
			{
				name: "edit_again_started",
				properties: { productKey: "image-quality", status: "started" },
			},
			{ name: "edit_session_opened", properties: { status: "opened" } },
			{
				name: "upgrade_prompt_viewed",
				properties: { productKey: "image-quality", status: "viewed" },
			},
			{ name: "checkout_started", properties: { plan: "creator", status: "started" } },
			{
				name: "subscription_activated",
				properties: { plan: "studio", status: "activated" },
			},
		]);
	});

	it("uses raw domain identifiers only as internal dedupe keys", async () => {
		const createFunnel = growthAnalytics.createSaasGrowthFunnel;
		expect(createFunnel).toBeTypeOf("function");
		if (!createFunnel) return;

		const track = vi.fn<Track>().mockResolvedValue("sent");
		const funnel = createFunnel(track);
		await funnel.generationSucceeded("raw-job-id", "image-fast", 800);
		await funnel.resultDownloaded("private-asset-id", "image-fast");

		for (const [event] of track.mock.calls) {
			expect(JSON.stringify(event)).not.toMatch(/raw-job-id|private-asset-id/);
		}
		expect(track.mock.calls.map(([, options]) => options)).toEqual([
			{ dedupeKey: "editor-generation-succeeded:raw-job-id" },
			{ dedupeKey: "result-downloaded:private-asset-id" },
		]);
	});
});
