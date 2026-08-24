import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		env: {
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini",
			REPLICATE_API_TOKEN: "test-replicate-token",
			FAL_API_KEY: "test-fal-key",
			KIE_API_KEY: "test-kie-key",
			GEMINI_API_KEY: "test-gemini-key",
			RESEND_API_KEY: "re_test_api_key",
		},
		fileParallelism: false,
	},
});
