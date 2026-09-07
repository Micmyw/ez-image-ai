import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		env: {
			DATABASE_URL:
				process.env.TEST_DATABASE_URL ??
				"postgresql://foundation_test:foundation_test@127.0.0.1:55432/ezpic_provider_test",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_NANO_BANANA_2_LITE_ENABLED: "true",
			MEDIA_NANO_BANANA_ENABLED: "true",
			MEDIA_NANO_BANANA_2_ENABLED: "true",
			MEDIA_NANO_BANANA_PRO_ENABLED: "true",
			MEDIA_GPT_IMAGE_1_5_ENABLED: "true",
			MEDIA_GPT_IMAGE_2_ENABLED: "true",
			MEDIA_SEEDREAM_4_5_ENABLED: "true",
			MEDIA_SEEDREAM_5_LITE_ENABLED: "true",
			MEDIA_SEEDREAM_5_PRO_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
			MEDIA_RECOVERY_PROVIDERS: "openrouter",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2",
			REPLICATE_API_TOKEN: "test-replicate-token",
			FAL_API_KEY: "test-fal-key",
			KIE_API_KEY: "test-kie-key",
			GEMINI_API_KEY: "test-gemini-key",
			OPENROUTER_API_KEY: "test-openrouter-key",
		},
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
