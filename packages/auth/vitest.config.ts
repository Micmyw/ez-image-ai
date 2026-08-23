import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["lib/**/*.test.ts"],
		exclude: ["lib/**/*.integration.test.ts"],
		fileParallelism: false,
	},
});
