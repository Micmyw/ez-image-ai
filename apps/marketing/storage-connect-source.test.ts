import { describe, expect, it } from "vitest";

import { resolveMarketingStorageConnectSource } from "./storage-connect-source";

describe("marketing storage connect source", () => {
	it("allows the exact loopback storage origin for the complete local production-build E2E identity", () => {
		expect(resolveMarketingStorageConnectSource(localMediaE2EEnvironment())).toBe(
			"http://127.0.0.1:9000",
		);
	});

	it("rejects loopback storage for a separate marketing origin", () => {
		expect(
			resolveMarketingStorageConnectSource({
				...localMediaE2EEnvironment(),
				NEXT_PUBLIC_MARKETING_URL: "http://localhost:3001",
			}),
		).toBeNull();
	});

	it("normalizes an HTTPS storage endpoint without exposing its path or query", () => {
		expect(
			resolveMarketingStorageConnectSource({
				NODE_ENV: "production",
				S3_ENDPOINT: "https://storage.example/private?signature=secret",
			}),
		).toBe("https://storage.example");
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
		S3_ENDPOINT: "http://127.0.0.1:9000/media-private",
	};
}
