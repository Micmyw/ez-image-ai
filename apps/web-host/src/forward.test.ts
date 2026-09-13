import { describe, expect, it, vi } from "vitest";

import { forwardToWebsite, websiteEnvironment } from "./forward";

const origin = "https://ezimageai.com";
const webhookOrigin = "https://ezimageai-site-production.account.workers.dev";

describe("website ingress", () => {
	it("forwards only the configured alternate payment endpoint with untouched signed bytes", async () => {
		const body = '{\n  "id": "event-id", "amount": "79.00"\n}';
		const fetchWebsite = vi.fn(async (request: Request) => {
			expect(request.url).toBe(`${origin}/api/webhooks/payments`);
			expect(request.method).toBe("POST");
			expect(await request.text()).toBe(body);
			expect(request.headers.get("paypal-transmission-sig")).toBe("signature");
			expect(request.headers.get("paypal-transmission-id")).toBe("transmission-id");
			expect(request.headers.get("host")).toBe("ezimageai.com");
			expect(request.headers.get("x-forwarded-host")).toBe("ezimageai.com");
			expect(request.headers.get("forwarded")).toBeNull();
			return new Response(null, { status: 204 });
		});
		const response = await forwardToWebsite(
			new Request(`${webhookOrigin}/api/webhooks/payments`, {
				method: "POST",
				body,
				headers: {
					"paypal-transmission-sig": "signature",
					"paypal-transmission-id": "transmission-id",
					forwarded: "host=attacker.example",
				},
			}),
			origin,
			fetchWebsite,
			webhookOrigin,
		);
		expect(response.status).toBe(204);
		expect(fetchWebsite).toHaveBeenCalledOnce();
	});
	it.each([
		[`${webhookOrigin}/`, "GET"],
		[`${webhookOrigin}/api/auth/sign-in/email`, "POST"],
		[`${webhookOrigin}/api/webhooks/payments`, "GET"],
		[`${webhookOrigin}/api/webhooks/payments?provider=paypal`, "POST"],
		[`${webhookOrigin}/api/webhooks/payments/`, "POST"],
		["http://ezimageai-site-production.account.workers.dev/api/webhooks/payments", "POST"],
		["https://another.account.workers.dev/api/webhooks/payments", "POST"],
	])("rejects alternate-origin access outside the exact callback: %s %s", async (url, method) => {
		const fetchWebsite = vi.fn();
		const response = await forwardToWebsite(
			new Request(url, { method }),
			origin,
			fetchWebsite,
			webhookOrigin,
		);
		expect(response.status).toBe(421);
		expect(fetchWebsite).not.toHaveBeenCalled();
	});
	it("keeps the alternate callback closed unless explicitly configured", async () => {
		const fetchWebsite = vi.fn();
		const response = await forwardToWebsite(
			new Request(`${webhookOrigin}/api/webhooks/payments`, { method: "POST" }),
			origin,
			fetchWebsite,
		);
		expect(response.status).toBe(421);
		expect(fetchWebsite).not.toHaveBeenCalled();
	});
	it.each(["GET", "HEAD"])(
		"permanently upgrades same-host HTTP %s without invoking the application",
		async (method) => {
			const fetchWebsite = vi.fn();
			const response = await forwardToWebsite(
				new Request("http://ezimageai.com/blog/prompt-guide?source=hello%20world", { method }),
				origin,
				fetchWebsite,
			);
			expect(response.status).toBe(308);
			expect(response.headers.get("location")).toBe(
				"https://ezimageai.com/blog/prompt-guide?source=hello%20world",
			);
			expect(fetchWebsite).not.toHaveBeenCalled();
		},
	);
	it.each([
		["http://ezimageai.com/api/webhooks/payments", "POST"],
		["http://ezimageai.com:8080/", "GET"],
		["http://ezimageai.com.attacker.example/", "GET"],
	])("keeps invalid or unsafe ingress rejected: %s %s", async (url, method) => {
		const fetchWebsite = vi.fn();
		const response = await forwardToWebsite(new Request(url, { method }), origin, fetchWebsite);
		expect(response.status).toBe(421);
		expect(response.headers.get("location")).toBeNull();
		expect(fetchWebsite).not.toHaveBeenCalled();
	});
	it("keeps webhook bytes, method, query and cookies while replacing spoofed forwarding headers", async () => {
		const fetchWebsite = vi.fn(async (request: Request) => {
			expect(request.url).toBe(`${origin}/api/webhooks/payments?provider=paypal`);
			expect(request.method).toBe("POST");
			expect(await request.text()).toBe('{ "signed": true }');
			expect(request.headers.get("cookie")).toBe("session=private");
			expect(request.headers.get("paypal-transmission-sig")).toBe("signature");
			expect(request.headers.get("x-forwarded-host")).toBe("ezimageai.com");
			expect(request.headers.get("x-forwarded-proto")).toBe("https");
			expect(request.headers.get("x-forwarded-for")).toBe("203.0.113.5");
			expect(request.headers.get("forwarded")).toBeNull();
			return new Response("accepted", { headers: { "set-cookie": "session=new; Secure" } });
		});
		const response = await forwardToWebsite(
			new Request(`${origin}/api/webhooks/payments?provider=paypal`, {
				method: "POST",
				body: '{ "signed": true }',
				headers: {
					cookie: "session=private",
					"paypal-transmission-sig": "signature",
					"cf-connecting-ip": "203.0.113.5",
					"x-forwarded-host": "attacker.example",
					"x-forwarded-proto": "http",
					"x-forwarded-for": "127.0.0.1",
					forwarded: "host=attacker.example",
				},
			}),
			origin,
			fetchWebsite,
		);
		expect(response.headers.get("set-cookie")).toBe("session=new; Secure");
		expect(await response.text()).toBe("accepted");
	});
	it("rejects another hostname before waking the container", async () => {
		const fetchWebsite = vi.fn();
		expect(
			(
				await forwardToWebsite(
					new Request("https://wrong.example/api/health"),
					origin,
					fetchWebsite,
				)
			).status,
		).toBe(421);
		expect(fetchWebsite).not.toHaveBeenCalled();
	});
	it("does not trust user supplied forwarding IP when Cloudflare did not provide one", async () => {
		await forwardToWebsite(
			new Request(origin, { headers: { "x-forwarded-for": "127.0.0.1" } }),
			origin,
			async (request) => {
				expect(request.headers.get("x-forwarded-for")).toBeNull();
				return new Response("OK");
			},
		);
	});
	it("returns an uncached neutral error if the container cannot start", async () => {
		const response = await forwardToWebsite(new Request(origin), origin, async () => {
			throw new Error("postgres://private-secret");
		});
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).not.toContain("private-secret");
	});
});

describe("website secret injection", () => {
	it.each(["", "[]", "null", '{"SECRET":123}'])(
		"rejects malformed secrets without echoing values: %s",
		(value) => {
			expect(() => websiteEnvironment(value, origin)).toThrow("INVALID_WEB_RUNTIME_ENV");
		},
	);
	it("requires the public build origin and runtime origin to agree", () => {
		expect(() =>
			websiteEnvironment(
				JSON.stringify({ NEXT_PUBLIC_SAAS_URL: "https://another.example" }),
				origin,
			),
		).toThrow("WEB_ORIGIN_MISMATCH");
	});
	it("forces the private Node server settings and Cloudflare proxy identity", () => {
		expect(
			websiteEnvironment(
				JSON.stringify({
					NEXT_PUBLIC_SAAS_URL: origin,
					DATABASE_URL: "postgresql://example/db",
					NODE_ENV: "development",
					PORT: "22",
					HOSTNAME: "127.0.0.1",
				}),
				origin,
			),
		).toMatchObject({
			NODE_ENV: "production",
			PORT: "8080",
			HOSTNAME: "0.0.0.0",
			MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
			DATABASE_URL: "postgresql://example/db",
		});
	});
});
