import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import mediaConfig from "../../playwright.config";

const baseURL =
	process.env.VIDEO_V1_E2E_ORIGIN ?? process.env.NEXT_PUBLIC_SAAS_URL ?? "http://127.0.0.1:3339";
const target = new URL(baseURL);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
	throw new Error("VIDEO_UI_E2E_REQUIRES_LOOPBACK");

// Run through the guarded local-command/e2e runner, which owns the isolated server.
export default defineConfig({
	testDir: "../..",
	testMatch: [
		"**/modules/video-v1/video-v1.e2e.ts",
		"**/tests/hotel-lobby-public-routes.spec.ts",
		"**/tests/raindance-public-routes.spec.ts",
	],
	workers: 1,
	fullyParallel: false,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	outputDir: "../../../../.cache/video-v1/browser-results",
	reporter: [
		["list"],
		[
			"json",
			{ outputFile: path.resolve(__dirname, "../../../../.cache/video-v1/browser-report.json") },
		],
	],
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		launchOptions: mediaConfig.use?.launchOptions,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	webServer: mediaConfig.webServer,
});
