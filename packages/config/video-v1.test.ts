import { describe, expect, it } from "vitest";

import { VIDEO_MODEL_CATALOG_VERSION } from "./video-models";
import {
	canAccessInternalVideoV1,
	canAccessVideoV1,
	readVideoV1Config,
	resolveVideoV1CallbackBaseUrl,
	videoV1InputSchema,
	videoV1Readiness,
} from "./video-v1";
describe("video V1 configuration", () => {
	it("uses canonical SaaS origin and rejects credential/path/origin changes", () => {
		expect(resolveVideoV1CallbackBaseUrl({ NEXT_PUBLIC_SAAS_URL: "https://example.test" })).toBe(
			"https://example.test",
		);
		for (const value of [
			"http://example.test",
			"https://user:secret@example.test",
			"https://example.test/path",
			"https://example.test?secret=value",
			"https://localhost",
			"https://127.0.0.1",
		]) {
			expect(resolveVideoV1CallbackBaseUrl({ VIDEO_V1_CALLBACK_BASE_URL: value })).toBeNull();
		}
		expect(
			resolveVideoV1CallbackBaseUrl({
				NEXT_PUBLIC_SAAS_URL: "https://example.test",
				VIDEO_V1_CALLBACK_BASE_URL: "https://different.test",
			}),
		).toBeNull();
	});
	it("defaults closed and cannot open without real pricing/safety", () => {
		expect(readVideoV1Config({}).enabled).toBe(false);
		expect(videoV1Readiness({ VIDEO_V1_ENABLED: "true" }).ready).toBe(false);
		expect(videoV1Readiness({ VIDEO_V1_ENABLED: "true" }).reasons).toContain(
			"VIDEO_PRICING_NOT_CONFIGURED",
		);
	});
	it("requires Waffo and verified SeeAPI callbacks and rejects retired selectors", () => {
		const waffo = {
			WAFFO_MERCHANT_ID: "test",
			WAFFO_PRIVATE_KEY: "test",
			VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
		};
		const seeapi = videoV1Readiness({
			...waffo,
			SEEAPI_API_KEY: "test",
			VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
		});
		expect(seeapi.reasons).not.toContain("VIDEO_MODERATION_CALLBACK_NOT_CONFIGURED");
		expect(seeapi.reasons).not.toContain("VIDEO_VISUAL_MODERATION_NOT_CONFIGURED");
		expect(seeapi.reasons).toContain("VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
		expect(
			videoV1Readiness({
				...waffo,
				SEEAPI_API_KEY: "test",
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
				VIDEO_SEEAPI_CALLBACK_SECRET: "isolated-callback-url-secret-20261004",
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					whkey_current: "whsec_isolated-current-signing-secret",
				}),
			}).reasons,
		).not.toContain("VIDEO_SEEAPI_CALLBACK_NOT_CONFIGURED");
		expect(
			videoV1Readiness({ ...waffo, VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi" }).reasons,
		).toContain("VIDEO_VISUAL_MODERATION_NOT_CONFIGURED");
		expect(
			videoV1Readiness({ ...waffo, VIDEO_V1_VIDEO_SAFETY_ADAPTER: "sightengine" }).reasons,
		).toContain("VIDEO_VISUAL_MODERATION_NOT_CONFIGURED");
		expect(
			videoV1Readiness({
				...waffo,
				VIDEO_V1_TEXT_SAFETY_ADAPTER: "sightengine",
				SIGHTENGINE_API_USER: "legacy",
				SIGHTENGINE_API_SECRET: "legacy",
			}).reasons,
		).toContain("VIDEO_MODERATION_NOT_CONFIGURED");
		expect(
			videoV1Readiness({ SEEAPI_API_KEY: "test", VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi" }).reasons,
		).toContain("VIDEO_MODERATION_NOT_CONFIGURED");
	});
	it("authorizes only explicitly allowlisted members or administrators", () => {
		const config = readVideoV1Config({
			VIDEO_V1_ENABLED: "true",
			VIDEO_V1_ALLOWED_USER_IDS: "user1",
		});
		expect(canAccessVideoV1(config, { id: "user1" })).toBe(true);
		expect(canAccessVideoV1(config, { id: "user2" })).toBe(false);
		expect(canAccessVideoV1(config, { id: "operator", role: "admin" })).toBe(true);
		expect(canAccessVideoV1(config, null)).toBe(false);
	});
	it("explicitly admits registered customers without widening the internal audience", () => {
		const config = readVideoV1Config({
			VIDEO_V1_ENABLED: "true",
			VIDEO_V1_ACCESS: "authenticated",
			VIDEO_V1_ALLOWED_USER_IDS: "internal-owner",
		});
		const customer = { id: "registered-customer", role: "user", isAnonymous: false };
		expect(config.access).toBe("authenticated");
		expect(canAccessVideoV1(config, customer)).toBe(true);
		expect(canAccessInternalVideoV1(config, customer)).toBe(false);
		expect(canAccessInternalVideoV1(config, { id: "internal-owner" })).toBe(true);
		expect(canAccessVideoV1({ ...config, enabled: false }, customer)).toBe(false);
	});
	it.each([undefined, "internal", "authenticated"])(
		"rejects absent, empty and anonymous identities in scope %j",
		(scope) => {
			const config = readVideoV1Config({
				VIDEO_V1_ENABLED: "true",
				VIDEO_V1_ACCESS: scope,
				VIDEO_V1_ALLOWED_USER_IDS: "guest",
			});
			for (const user of [
				null,
				undefined,
				{ id: "", role: "admin" },
				{ id: "guest", isAnonymous: true },
				{ id: "guest", role: "admin", isAnonymous: true },
			]) {
				expect(canAccessVideoV1(config, user)).toBe(false);
				expect(canAccessInternalVideoV1(config, user)).toBe(false);
			}
		},
	);
	it.each(["public", "true", " authenticated", ""])(
		"fails closed for malformed ordinary scope %j even for administrators",
		(scope) => {
			const config = readVideoV1Config({ VIDEO_V1_ENABLED: "true", VIDEO_V1_ACCESS: scope });
			expect(config.access).toBeNull();
			expect(canAccessVideoV1(config, { id: "operator", role: "admin" })).toBe(false);
			expect(videoV1Readiness({ VIDEO_V1_ACCESS: scope }).reasons).toContain(
				"VIDEO_ACCESS_CONFIGURATION_INVALID",
			);
		},
	);
	it.each([undefined, "internal", "authenticated"])(
		"allows ready ordinary scope %j while retaining provider, safety and binding gates",
		(scope) => {
			const environment = {
				VIDEO_V1_ENABLED: "true",
				VIDEO_V1_ACCESS: scope,
				MEDIA_GENERATION_ENABLED: "true",
				NEXT_PUBLIC_SAAS_URL: "https://example.test",
				KIE_API_KEY: "test",
				KIE_WEBHOOK_SECRET: "test",
				VIDEO_MODEL_CONTRACT_VERSION: VIDEO_MODEL_CATALOG_VERSION,
				VIDEO_V1_TEXT_SAFETY_ADAPTER: "waffo",
				WAFFO_MERCHANT_ID: "test",
				WAFFO_PRIVATE_KEY: "test",
				VIDEO_V1_VIDEO_SAFETY_ADAPTER: "seeapi",
				VIDEO_V1_IMAGE_SAFETY_ADAPTER: "seeapi",
				SEEAPI_API_KEY: "test",
				VIDEO_SEEAPI_CALLBACK_SECRET: "isolated-callback-url-secret-20261004",
				SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({
					whkey_current: "whsec_isolated-current-signing-secret",
				}),
				VIDEO_V1_PROVIDER_CONCURRENCY: "1",
				VIDEO_V1_OUTPUT_ALLOWED_HOSTS: "output.example.test",
			};
			const bindings = { workflow: true, r2: true, hyperdrive: true, uploadCors: true };
			expect(videoV1Readiness(environment, bindings, { multiModel: true })).toEqual({
				ready: true,
				reasons: [],
			});
			const unready = videoV1Readiness(
				{ ...environment, KIE_API_KEY: "", SEEAPI_API_KEY: "" },
				{ ...bindings, workflow: false },
				{ multiModel: true },
			);
			expect(unready.ready).toBe(false);
			expect(unready.reasons).toEqual(
				expect.arrayContaining([
					"VIDEO_PROVIDER_NOT_CONFIGURED",
					"VIDEO_VISUAL_MODERATION_NOT_CONFIGURED",
					"VIDEO_IMAGE_MODERATION_NOT_CONFIGURED",
					"VIDEO_BINDING_WORKFLOW_NOT_READY",
				]),
			);
		},
	);
	it("counts Unicode points and applies current stricter provider prompt limit", () => {
		const base = { mode: "text-to-video", duration: 5, sound: false, aspectRatio: "16:9" };
		expect(videoV1InputSchema.safeParse({ ...base, prompt: "🦋".repeat(1000) }).success).toBe(true);
		expect(videoV1InputSchema.safeParse({ ...base, prompt: "🦋".repeat(1001) }).success).toBe(
			false,
		);
		expect(videoV1InputSchema.safeParse({ ...base, prompt: "ok", ownerId: "spoof" }).success).toBe(
			false,
		);
	});
	it("preserves legacy fingerprints while binding all new model attributes", () => {
		const legacy = {
			prompt: "A calm lake",
			duration: 5,
			sound: false,
			mode: "text-to-video",
			aspectRatio: "16:9",
		};
		expect(videoV1InputSchema.parse(legacy)).toEqual(legacy);
		expect("productKey" in videoV1InputSchema.parse(legacy)).toBe(false);
		const model = {
			...legacy,
			productKey: "video-kling-3",
			duration: 10,
			resolution: "1080p",
			sound: true,
		};
		expect(videoV1InputSchema.parse(model)).toEqual(model);
		expect(videoV1InputSchema.safeParse({ ...model, resolution: "8k" }).success).toBe(false);
		expect(videoV1InputSchema.safeParse({ ...legacy, sound: true }).success).toBe(false);
	});
	it("does not require audio moderation for the current admission policy", () => {
		const result = videoV1Readiness({}, {}, { multiModel: true, sound: true });
		expect(result.reasons).not.toContain("VIDEO_AUDIO_MODERATION_NOT_CONFIGURED");
		expect(result.reasons).not.toContain("VIDEO_PRICING_NOT_CONFIGURED");
		expect(result.ready).toBe(false);
	});
});
