import { describe, expect, it } from "vitest";

import { draftClientIdentity } from "./draft-client-identity";

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
});
