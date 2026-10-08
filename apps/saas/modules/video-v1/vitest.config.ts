import path from "node:path";

import { defineConfig } from "vitest/config";

// Pure state and translation checks deliberately avoid shared Fumadocs generation.
export default defineConfig({
	resolve: {
		alias: {
			"@media": path.resolve(import.meta.dirname, "../media"),
			"@shared": path.resolve(import.meta.dirname, "../shared"),
			"@auth": path.resolve(import.meta.dirname, "../auth"),
			"@payments": path.resolve(import.meta.dirname, "../payments"),
		},
	},
	esbuild: { jsx: "automatic" },
	test: {
		environment: "node",
		include: [
			"apps/saas/modules/video-v1/model.test.ts",
			"apps/saas/modules/video-v1/variants.test.ts",
			"apps/saas/modules/video-v1/draft-storage.test.ts",
			"apps/saas/modules/media/lib/generator-navigation.test.ts",
			"apps/saas/modules/video-v1/messages.test.ts",
			"apps/saas/modules/video-v1/render.test.tsx",
			"apps/saas/modules/video-v1/VideoWorkspace.test.tsx",
			"apps/saas/modules/video-v1/use-video.test.ts",
		],
	},
});
