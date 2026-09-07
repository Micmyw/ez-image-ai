import * as utils from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

type Track = (
	event: unknown,
	options?: { dedupeKey?: string },
) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;

type EzPicProductKey =
	| "image-nano-banana-2-lite"
	| "image-nano-banana"
	| "image-nano-banana-2"
	| "image-nano-banana-pro"
	| "image-gpt-image-1-5"
	| "image-gpt-image-2"
	| "image-seedream-4-5"
	| "image-seedream-5-lite"
	| "image-seedream-5-pro";

type SaasGrowthAnalyticsModule = {
	createSaasGrowthFunnel: (track: Track) => {
		draftClaimed: (key: string, productKey: EzPicProductKey) => Promise<string>;
		quoteCreated: (key: string, productKey: EzPicProductKey, credits: number) => Promise<string>;
		generationConfirmed: (key: string, productKey: EzPicProductKey) => Promise<string>;
		generationSucceeded: (
			key: string,
			productKey: EzPicProductKey,
			latencyMs: number,
		) => Promise<string>;
		generationFailed: (
			key: string,
			productKey: EzPicProductKey,
			latencyMs: number,
		) => Promise<string>;
		resultCompared: (key: string, productKey: EzPicProductKey) => Promise<string>;
		resultDownloaded: (key: string, productKey: EzPicProductKey) => Promise<string>;
		editAgainStarted: (key: string, productKey: EzPicProductKey) => Promise<string>;
		editSessionOpened: (key: string) => Promise<string>;
		upgradePromptViewed: (productKey: EzPicProductKey) => Promise<string>;
		checkoutStarted: (key: string, plan: "creator" | "ultimate" | "studio") => Promise<string>;
		subscriptionActivated: (plan: "creator" | "ultimate" | "studio") => Promise<string>;
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
		await funnel.draftClaimed("draft-1", "image-nano-banana-2-lite");
		await funnel.quoteCreated("quote-1", "image-gpt-image-2", 17);
		await funnel.generationConfirmed("quote-1", "image-gpt-image-2");
		await funnel.generationSucceeded("job-1", "image-gpt-image-2", 16_000);
		await funnel.generationFailed("job-2", "image-seedream-5-pro", 4_500);
		await funnel.resultCompared("asset-1", "image-gpt-image-2");
		await funnel.resultDownloaded("asset-1", "image-gpt-image-2");
		await funnel.editAgainStarted("job-1", "image-gpt-image-2");
		await funnel.editSessionOpened("session-1");
		await funnel.upgradePromptViewed("image-seedream-5-pro");
		await funnel.checkoutStarted("checkout-attempt-1", "ultimate");
		await funnel.subscriptionActivated("studio");
		await funnel.guestGenerationAdmitted("guest-job-1");
		await funnel.guestResultReady("guest-job-1");
		await funnel.guestResultViewed("guest-asset-1");
		await funnel.guestWatermarkedDownloaded("guest-asset-1");
		await funnel.guestSignInCtaStarted("guest-job-1");
		await funnel.guestRegisteredSessionEstablished("guest-job-1");
		await funnel.guestResultGrantCompleted("guest-job-1");

		expect(track.mock.calls.map(([event]) => event)).toEqual([
			{
				name: "draft_claimed",
				properties: { productKey: "image-nano-banana-2-lite", status: "claimed" },
			},
			{
				name: "editor_quote_created",
				properties: {
					creditsBucket: "10-24",
					productKey: "image-gpt-image-2",
					status: "created",
				},
			},
			{
				name: "editor_generation_confirmed",
				properties: { productKey: "image-gpt-image-2", status: "confirmed" },
			},
			{
				name: "editor_generation_succeeded",
				properties: {
					latencyBucket: "15-59s",
					productKey: "image-gpt-image-2",
					status: "succeeded",
				},
			},
			{
				name: "editor_generation_failed",
				properties: {
					latencyBucket: "1-4s",
					productKey: "image-seedream-5-pro",
					status: "failed",
				},
			},
			{
				name: "result_compared",
				properties: { productKey: "image-gpt-image-2", status: "compared" },
			},
			{
				name: "result_downloaded",
				properties: { productKey: "image-gpt-image-2", status: "downloaded" },
			},
			{
				name: "edit_again_started",
				properties: { productKey: "image-gpt-image-2", status: "started" },
			},
			{ name: "edit_session_opened", properties: { status: "opened" } },
			{
				name: "upgrade_prompt_viewed",
				properties: { productKey: "image-seedream-5-pro", status: "viewed" },
			},
			{ name: "checkout_started", properties: { plan: "ultimate", status: "started" } },
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

	it("accepts Ultimate as a public-safe subscription analytics plan", () => {
		expect(
			utils.growthAnalyticsEventSchema.safeParse({
				name: "checkout_started",
				properties: { plan: "ultimate", status: "started" },
			}).success,
		).toBe(true);
	});

	it.each([
		"image-nano-banana-2-lite",
		"image-nano-banana",
		"image-nano-banana-2",
		"image-nano-banana-pro",
		"image-gpt-image-1-5",
		"image-gpt-image-2",
		"image-seedream-4-5",
		"image-seedream-5-lite",
		"image-seedream-5-pro",
	])("accepts the public-safe EzPic product key %s", (productKey) => {
		expect(
			utils.growthAnalyticsEventSchema.safeParse({
				name: "editor_generation_confirmed",
				properties: { productKey, status: "confirmed" },
			}).success,
		).toBe(true);
	});

	it.each(["image-fast", "image-quality", "video-fast", "kie", "gpt-image-2-image-to-image"])(
		"rejects retired or private routing key %s",
		(productKey) => {
			expect(
				utils.growthAnalyticsEventSchema.safeParse({
					name: "editor_generation_confirmed",
					properties: { productKey, status: "confirmed" },
				}).success,
			).toBe(false);
		},
	);

	it("uses raw domain identifiers only as internal dedupe keys", async () => {
		const createFunnel = growthAnalytics.createSaasGrowthFunnel;
		expect(createFunnel).toBeTypeOf("function");
		if (!createFunnel) return;

		const track = vi.fn<Track>().mockResolvedValue("sent");
		const funnel = createFunnel(track);
		await funnel.generationSucceeded("raw-job-id", "image-nano-banana-2-lite", 800);
		await funnel.resultDownloaded("private-asset-id", "image-nano-banana-2-lite");
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
