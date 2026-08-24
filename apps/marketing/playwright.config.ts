import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

const saasBaseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const marketingBaseUrl = process.env.NEXT_PUBLIC_MARKETING_URL ?? "http://localhost:3001";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
	outputDir: "test-results",
	use: {
		baseURL: marketingBaseUrl,
		trace: "on-first-retry",
		video: {
			mode: "retain-on-failure",
			size: { width: 640, height: 480 },
		},
	},
	projects: [
		{ name: "setup", testMatch: /.*\.setup\.ts/ },
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
			},
		},
	],
	webServer: [
		{
			command:
				process.env.E2E_USE_PRODUCTION_BUILD === "true"
					? "pnpm --filter saas exec next build --webpack && pnpm --filter saas run start"
					: "pnpm --filter saas exec next dev --webpack -p 3000",
			url: saasBaseUrl,
			reuseExistingServer: false,
			stdout: "pipe",
			timeout: 180 * 1000,
		},
		{
			command:
				process.env.E2E_USE_PRODUCTION_BUILD === "true"
					? "pnpm --filter marketing exec next build --webpack && pnpm --filter marketing exec next start -p 3001"
					: "pnpm --filter marketing exec next dev --webpack -p 3001",
			url: marketingBaseUrl,
			reuseExistingServer: false,
			stdout: "pipe",
			timeout: 180 * 1000,
		},
	],
});
