import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

import { localMediaE2EChromiumLaunchOptions } from "./playwright-local-media";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

const saasBaseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const localMediaE2ELaunchOptions = localMediaE2EChromiumLaunchOptions(process.env);
const guestOnlySpecs = /(?:guest-trial|landing|originality)\.spec\.ts/;

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
		baseURL: saasBaseUrl,
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
			testIgnore: guestOnlySpecs,
			grepInvert: /insufficient credits|subscription upgrade/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/user.json",
			},
		},
		{
			name: "empty",
			dependencies: ["setup"],
			testIgnore: guestOnlySpecs,
			grep: /insufficient credits/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/empty.json",
			},
		},
		{
			name: "free",
			dependencies: ["setup"],
			testIgnore: guestOnlySpecs,
			grep: /subscription upgrade/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/free.json",
			},
		},
		{
			name: "guest",
			testMatch: guestOnlySpecs,
			use: {
				...devices["Desktop Chrome"],
				storageState: undefined,
				launchOptions: localMediaE2ELaunchOptions,
			},
		},
	],
	webServer: {
		command:
			process.env.E2E_USE_PRODUCTION_BUILD === "true"
				? "pnpm --filter saas exec next build --webpack && pnpm --filter saas run start"
				: "pnpm --filter saas exec next dev --webpack -p 3000",
		url: `${saasBaseUrl}/login`,
		reuseExistingServer: false,
		stdout: "pipe",
		timeout: 180 * 1000,
	},
});
