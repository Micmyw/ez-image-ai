import { defineConfig } from "vitest/config";

// Pure state and translation checks deliberately avoid shared Fumadocs generation.
export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		environment: "node",
		include: [
			"apps/saas/modules/video-v1/model.test.ts",
			"apps/saas/modules/video-v1/draft-storage.test.ts",
			"apps/saas/modules/media/lib/generator-navigation.test.ts",
			"apps/saas/modules/video-v1/messages.test.ts",
			"apps/saas/modules/video-v1/render.test.tsx",
		],
	},
});
