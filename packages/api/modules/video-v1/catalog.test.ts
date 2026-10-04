import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { VIDEO_SUPPLIER_PRICE_VERSION } from "@repo/config/video-pricing.server";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";
import { describe, expect, it } from "vitest";

import { buildVideoCatalogModels } from "./catalog";

// Placeholder configuration tests gate behavior and arithmetic only. No provider is contacted.
const environment = {
	VIDEO_V1_ENABLED: "true",
	MEDIA_GENERATION_ENABLED: "true",
	KIE_API_KEY: "fixture-only",
	KIE_WEBHOOK_SECRET: "fixture-only",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_V1_CALLBACK_BASE_URL: "https://video.example.test",
	VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
	VIDEO_V1_MODERATION_WEBHOOK_SECRET: "casec_fixture-only",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	SEEAPI_API_KEY: "fixture-only",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture-only",
	WAFFO_PRIVATE_KEY: "fixture-only",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
	VIDEO_PRICE_ACCEPTED_VERSION: VIDEO_SUPPLIER_PRICE_VERSION,
	VIDEO_PRICE_BASIS: "HYPOTHETICAL_TEST_ONLY_COSTS",
	VIDEO_PRICE_VALID_UNTIL: "2100-01-01T00:00:00.000Z",
	VIDEO_COST_MODERATION_BASE_MICROS: "10000",
	VIDEO_COST_MODERATION_PER_SECOND_MICROS: "5000",
	VIDEO_COST_RUNTIME_MICROS: "5000",
	VIDEO_COST_STORAGE_MICROS: "5000",
	VIDEO_COST_PAYMENT_FIXED_MICROS: "2000",
	VIDEO_COST_PAYMENT_FEE_BPS: "500",
	VIDEO_COST_NONBILLABLE_FAILURE_BPS: "1000",
};
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };

describe("video public catalogue pricing and readiness", () => {
	it("keeps closed access small and does not publish provider/cost configuration", () => {
		const models = buildVideoCatalogModels(environment, bindings, false, new Set());
		expect(models.every((model) => !model.available && model.options.length === 0)).toBe(true);
		const json = JSON.stringify(models);
		expect(Buffer.byteLength(json)).toBeLessThan(10 * 1024);
		expect(json).not.toMatch(/fixture-only|providerCostMicros|pricingDetails|HYPOTHETICAL/);
	});
	it("quotes each price tuple once without advertising unmapped Veo tariffs", () => {
		const models = buildVideoCatalogModels(environment, bindings, true, new Set());
		const kling = models.find((model) => model.productKey === "video-kling-2-6-v1")!;
		expect(kling.available).toBe(true);
		expect(kling.options.every((option) => option.available && /^\d+$/.test(option.credits!))).toBe(
			true,
		);
		const veo = models.find((model) => model.productKey === "video-veo-3-1")!;
		expect(veo.available).toBe(false);
		expect(veo.reasons).toContain("VIDEO_MODEL_PRICE_UNAVAILABLE");
		for (const model of models) {
			const keys = model.options.map(
				(option) => `${option.mode}:${option.duration}:${option.resolution}:${option.sound}`,
			);
			expect(new Set(keys).size).toBe(keys.length);
		}
		expect(JSON.stringify(models)).not.toMatch(
			/aspectRatio|providerCostMicros|pricingDetails|fixture-only/,
		);
	});
	it("retains native-sound options without requiring audio review configuration", () => {
		const models = buildVideoCatalogModels(environment, bindings, true, new Set());
		const kling = models.find((model) => model.productKey === "video-kling-2-6-v1")!;
		expect(
			kling.options.filter((option) => !option.sound).every((option) => option.available),
		).toBe(true);
		expect(kling.options.filter((option) => option.sound).every((option) => option.available)).toBe(
			true,
		);
	});
	it("does not advertise a new visual provider with the old provider's moderation budget", () => {
		const models = buildVideoCatalogModels(
			{
				...environment,
				VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("sightengine", 5)
					.policyVersion,
			},
			bindings,
			true,
			new Set(),
		);
		const kling = models.find((model) => model.productKey === "video-kling-2-6-v1")!;
		expect(kling.available).toBe(false);
		expect(kling.reasons).toContain("VIDEO_VISUAL_COST_POLICY_NOT_CONFIRMED");
		expect(kling.options.every((option) => !option.available && option.credits === null)).toBe(
			true,
		);
	});
	it("applies selected-model overrides without closing other priced models", () => {
		const models = buildVideoCatalogModels(
			environment,
			bindings,
			true,
			new Set(["media.model.video-kling-2-6-v1.enabled"]),
		);
		const kling = models.find((model) => model.productKey === "video-kling-2-6-v1")!;
		expect(kling.options.every((option) => !option.available)).toBe(true);
		expect(kling.commonReasons).toContain("VIDEO_DISABLED");
		expect(models.find((model) => model.productKey === "video-minimax-h3")!.available).toBe(true);
	});
	it("does not reuse a retired text provider's cost confirmation for Waffo pricing", () => {
		const models = buildVideoCatalogModels(
			{ ...environment, VIDEO_COST_TEXT_RULE_VERSION: "retired-text-policy" },
			bindings,
			true,
			new Set(),
		);
		const kling = models.find((model) => model.productKey === "video-kling-2-6-v1")!;
		expect(kling.available).toBe(false);
		expect(kling.reasons).toContain("VIDEO_TEXT_COST_POLICY_NOT_CONFIRMED");
		expect(kling.options.every((option) => !option.available && option.credits === null)).toBe(
			true,
		);
	});
	it("does not repeat shared missing gates across thousands of aspect variants", () => {
		const models = buildVideoCatalogModels({}, {}, true, new Set());
		expect(models.flatMap((model) => model.options).every((option) => !option.available)).toBe(
			true,
		);
		expect(Buffer.byteLength(JSON.stringify(models))).toBeLessThan(500 * 1024);
	});
});
