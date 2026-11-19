import { describe, expect, it } from "vitest";

import { serveAnalyticsPolicy } from "./analytics-policy";

const origin = "https://ezimageai.com";
const endpoint = `${origin}/api/analytics/policy`;
const environment = {
	MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
	ANALYTICS_OPT_OUT_COUNTRIES: "US,CA,DE",
};

describe("the Worker analytics policy GET", () => {
	it.each<{
		name: string;
		headers: Record<string, string>;
		expected: [requiresOptIn: boolean, privacySignal: boolean, analyticsAllowed: boolean];
	}>([
		{ name: "US", headers: { "CF-IPCountry": "US" }, expected: [false, false, true] },
		{ name: "configured CA", headers: { "CF-IPCountry": "CA" }, expected: [false, false, true] },
		{ name: "EU", headers: { "CF-IPCountry": "DE" }, expected: [true, false, false] },
		{
			name: "unknown with an untrusted country header",
			headers: { "CF-IPCountry": "XX", "X-Vercel-IP-Country": "US" },
			expected: [true, false, false],
		},
		{
			name: "current explicit consent",
			headers: { "CF-IPCountry": "DE", cookie: "consent=true; consent_version=2" },
			expected: [true, false, true],
		},
		{
			name: "old explicit consent",
			headers: { "CF-IPCountry": "DE", cookie: "consent=true; consent_version=1" },
			expected: [true, false, false],
		},
		{
			name: "withdrawn consent",
			headers: { "CF-IPCountry": "US", cookie: "consent=false; consent_version=2" },
			expected: [false, false, false],
		},
		{
			name: "Global Privacy Control",
			headers: {
				"CF-IPCountry": "US",
				"Sec-GPC": "1",
				cookie: "consent=true; consent_version=2",
			},
			expected: [false, true, false],
		},
		{
			name: "Do Not Track",
			headers: { "CF-IPCountry": "US", DNT: "1" },
			expected: [false, true, false],
		},
	])("applies the private policy for $name", async ({ headers, expected }) => {
		const response = serveAnalyticsPolicy(new Request(endpoint, { headers }), environment, origin);
		expect(response?.status).toBe(200);
		const [requiresOptIn, privacySignal, analyticsAllowed] = expected;
		expect(await response?.json()).toEqual({ requiresOptIn, privacySignal, analyticsAllowed });
	});

	it("retains the explicit worldwide opt-in setting", async () => {
		const response = serveAnalyticsPolicy(
			new Request(endpoint, { headers: { "CF-IPCountry": "US" } }),
			{ ...environment, ANALYTICS_OPT_OUT_COUNTRIES: "" },
			origin,
		);
		expect(await response?.json()).toEqual({
			requiresOptIn: true,
			privacySignal: false,
			analyticsAllowed: false,
		});
	});

	it.each([undefined, "", origin])("keeps the private headers with Origin %s", (requestOrigin) => {
		const headers = new Headers();
		if (requestOrigin !== undefined) headers.set("Origin", requestOrigin);
		const response = serveAnalyticsPolicy(new Request(endpoint, { headers }), environment, origin);
		expect(response?.headers.get("Content-Type")).toBe("application/json");
		expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response?.headers.get("Vary")).toBe(
			"Cookie, CF-IPCountry, X-Vercel-IP-Country, Sec-GPC, DNT, Origin",
		);
		expect(response?.headers.get("Access-Control-Allow-Origin")).toBe(requestOrigin || null);
		expect(response?.headers.get("Access-Control-Expose-Headers")).toBe("Content-Length");
		expect(response?.headers.get("Access-Control-Allow-Credentials")).toBeNull();
		expect(response?.headers.get("Set-Cookie")).toBeNull();
		expect(response?.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response?.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
		expect(response?.headers.get("Permissions-Policy")).toBe(
			"camera=(), microphone=(), geolocation=(), payment=()",
		);
		expect(response?.headers.get("Strict-Transport-Security")).toBe(
			"max-age=63072000; includeSubDomains; preload",
		);
	});

	it("keeps HTTP preview responses free of HTTPS transport policy", () => {
		const preview = "http://localhost:8787";
		const response = serveAnalyticsPolicy(
			new Request(preview + "/api/analytics/policy"),
			environment,
			preview,
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response?.headers.get("Strict-Transport-Security")).toBeNull();
	});

	it.each([
		new Request(endpoint, { headers: { Origin: "https://another.example" } }),
		new Request(endpoint, { headers: { Origin: "null" } }),
		new Request(endpoint, { method: "HEAD" }),
		new Request(endpoint, { method: "OPTIONS" }),
		new Request(endpoint, { method: "POST" }),
		new Request(endpoint + "?probe=1"),
		new Request(endpoint + "?"),
		new Request(endpoint + "/"),
		new Request(`${origin}/api/analytics/%70olicy`),
		new Request(`${origin}/api/rpc/analytics/getPolicy`),
		new Request("https://wrong-host.example/api/analytics/policy"),
		new Request("http://ezimageai.com/api/analytics/policy"),
	])("leaves %s to the ordinary request path", (request) => {
		expect(serveAnalyticsPolicy(request, environment, origin)).toBeNull();
	});
});
