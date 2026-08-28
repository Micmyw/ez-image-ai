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
		guestGenerationAdmitted: (key: string) => Promise<string>;
		guestResultReady: (key: string) => Promise<string>;
		guestResultViewed: (key: string) => Promise<string>;
		guestWatermarkedDownloaded: (key: string) => Promise<string>;
		guestSignInCtaStarted: (key: string) => Promise<string>;
		guestRegisteredSessionEstablished: (key: string) => Promise<string>;
		guestResultGrantCompleted: (key: string) => Promise<string>;
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
		await funnel.guestGenerationAdmitted("guest-job-1");
		await funnel.guestResultReady("guest-job-1");
		await funnel.guestResultViewed("guest-asset-1");
		await funnel.guestWatermarkedDownloaded("guest-asset-1");
		await funnel.guestSignInCtaStarted("guest-job-1");
		await funnel.guestRegisteredSessionEstablished("guest-job-1");
		await funnel.guestResultGrantCompleted("guest-job-1");

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
			{ name: "guest_generation_admitted", properties: { status: "admitted" } },
			{ name: "guest_result_ready", properties: { status: "ready" } },
			{ name: "guest_result_viewed", properties: { status: "viewed" } },
			{ name: "guest_watermarked_downloaded", properties: { status: "downloaded" } },
			{ name: "guest_sign_in_cta_started", properties: { status: "started" } },
			{
				name: "guest_registered_session_established",
				properties: { status: "registered" },
			},
			{ name: "guest_result_grant_completed", properties: { status: "completed" } },
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
		await funnel.guestResultGrantCompleted("private-guest-job-id");

		for (const [event] of track.mock.calls) {
			expect(JSON.stringify(event)).not.toMatch(/raw-job-id|private-asset-id|private-guest-job-id/);
		}
		expect(track.mock.calls.map(([, options]) => options)).toEqual([
			{ dedupeKey: "editor-generation-succeeded:raw-job-id" },
			{ dedupeKey: "result-downloaded:private-asset-id" },
			{ dedupeKey: "guest-result-grant-completed:private-guest-job-id" },
		]);
	});
});
