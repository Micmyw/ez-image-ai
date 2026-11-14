import path from "node:path";

import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

import { HOMEPAGE_SHOWCASE_SEEN_KEY } from "./modules/landing/lib/homepage-showcase";
import { localMediaE2EChromiumLaunchOptions } from "./playwright-local-media";

dotenv.config({ path: path.resolve(__dirname, "../../.env.local") });

const saasBaseUrl = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://localhost:3000";
const saasPort = new URL(saasBaseUrl).port || (saasBaseUrl.startsWith("https:") ? "443" : "80");
const saasHostname = new URL(saasBaseUrl).hostname.replace(/^\[|\]$/g, "");
const localMediaE2ELaunchOptions = localMediaE2EChromiumLaunchOptions(process.env);
const guestOnlySpecs = /(?:guest-trial|guest-conversion|landing|originality)\.spec\.ts/;
const publicOnlySpecs = /(?:public-routes|public-seo|models|docs|login)\.spec\.ts/;
// Retain legacy visitor storage to exercise homepage re-entry after a previous preview.
const returningVisitorState = {
	cookies: [],
	origins: [
		{
			origin: new URL(saasBaseUrl).origin,
			localStorage: [{ name: HOMEPAGE_SHOWCASE_SEEN_KEY, value: "seen" }],
		},
	],
};

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
		launchOptions: localMediaE2ELaunchOptions,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
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
			testIgnore: [guestOnlySpecs, publicOnlySpecs],
			grepInvert: /insufficient credits|subscription upgrade/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/user.json",
				// Distinct loopback clients keep unrelated suites out of one auth rate bucket.
				...(localMediaE2ELaunchOptions
					? { extraHTTPHeaders: { "x-forwarded-for": "198.18.0.11" } }
					: {}),
			},
		},
		{
			name: "empty",
			dependencies: ["setup"],
			testIgnore: [guestOnlySpecs, publicOnlySpecs],
			grep: /insufficient credits/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/empty.json",
				...(localMediaE2ELaunchOptions
					? { extraHTTPHeaders: { "x-forwarded-for": "198.18.0.12" } }
					: {}),
			},
		},
		{
			name: "free",
			dependencies: ["setup"],
			testIgnore: [guestOnlySpecs, publicOnlySpecs],
			grep: /subscription upgrade/,
			use: {
				...devices["Desktop Chrome"],
				storageState: "playwright/.auth/free.json",
				...(localMediaE2ELaunchOptions
					? { extraHTTPHeaders: { "x-forwarded-for": "198.18.0.13" } }
					: {}),
			},
		},
		{
			name: "public",
			testMatch: publicOnlySpecs,
			use: {
				...devices["Desktop Chrome"],
				storageState: returningVisitorState,
			},
		},
		{
			name: "guest",
			testMatch: guestOnlySpecs,
			use: {
				...devices["Desktop Chrome"],
				storageState: returningVisitorState,
			},
		},
	],
	webServer: {
		command:
			process.env.E2E_USE_PRODUCTION_BUILD === "true"
				? `pnpm --filter saas exec next build --webpack && pnpm --filter saas exec next start -H ${saasHostname} -p ${saasPort}`
				: `pnpm --filter saas exec next dev --webpack -H ${saasHostname} -p ${saasPort}`,
		url: `${saasBaseUrl}/login`,
		reuseExistingServer: false,
		stdout: "pipe",
		// Production mode also compiles the app before the readiness URL can respond.
		timeout: (process.env.E2E_USE_PRODUCTION_BUILD === "true" ? 600 : 180) * 1000,
	},
});
