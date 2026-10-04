import { describe, expect, it } from "vitest";

import { deploymentEnvironment, publicBuildVariables } from "./deployment";

describe("Cloudflare deployment environment", () => {
	it("does not forward a build-only video flag into the prepared environment", () => {
		const result = deploymentEnvironment(
			{
				NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
				VIDEO_V1_BUILD_ENABLED: "true",
				VIDEO_V1_ENABLED: "false",
			},
			"https://ezimageai.com",
		);
		expect(result).not.toHaveProperty("VIDEO_V1_BUILD_ENABLED");
		expect(result.VIDEO_V1_ENABLED).toBe("false");
	});
	it("expands packed video policy for preparation but excludes it from public build variables", () => {
		const policy = {
			VIDEO_V1_ACCESS: "internal",
			VIDEO_V1_ALLOWED_USER_IDS: "fixture-user",
			VIDEO_COST_STORAGE_MICROS: "100",
		};
		const environment = deploymentEnvironment(
			{
				NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
				VIDEO_V1_ENABLED: "false",
				VIDEO_RUNTIME_CONFIG: JSON.stringify(policy),
			},
			"https://ezimageai.com",
		);
		expect(environment).toMatchObject({ ...policy, VIDEO_V1_ENABLED: "false" });
		expect(publicBuildVariables(environment)).toEqual({
			NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
		});
	});
	it("excludes retired moderation variables without removing active providers or unrelated OpenAI", () => {
		const retired = {
			SIGHTENGINE_API_USER: "retired-user",
			SIGHTENGINE_API_SECRET: "retired-secret",
			MODERATION_TEXT_SIGHTENGINE_ENABLED: "true",
			MODERATION_IMAGE_SIGHTENGINE_ENABLED: "false",
			VIDEO_V1_MODERATION_WEBHOOK_SECRET: "retired-callback-secret",
			VIDEO_V1_MODERATION_CALLBACK_CONFIGURED: "true",
			VIDEO_AUDIO_SAFETY_ADAPTER: "openai-transcript",
			OPENAI_AUDIO_MODERATION_API_KEY: "retired-audio-secret",
			OPENAI_AUDIO_TRANSCRIPTION_MODEL: "retired-audio-model",
		};
		const active = {
			MEDIA_SAFETY_ADAPTER: "configured",
			MODERATION_TEXT_WAFFO_ENABLED: "true",
			MODERATION_IMAGE_SEEAPI_ENABLED: "true",
			WAFFO_MERCHANT_ID: "active-merchant",
			WAFFO_PRIVATE_KEY: "active-waffo-secret",
			SEEAPI_API_KEY: "active-seeapi-secret",
			OPENAI_API_KEY: "unrelated-openai-secret",
		};
		const environment = deploymentEnvironment(
			{ NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com", ...retired, ...active },
			"https://ezimageai.com",
		);
		expect(environment).toMatchObject(active);
		for (const key of Object.keys(retired)) expect(environment).not.toHaveProperty(key);
	});
	it("keeps the explicit production safety switches after removing test credentials", () => {
		const environment = deploymentEnvironment(
			{
				NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
				E2E_TEST_MEDIA_ADAPTERS: "true",
				LOAD_TESTING_ENABLED: "true",
				E2E_USER_PASSWORD: "private",
			},
			"https://ezimageai.com",
		);
		expect(environment).toMatchObject({
			E2E_TEST_MEDIA_ADAPTERS: "false",
			E2E_DRAFT_HANDOFF: "false",
			LOAD_TESTING_ENABLED: "false",
			LEGACY_AI_STREAM_ENABLED: "false",
		});
		expect(environment.E2E_USER_PASSWORD).toBeUndefined();
	});
	it("does not include a malformed database credential in a preparation error", () => {
		expect(() =>
			deploymentEnvironment(
				{
					NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
					DATABASE_URL: "private-invalid-connection",
				},
				"https://ezimageai.com",
			),
		).toThrow("INVALID_DATABASE_URL");
	});
	it("does not put server credentials into public image build arguments", () => {
		expect(
			publicBuildVariables({
				NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
				DATABASE_URL: "private-db",
				KIE_API_KEY: "private-provider",
				SEEAPI_API_KEY: "private-moderation",
				MODERATION_IMAGE_SEEAPI_ENABLED: "true",
				WORKFLOWS_DISPATCH_SECRET: "private-dispatch",
			}),
		).toEqual({ NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com" });
	});
	it("rejects accidentally public credentials rather than silently packaging them", () => {
		expect(() => publicBuildVariables({ NEXT_PUBLIC_KIE_API_KEY: "private" })).toThrow(
			"UNRECOGNIZED_PUBLIC_VARIABLE: NEXT_PUBLIC_KIE_API_KEY",
		);
	});
	it("includes configured website analytics IDs in the public build", () => {
		expect(
			publicBuildVariables({
				NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: "G-TEST123456",
				NEXT_PUBLIC_CLARITY_PROJECT_ID: "testproject1",
			}),
		).toEqual({
			NEXT_PUBLIC_GOOGLE_ANALYTICS_ID: "G-TEST123456",
			NEXT_PUBLIC_CLARITY_PROJECT_ID: "testproject1",
		});
	});
	it("maps the verified public database CA to its container path without changing credentials", () => {
		const result = deploymentEnvironment(
			{
				NODE_ENV: "development",
				NEXT_PUBLIC_SAAS_URL: "https://ezimageai.com",
				DATABASE_URL:
					"postgresql://ezpic_app:secret@db.example.supabase.co/postgres?sslmode=verify-full&sslrootcert=D%3A%2Frepo%2Fsupabase-prod-ca-2021.crt",
				LOAD_USER_SESSION_COOKIE: "private-test-cookie",
			},
			"https://ezimageai.com",
		);
		const url = new URL(result.DATABASE_URL);
		expect(url.searchParams.get("sslrootcert")).toBe(
			"/app/tooling/certificates/supabase-prod-ca-2021.crt",
		);
		expect(url.searchParams.get("sslmode")).toBe("verify-full");
		expect(url.password).toBe("secret");
		expect(result.NODE_ENV).toBe("production");
		expect(result.LOAD_USER_SESSION_COOKIE).toBeUndefined();
	});
	it("rejects a deployment that points at a different canonical site", () => {
		expect(() =>
			deploymentEnvironment(
				{ NEXT_PUBLIC_SAAS_URL: "https://elsewhere.example" },
				"https://ezimageai.com",
			),
		).toThrow("WEB_ORIGIN_MISMATCH");
	});
});
