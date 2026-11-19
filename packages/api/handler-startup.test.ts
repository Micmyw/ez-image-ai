import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiRouterClient } from "./orpc/router";

const probes = vi.hoisted(() => ({
	loadRouter: vi.fn(),
	createRpc: vi.fn(),
	createOpenApi: vi.fn(),
	loadReferencePlugin: vi.fn(),
	createReference: vi.fn(),
	getSession: vi.fn(),
	authRequest: vi.fn(() => Response.json(null)),
	paymentRequest: vi.fn(async (request: Request) => new Response(await request.text())),
}));

vi.mock("@repo/auth", () => ({
	auth: {
		handler: probes.authRequest,
		api: {
			getSession: probes.getSession,
			generateOpenAPISchema: async () => ({
				paths: { "/get-session": { get: { responses: { 200: { description: "OK" } } } } },
			}),
		},
	},
}));
vi.mock("@repo/payments", async (original) => ({
	...(await original<typeof import("@repo/payments")>()),
	webhookHandler: probes.paymentRequest,
}));
vi.mock("./orpc/router", async (original) => {
	probes.loadRouter();
	return original();
});
vi.mock("@orpc/server/fetch", async (original) => {
	const actual = await original<typeof import("@orpc/server/fetch")>();
	return {
		...actual,
		RPCHandler: class extends actual.RPCHandler<Record<string, unknown>> {
			constructor(
				...args: ConstructorParameters<typeof actual.RPCHandler<Record<string, unknown>>>
			) {
				probes.createRpc();
				super(...args);
			}
		},
	};
});
vi.mock("@orpc/openapi/fetch", async (original) => {
	const actual = await original<typeof import("@orpc/openapi/fetch")>();
	return {
		...actual,
		OpenAPIHandler: class extends actual.OpenAPIHandler<Record<string, unknown>> {
			constructor(
				...args: ConstructorParameters<typeof actual.OpenAPIHandler<Record<string, unknown>>>
			) {
				probes.createOpenApi();
				super(...args);
			}
		},
	};
});
vi.mock("@orpc/openapi/plugins", async (original) => {
	probes.loadReferencePlugin();
	const actual = await original<typeof import("@orpc/openapi/plugins")>();
	return {
		...actual,
		OpenAPIReferencePlugin: class extends actual.OpenAPIReferencePlugin<Record<string, unknown>> {
			constructor(
				...args: ConstructorParameters<
					typeof actual.OpenAPIReferencePlugin<Record<string, unknown>>
				>
			) {
				probes.createReference();
				super(...args);
			}
		},
	};
});

describe("website API protocol initialization", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.example.com");
		vi.stubEnv("NEXT_PUBLIC_SITE_NAME", "EzImageAI");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		vi.stubEnv("ANALYTICS_OPT_OUT_COUNTRIES", "US");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it(
		"loads only the requested protocol and reuses its handler across concurrent and warm requests",
		{ timeout: 15_000 },
		async () => {
			const { app, createApiApp } = await import("./app");
			expect(probes.loadRouter).not.toHaveBeenCalled();

			const [health, getSession, payment, preflight] = await Promise.all([
				app.request("/api/health"),
				app.request("/api/auth/get-session?disableCookieCache=true"),
				app.request("/api/webhooks/payments", { method: "POST", body: '{"fixture":true}' }),
				app.request("/api/analytics/policy", {
					method: "OPTIONS",
					headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "GET" },
				}),
			]);
			expect(await health.json()).toEqual({ status: "alive" });
			expect(await getSession.json()).toBeNull();
			expect(probes.getSession).not.toHaveBeenCalled();
			expect(await payment.text()).toBe('{"fixture":true}');
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
			expect(probes.loadRouter).not.toHaveBeenCalled();
			expect(probes.createRpc).not.toHaveBeenCalled();
			expect(probes.createOpenApi).not.toHaveBeenCalled();
			expect(probes.createReference).not.toHaveBeenCalled();

			const policy = { requiresOptIn: false, privacySignal: true, analyticsAllowed: false };
			const headers = { "cf-ipcountry": "US", dnt: "1" };
			const rpc = createORPCClient<ApiRouterClient>(
				new RPCLink({
					url: "https://app.example.com/api/rpc",
					headers,
					fetch: async (request) => app.fetch(request),
				}),
			);
			expect(await Promise.all([rpc.analytics.policy(), rpc.analytics.policy()])).toEqual([
				policy,
				policy,
			]);
			expect(await rpc.analytics.policy()).toEqual(policy);
			expect(probes.loadRouter).toHaveBeenCalledOnce();
			expect(probes.createRpc).toHaveBeenCalledOnce();
			expect(probes.createOpenApi).not.toHaveBeenCalled();
			expect(probes.createReference).not.toHaveBeenCalled();

			const requestPolicy = () => app.request("/api/analytics/policy", { headers });
			for (const response of await Promise.all([requestPolicy(), requestPolicy()])) {
				expect(response.status).toBe(200);
				expect(response.headers.get("cache-control")).toBe("private, no-store");
				expect(await response.json()).toEqual(policy);
			}
			expect((await requestPolicy()).status).toBe(200);
			expect((await app.request("/api/unknown-route")).status).toBe(404);
			expect((await app.request("/api/docs", { method: "POST" })).status).toBe(404);
			expect(probes.createOpenApi).toHaveBeenCalledOnce();
			expect(probes.loadReferencePlugin).not.toHaveBeenCalled();
			expect(probes.createReference).not.toHaveBeenCalled();

			const [docs, spec] = await Promise.all([
				app.request("/api/docs/?source=test"),
				app.request("/api/spec.json"),
			]);
			expect(docs.status).toBe(200);
			expect(docs.headers.get("content-type")).toContain("text/html");
			expect(await docs.text()).toMatch(/Scalar\.createApiReference/);
			expect(spec.status).toBe(200);
			expect(await spec.json()).toMatchObject({
				info: { title: "EzImageAI API", version: "1.0.0" },
				servers: [{ url: "/api" }],
				paths: { "/analytics/policy": { get: {} }, "/auth/get-session": { get: {} } },
			});
			expect((await app.request("/api/spec.json/")).status).toBe(200);
			expect(probes.loadReferencePlugin).toHaveBeenCalledOnce();
			expect(probes.createReference).toHaveBeenCalledOnce();
			expect(probes.createRpc).toHaveBeenCalledOnce();
			const legacy = await import("./index");
			expect(legacy.app).toBe(app);
			expect(legacy.createApiApp).toBe(createApiApp);
			expect(legacy.router).toBe((await import("./orpc/router")).router);
		},
	);

	it("retries a failed shared handler initialization and leaves other protocols available", async () => {
		const { app } = await import("./app");
		vi.spyOn(console, "error").mockImplementation(() => {});
		probes.createRpc.mockImplementationOnce(() => {
			throw new Error("test initialization error");
		});

		const request = () => app.request("/api/rpc/analytics/policy");
		const [failedA, failedB] = await Promise.all([request(), request()]);
		expect([failedA.status, failedB.status]).toEqual([500, 500]);
		expect(probes.createRpc).toHaveBeenCalledOnce();
		expect((await app.request("/api/analytics/policy")).status).toBe(200);
		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);
		expect(probes.createRpc).toHaveBeenCalledTimes(2);
	});
});
