import { describe, expect, it } from "vitest";

import { localMediaE2EChromiumLaunchOptions } from "./playwright-local-media";

describe("local media Playwright launch policy", () => {
	it("allows loopback storage access only for the complete production-build E2E identity", () => {
		expect(localMediaE2EChromiumLaunchOptions(localMediaE2EEnvironment())).toEqual({
			args: ["--disable-features=LocalNetworkAccessChecks"],
		});
	});

	it("keeps the browser policy unchanged for a separate marketing origin", () => {
		expect(
			localMediaE2EChromiumLaunchOptions({
				...localMediaE2EEnvironment(),
				NEXT_PUBLIC_MARKETING_URL: "http://localhost:3001",
			}),
		).toBeUndefined();
	});
});

function localMediaE2EEnvironment(): Record<string, string | undefined> {
	const databaseUrl = "postgresql://media:media@127.0.0.1:55432/media_e2e_testing";
	return {
		NODE_ENV: "production",
		E2E_USE_PRODUCTION_BUILD: "true",
		E2E_TEST_MEDIA_ADAPTERS: "true",
		E2E_RUN_ID: "media-e2e-123",
		DATABASE_URL: databaseUrl,
		TEST_DATABASE_URL: databaseUrl,
		NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
		NEXT_PUBLIC_MARKETING_URL: "http://localhost:3000",
		MEDIA_PROVIDER_ADAPTER: "mock",
		MEDIA_SAFETY_ADAPTER: "test",
		MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
	};
}
