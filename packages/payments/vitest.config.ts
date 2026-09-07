import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		env: {
			DATABASE_URL:
				process.env.TEST_DATABASE_URL ??
				"postgresql://foundation_test:foundation_test@127.0.0.1:55432/ezpic_provider_test",
		},
		include: ["**/*.test.ts"],
		fileParallelism: false,
	},
});
