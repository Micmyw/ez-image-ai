import * as utils from "@repo/utils";
import { describe, expect, it, vi } from "vitest";

const EXPECTED_EVENTS = [
	"landing_viewed",
	"example_prompt_selected",
	"source_upload_started",
	"source_upload_completed",
	"marketing_draft_created",
	"auth_handoff_started",
	"draft_claimed",
	"editor_quote_created",
	"editor_generation_confirmed",
	"editor_generation_succeeded",
	"editor_generation_failed",
	"result_compared",
	"result_downloaded",
	"edit_again_started",
	"edit_session_opened",
	"upgrade_prompt_viewed",
	"checkout_started",
	"subscription_activated",
	"guest_generation_admitted",
	"guest_result_ready",
	"guest_result_viewed",
	"guest_watermarked_downloaded",
	"guest_sign_in_cta_started",
	"guest_registered_session_established",
	"guest_result_grant_completed",
] as const;

type GrowthAnalyticsModule = {
	EZPIC_GROWTH_EVENT_NAMES: readonly string[];
	growthAnalyticsEventSchema: {
		safeParse: (value: unknown) => { success: boolean };
	};
	containsSensitiveAnalyticsData: (value: unknown) => boolean;
	createGrowthAnalyticsDispatcher: (options: {
		hasConsent: () => boolean;
		send: (event: unknown) => Promise<void> | void;
	}) => {
		track: (
			event: unknown,
			options?: { dedupeKey?: string },
		) => Promise<"blocked" | "duplicate" | "failed" | "rejected" | "sent">;
	};
};

const growthAnalytics = utils as typeof utils & Partial<GrowthAnalyticsModule>;

describe("EzPic growth analytics event contract", () => {
	it("exposes exactly the approved editing funnel events", () => {
		expect(growthAnalytics.EZPIC_GROWTH_EVENT_NAMES).toEqual(EXPECTED_EVENTS);
	});

	it("accepts only low-sensitivity enum and bucket properties", () => {
		const schema = growthAnalytics.growthAnalyticsEventSchema;
		expect(schema).toBeDefined();
		if (!schema) return;

		expect(
			schema.safeParse({
				name: "editor_generation_succeeded",
				properties: {
					plan: "creator",
					productKey: "image-quality",
					status: "succeeded",
					creditsBucket: "10-24",
					latencyBucket: "15-59s",
					anonymousSessionHash:
						"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				},
			}).success,
		).toBe(true);

		for (const properties of [
			{ plan: "enterprise" },
			{ productKey: "video-fast" },
			{ status: "provider-timeout-detail" },
			{ creditsBucket: "17" },
			{ latencyBucket: "17.4s" },
			{ arbitrary: "value" },
		]) {
			expect(schema.safeParse({ name: "landing_viewed", properties }).success).toBe(false);
		}
	});

	it("rejects sensitive keys and sensitive-looking values before transport", () => {
		const containsSensitiveData = growthAnalytics.containsSensitiveAnalyticsData;
		expect(containsSensitiveData).toBeTypeOf("function");
		if (!containsSensitiveData) return;

		for (const payload of [
			{ prompt: "remove the person" },
			{ fileName: "family-photo.png" },
			{ assetUrl: "https://storage.example/private.png" },
			{ signed_url: "https://storage.example/private.png?X-Amz-Signature=secret" },
			{ jobId: "cm1234567890rawjob" },
			{ email: "person@example.com" },
			{ cookie: "consent=true; session=secret" },
			{ accessToken: "Bearer secret-token" },
			{ provider: "replicate" },
			{ modelId: "provider/model-version" },
			{ providerModelId: "provider/model-version" },
			{ "Provider Model ID": "provider/model-version" },
			{ provider_model_id: "provider/model-version" },
			{ providerCostMicros: 1234 },
			{ "Provider Cost Micros": 1234 },
			{ provider_cost_micros: 1234 },
			{ providerTaskId: "task-private-1" },
			{ "Provider Task ID": "task-private-1" },
			{ provider_task_id: "task-private-1" },
			{ status: "https://cdn.example/output.png?token=secret" },
			{ status: "person@example.com" },
		]) {
			expect(containsSensitiveData(payload), JSON.stringify(payload)).toBe(true);
		}
		expect(
			containsSensitiveData({
				plan: "free",
				productKey: "image-fast",
				status: "started",
				creditsBucket: "1-9",
				latencyBucket: "under-1s",
			}),
		).toBe(false);
	});

	it("keeps consent-blocked and failed deliveries retryable and deduplicates only success", async () => {
		const createDispatcher = growthAnalytics.createGrowthAnalyticsDispatcher;
		expect(createDispatcher).toBeTypeOf("function");
		if (!createDispatcher) return;

		let consent = false;
		const send = vi
			.fn<(event: unknown) => Promise<void>>()
			.mockRejectedValueOnce(new Error("fixture transport unavailable"))
			.mockResolvedValue(undefined);
		const dispatcher = createDispatcher({
			hasConsent: () => consent,
			send,
		});
		const event = {
			name: "landing_viewed",
			properties: {
				anonymousSessionHash:
					"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			},
		};

		expect(await dispatcher.track(event, { dedupeKey: "landing:session" })).toBe("blocked");
		expect(send).not.toHaveBeenCalled();

		consent = true;
		expect(await dispatcher.track(event, { dedupeKey: "landing:session" })).toBe("failed");
		expect(await dispatcher.track(event, { dedupeKey: "landing:session" })).toBe("sent");
		expect(await dispatcher.track(event, { dedupeKey: "landing:session" })).toBe("duplicate");
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith(event);
	});

	it("rejects unsafe input at the sender even if a caller bypasses static types", async () => {
		const createDispatcher = growthAnalytics.createGrowthAnalyticsDispatcher;
		expect(createDispatcher).toBeTypeOf("function");
		if (!createDispatcher) return;

		const send = vi.fn();
		const dispatcher = createDispatcher({ hasConsent: () => true, send });
		const result = await dispatcher.track({
			name: "editor_generation_succeeded",
			properties: { prompt: "private instruction", status: "succeeded" },
		});

		expect(result).toBe("rejected");
		expect(send).not.toHaveBeenCalled();
	});
});
