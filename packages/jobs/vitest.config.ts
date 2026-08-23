import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		env: {
			MEDIA_GENERATION_ENABLED: "true",
		},
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
