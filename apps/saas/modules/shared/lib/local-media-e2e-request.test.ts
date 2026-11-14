import {
	getRequestFreeEligibility,
	runWithCloudflareFreeEligibility,
} from "@repo/utils/free-eligibility";
import { describe, expect, it } from "vitest";

import { runLocalMediaE2ERequest } from "./local-media-e2e-request";

const databaseUrl = "postgresql://test:test@127.0.0.1:55434/media_e2e_test";
const environment = {
	NODE_ENV: "production",
	E2E_USE_PRODUCTION_BUILD: "true",
	E2E_TEST_MEDIA_ADAPTERS: "true",
	E2E_RUN_ID: "media-release-test",
	DATABASE_URL: databaseUrl,
	TEST_DATABASE_URL: databaseUrl,
	NEXT_PUBLIC_SAAS_URL: "http://localhost:3000",
	MEDIA_PROVIDER_ADAPTER: "mock",
	MEDIA_SAFETY_ADAPTER: "test",
	MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "true",
};

describe("loopback media fixture platform context", () => {
	it("supplies fixed eligible-region evidence only inside the local request", () => {
		expect(
			runLocalMediaE2ERequest(
				new Request("http://localhost:3000/api/test"),
				getRequestFreeEligibility,
				environment,
			),
		).toEqual({ status: "eligible", countryCode: "US" });
		expect(getRequestFreeEligibility().status).toBe("unverified");
	});
	it.each([
		{ E2E_TEST_MEDIA_ADAPTERS: "false" },
		{
			DATABASE_URL: "postgresql://test:test@database.example/media_test",
			TEST_DATABASE_URL: "postgresql://test:test@database.example/media_test",
		},
		{ MEDIA_PROVIDER_ADAPTER: "configured" },
		{ NEXT_PUBLIC_SAAS_URL: "https://example.com" },
	])("never replaces trusted production country for %s", (override) => {
		expect(
			runWithCloudflareFreeEligibility("IN", () =>
				runLocalMediaE2ERequest(
					new Request("http://localhost:3000/api/test", { headers: { "cf-ipcountry": "US" } }),
					getRequestFreeEligibility,
					{ ...environment, ...override },
				),
			),
		).toEqual({ status: "excluded", countryCode: "IN" });
	});
	it("requires the actual request to match the guarded loopback origin", () => {
		expect(
			runLocalMediaE2ERequest(
				new Request("https://example.com/api/test"),
				getRequestFreeEligibility,
				environment,
			).status,
		).toBe("unverified");
	});
});
