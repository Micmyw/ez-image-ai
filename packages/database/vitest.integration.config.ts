import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"prisma/queries/media/**/*.integration.test.ts",
			"prisma/queries/admin-*.integration.test.ts",
			"shared/admin-analytics.sql.integration.test.ts",
		],
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
