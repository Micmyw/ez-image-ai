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
				test: { name: "workerd", include: ["src/**/*.workerd.test.ts"], testTimeout: 30_000 },
			},
		],
	},
});
