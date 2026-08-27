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
});
