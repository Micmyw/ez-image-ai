import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ getActiveRuntimeConfigOverrides: vi.fn(async () => []) }));
vi.mock("@repo/database/client", () => ({ db: {} }));
vi.mock("@repo/database/video-v1", () => ({
	createVideoJobRecord: vi.fn(),
	findExistingVideoAdmission: vi.fn(),
	getVideoJobRecord: vi.fn(),
	listVideoJobRecords: vi.fn(),
}));
vi.mock("@repo/database/video-v1-fulfillment", () => ({ authorizeVideoPlayback: vi.fn() }));
vi.mock("@repo/database/video-template", () => ({
	createVideoTemplateQuoteRecord: vi.fn(),
	createVideoTemplateJobRecord: vi.fn(),
	findExistingVideoTemplateAdmission: vi.fn(),
	getVideoTemplateJobRecord: vi.fn(),
	listVideoTemplateJobRecords: vi.fn(),
}));
vi.mock("./workflow-binding", () => ({ getVideoWorkflowBinding: () => undefined }));
vi.mock("@repo/config/video-pricing.server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/config/video-pricing.server")>()),
	resolveVideoModelPrice: vi.fn(() => ({
		credits: 40n,
		pricingVersion: "LOCAL_ONLY",
		pricingBasis: "HYPOTHETICAL_TEST",
		providerCostMicros: 100n,
		moderationCostMicros: 10n,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: 21944n },
	})),
}));
vi.mock("@repo/config/video-effects.server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/config/video-effects.server")>()),
	resolveVideoEffectPrice: vi.fn(() => ({
		credits: 69n,
		pricingVersion: "LOCAL_ONLY",
		pricingBasis: "HYPOTHETICAL_TEST",
		providerCostMicros: 150n,
		moderationCostMicros: 20n,
		paidFundingPolicy: { minimumUsdMicrosPerCredit: 21944n },
	})),
}));

import {
	HOTEL_LOBBY_TEMPLATE_VERSION,
	resolveVideoEffectPrice,
} from "@repo/config/video-effects.server";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { createVideoVisualSafetyProfile } from "@repo/config/video-safety";
import { createVideoTextSafetyProfile } from "@repo/config/video-text-safety";

import { requireVideoAdmission } from "./admission";
import { requireVideoTemplateAdmission } from "./template-admission";

// Real authorization, model whitelist and safety/readiness; only prices/storage are local fixtures.
const base = {
	VIDEO_V1_ENABLED: "true",
	HOTEL_LOBBY_DUO_ENABLED: "true",
	HOTEL_LOBBY_DUO_ACCESS: "authenticated",
	HOTEL_LOBBY_DUO_ACCEPTED_TEMPLATE_VERSION: HOTEL_LOBBY_TEMPLATE_VERSION,
	MEDIA_GENERATION_ENABLED: "true",
	MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
	MEDIA_ENABLED_PROVIDERS: "kie",
	VIDEO_V1_ACCESS: "internal",
	VIDEO_V1_ALLOWED_USER_IDS: "internal-owner",
	KIE_API_KEY: "fixture",
	KIE_WEBHOOK_SECRET: "fixture",
	NEXT_PUBLIC_SAAS_URL: "https://video.example.test",
	VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
	VIDEO_MODEL_ALLOWED_OPTIONS: JSON.stringify([
		{
			productKey: "video-seedance-1-5-pro",
			modes: ["image-to-video"],
			durations: [5],
			resolutions: ["720p"],
			sounds: [false],
		},
	]),
	VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
	VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
	VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
	VIDEO_COST_VISUAL_POLICY_VERSION: createVideoVisualSafetyProfile("seeapi", 5).policyVersion,
	VIDEO_COST_TEXT_RULE_VERSION: createVideoTextSafetyProfile().ruleVersion,
	SEEAPI_API_KEY: "fixture",
	SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
		whkey_test: "whsec_local_test_signing_secret_20261004",
	}),
	VIDEO_SEEAPI_CALLBACK_SECRET: "local-video-seeapi-callback-secret-20261004",
	WAFFO_MERCHANT_ID: "fixture",
	WAFFO_PRIVATE_KEY: "fixture",
	VIDEO_V1_PROVIDER_CONCURRENCY: "5",
	VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "cdn.example.test",
};
const customer = { userId: "registered-customer", role: "user" };
const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
const request = {
	effectId: "hotel-lobby-duo" as const,
	presetKey: "standard" as const,
	inputs: { leftAssetId: "left", rightAssetId: "right" },
};
beforeEach(() => vi.clearAllMocks());

describe("authenticated template admission remains scoped and funded", () => {
	it("admits an ordinary registered customer with all existing safety and funding gates", () => {
		const admitted = requireVideoTemplateAdmission(customer, base, bindings, request);
		expect(admitted.price.credits).toBe(69n);
		expect(admitted.price.paidFundingPolicy).toEqual({ minimumUsdMicrosPerCredit: 21944n });
		expect(admitted.visualSafetyProfile.provider).toBe("seeapi");
		expect(admitted.config.access).toBe("internal");
		expect(customer.role).toBe("user");
	});
	it("does not widen ordinary video access for the same customer and model", () => {
		const template = requireVideoTemplateAdmission(customer, base, bindings, request).template;
		expect(() => requireVideoAdmission(customer, base, bindings, template.video)).toThrow(
			"VIDEO_ACCESS_DENIED",
		);
	});
	it.each([undefined, "internal", "public"])(
		"denies the unlisted customer when template scope is %j",
		(scope) => {
			expect(() =>
				requireVideoTemplateAdmission(
					customer,
					{ ...base, HOTEL_LOBBY_DUO_ACCESS: scope },
					bindings,
					request,
				),
			).toThrow("VIDEO_ACCESS_DENIED");
			expect(resolveVideoEffectPrice).not.toHaveBeenCalled();
		},
	);
	it("retains internal allowlist behavior when no public setting is present", () => {
		expect(
			requireVideoTemplateAdmission(
				{ userId: "internal-owner" },
				{ ...base, HOTEL_LOBBY_DUO_ACCESS: undefined },
				bindings,
				request,
			).price.credits,
		).toBe(69n);
	});
	it.each([
		["HOTEL_LOBBY_DUO_ENABLED", "false", "VIDEO_ACCESS_DENIED"],
		["VIDEO_V1_ENABLED", "false", "VIDEO_ACCESS_DENIED"],
		["MEDIA_GENERATION_ENABLED", "false", "VIDEO_EFFECT_DISABLED"],
		["MEDIA_NANO_BANANA_2_LITE_ENABLED", "false", "VIDEO_EFFECT_DISABLED"],
		["VIDEO_MODEL_ALLOWED_OPTIONS", "[]", "VIDEO_MODEL_OPTIONS_INVALID"],
		["SEEAPI_API_KEY", "", "VIDEO_VISUAL_MODERATION_NOT_CONFIGURED"],
		["WAFFO_PRIVATE_KEY", "", "VIDEO_MODERATION_NOT_CONFIGURED"],
	])("keeps the %s gate for public template customers", (key, value, error) => {
		expect(() =>
			requireVideoTemplateAdmission(customer, { ...base, [key]: value }, bindings, request),
		).toThrow(error);
	});
	it("still requires the actual Workflow binding", () => {
		expect(() =>
			requireVideoTemplateAdmission(customer, base, { ...bindings, workflow: false }, request),
		).toThrow("VIDEO_BINDING_WORKFLOW_NOT_READY");
	});
	it("does not apply ordinary operator funding or turn a registered customer into an administrator", () => {
		const funding = JSON.stringify({
			userIds: [customer.userId],
			validUntil: "2100-01-01T00:00:00Z",
			reason: "fixture only",
		});
		const admitted = requireVideoTemplateAdmission(
			customer,
			{ ...base, VIDEO_INTERNAL_FUNDING: funding, HOTEL_LOBBY_DUO_INTERNAL_FUNDING: funding },
			bindings,
			request,
		);
		expect(admitted.price.paidFundingPolicy).toEqual({ minimumUsdMicrosPerCredit: 21944n });
	});
	it("does not bypass unapproved or expired template pricing", () => {
		vi.mocked(resolveVideoEffectPrice).mockImplementationOnce(() => {
			throw new Error("VIDEO_EFFECT_PRICE_EXPIRED");
		});
		expect(() => requireVideoTemplateAdmission(customer, base, bindings, request)).toThrow(
			"VIDEO_EFFECT_PRICE_EXPIRED",
		);
	});
});
