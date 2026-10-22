import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.realtime.test.jsonc" },
			remoteBindings: false,
		}),
	],
	test: {
		name: "realtime-workerd",
		include: ["src/media-job-events.workerd.test.ts"],
		testTimeout: 15_000,
	},
});
