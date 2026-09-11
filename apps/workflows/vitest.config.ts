import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.workerd.test.ts"],
				},
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.test.jsonc" },
						remoteBindings: false,
					}),
				],
				test: { name: "workerd", include: ["src/workflow.workerd.test.ts"], testTimeout: 30_000 },
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.workers.test.jsonc" },
						remoteBindings: false,
					}),
				],
				test: {
					name: "worker-executor",
					include: ["src/executor.workerd.test.ts"],
					testTimeout: 30_000,
				},
			},
		],
	},
});
