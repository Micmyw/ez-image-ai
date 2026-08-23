import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
	outputDir: "test-results",
	use: {
		baseURL: "http://localhost:3000",
		trace: "on-first-retry",
		video: {
			mode: "retain-on-failure",
			size: { width: 640, height: 480 },
		},
	},
	projects: [
		{ name: "setup", testMatch: /.*\.setup\.ts/ },
		{
			name: "funded",
			dependencies: ["setup"],
			grepInvert: /insufficient credits/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/user.json",
			},
		},
		{
			name: "empty",
			dependencies: ["setup"],
			grep: /insufficient credits/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/empty.json",
			},
		},
	],
	webServer: {
		command:
			process.env.E2E_USE_PRODUCTION_BUILD === "true"
				? "pnpm --filter saas exec next build --webpack && pnpm --filter saas run start"
				: "pnpm --filter saas exec next dev --webpack -p 3000",
		url: "http://localhost:3000",
		reuseExistingServer: false,
		stdout: "pipe",
		timeout: 180 * 1000,
	},
});
