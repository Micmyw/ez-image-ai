import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["provider/stripe/**/*.test.ts"],
		fileParallelism: false,
	},
});
