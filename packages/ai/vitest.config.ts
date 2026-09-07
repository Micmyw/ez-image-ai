import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		env: {
			MEDIA_GENERATION_ENABLED: "true",
			MEDIA_ENABLED_PROVIDERS: "replicate,fal,kie,gemini,openrouter",
			MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED: "true",
			MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS: "2026-09-07.2",
			REPLICATE_API_TOKEN: "test-replicate-token",
			FAL_API_KEY: "test-fal-key",
			KIE_API_KEY: "test-kie-key",
			GEMINI_API_KEY: "test-gemini-key",
			OPENROUTER_API_KEY: "test-openrouter-key",
		},
	},
});
