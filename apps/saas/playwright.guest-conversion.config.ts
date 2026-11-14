import { defineConfig, devices } from "@playwright/test";

// Browser UI and IndexedDB acceptance, with API/provider boundaries supplied by
// the spec. Never reuse the developer's browser, server, or authentication state.
const baseURL = process.env.NEXT_PUBLIC_SAAS_URL ?? "http://127.0.0.1:3314";
const target = new URL(baseURL);
const database = new URL(process.env.DATABASE_URL ?? "postgresql://missing.invalid/missing");
if (
	process.env.E2E_GUEST_CONVERSION !== "true" ||
	target.protocol !== "http:" ||
	!["127.0.0.1", "localhost"].includes(target.hostname) ||
	!target.port ||
	!["127.0.0.1", "localhost"].includes(database.hostname) ||
	!database.pathname.includes("test")
)
	throw new Error("EXPLICIT_LOCAL_GUEST_CONVERSION_E2E_REQUIRED");

export default defineConfig({
	testDir: "./tests",
	testMatch: ["login.spec.ts", "guest-conversion.spec.ts"],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	reporter: [
		["list"],
		["html", { outputFolder: "playwright-report/guest-conversion", open: "never" }],
	],
	outputDir: "test-results/guest-conversion",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		storageState: { cookies: [], origins: [] },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
	},
	webServer: {
		command: `node node_modules/next/dist/bin/next dev --webpack -H ${target.hostname} -p ${target.port}`,
		url: `${baseURL}/login`,
		reuseExistingServer: false,
		stdout: "pipe",
		timeout: 180_000,
		env: {
			MEDIA_GENERATION_ENABLED: "false",
			VIDEO_V1_ENABLED: "false",
			// The mail module initializes on API import; these specs never send mail.
			RESEND_API_KEY: "re_local_guest_conversion_fixture",
		},
	},
});
