import { describe, expect, it } from "vitest";

import { draftClientIdentity, trustedGuestClientIdentity } from "./draft-client-identity";

describe("anonymous draft client identity", () => {
	it("does not trust generic forwarding headers without a trusted proxy strategy", () => {
		const headers = new Headers({
			"x-forwarded-for": "198.51.100.10",
			"x-real-ip": "198.51.100.11",
		});
		expect(draftClientIdentity(headers, {})).toBe("unattributed");
	});

	it("uses only the header belonging to the configured trusted platform", () => {
		const headers = new Headers({
			"x-forwarded-for": "198.51.100.10",
			"x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1",
			"cf-connecting-ip": "203.0.113.8",
		});
		expect(draftClientIdentity(headers, { MEDIA_TRUSTED_PROXY_PROVIDER: "vercel" })).toBe(
			"203.0.113.9",
		);
		expect(draftClientIdentity(headers, { MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare" })).toBe(
			"203.0.113.8",
		);
	});

	it("normalizes compressed and expanded IPv6 addresses into the same /64 bucket", () => {
		const environment = { MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare" };
		const compressed = trustedGuestClientIdentity(
			new Headers({ "cf-connecting-ip": "2001:db8:abcd:12::1" }),
			environment,
		);
		const expanded = trustedGuestClientIdentity(
			new Headers({ "cf-connecting-ip": "2001:0db8:abcd:0012:ffff:0:0:2" }),
			environment,
		);

		expect(compressed?.subnet).toBe("2001:db8:abcd:12::/64");
		expect(expanded?.subnet).toBe(compressed?.subnet);
	});

	it("uses a server-owned loopback identity for the complete local media E2E environment", () => {
		expect(trustedGuestClientIdentity(new Headers(), localMediaE2EEnvironment())).toEqual({
			ip: "127.0.0.1",
			subnet: "127.0.0.0/24",
		});
	});

	it("keeps the local E2E identity closed for a production-like non-loopback origin", () => {
		expect(
			trustedGuestClientIdentity(new Headers(), {
				...localMediaE2EEnvironment(),
				NEXT_PUBLIC_SAAS_URL: "https://saas.example",
			}),
		).toBeNull();
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
