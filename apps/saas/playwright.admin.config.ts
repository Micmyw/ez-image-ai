import { defineConfig, devices } from "@playwright/test";

// This suite creates its own disposable users and uses the real sign-in form.
// Do not load the developer's dotenv files or share media E2E authentication.
const baseURL = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://127.0.0.1:3310";
const target = new URL(baseURL);
if (
	process.env.E2E_ADMIN_CAPABILITIES !== "true" ||
	target.protocol !== "http:" ||
	!["127.0.0.1", "localhost"].includes(target.hostname) ||
	!target.port
)
	throw new Error("EXPLICIT_LOCAL_ADMIN_E2E_REQUIRED");

export default defineConfig({
	testDir: "./tests",
	testMatch: "admin-capabilities.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 20_000 },
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report/admin-capabilities", open: "never" }],
	],
	outputDir: "test-results/admin-capabilities",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		storageState: { cookies: [], origins: [] },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
	},
	webServer: {
		command:
			process.env.E2E_USE_PRODUCTION_BUILD === "true"
				? `node node_modules/next/dist/bin/next start -H ${target.hostname} -p ${target.port}`
				: `node node_modules/next/dist/bin/next dev --webpack -H ${target.hostname} -p ${target.port}`,
		url: `${baseURL}/login`,
		reuseExistingServer: false,
		stdout: "pipe",
		timeout: 180_000,
	},
});
