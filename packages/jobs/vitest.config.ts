import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		env: {
			DATABASE_URL:
				process.env.TEST_DATABASE_URL ??
				"postgresql://foundation_test:foundation_test@127.0.0.1:55432/ezpic_provider_test",
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini,openrouter",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
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
