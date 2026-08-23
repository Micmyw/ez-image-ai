import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { handler: vi.fn(), api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: vi.fn() } }));
vi.mock("@repo/jobs", () => ({
	createProviderRegistry: () => ({ get: vi.fn() }),
	createProviderWebhookVerifierRegistry: () => ({ get: vi.fn(() => null) }),
}));
vi.mock("@repo/storage", () => ({ checkStorageMetadataAccess: vi.fn() }));
vi.mock("@repo/payments", () => ({
	webhookHandler: vi.fn(() => new Response(null, { status: 204 })),
}));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { app } from "./index";

interface NodeStreamRequestInit extends RequestInit {
	duplex: "half";
}

describe("API request security", () => {
	beforeEach(() => {
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.example.com";
		process.env.NEXT_PUBLIC_MARKETING_URL = "https://www.example.com";
	});

	it("rejects oversized ordinary API bodies before parsing", async () => {
		const response = await app.request("/api/rpc/media/quote", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": "1048577" },
			body: "{}",
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ code: "PAYLOAD_TOO_LARGE" });
	});

	it("applies a separate draft body limit", async () => {
		const response = await app.request("/api/media/drafts", {
			method: "POST",
			headers: {
				origin: "https://www.example.com",
				"content-type": "application/json",
				"content-length": "10485761",
			},
			body: "{}",
		});

		expect(response.status).toBe(413);
	});

	it("reads an undeclared streamed body without relying on a realm-bound getter", async () => {
		const requestInit: NodeStreamRequestInit = {
			method: "POST",
			duplex: "half",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("bounded body"));
					controller.close();
				},
			}),
		};
		const response = await app.request("/api/health", requestInit);

		expect(response.status).toBe(404);
	});

	it("limits payment and provider raw webhook bodies before verification", async () => {
		for (const path of ["/api/webhooks/payments", "/api/webhooks/ai/replicate"]) {
			const response = await app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json", "content-length": "1048577" },
				body: "{}",
			});
			expect(response.status, path).toBe(413);
		}
	});

	it("returns and preserves request correlation headers without trusting arbitrary values", async () => {
		const invalid = await app.request("/api/health", {
			headers: { "x-request-id": "private value with spaces", traceparent: "invalid" },
		});
		expect(invalid.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(invalid.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);

		const valid = await app.request("/api/health", {
			headers: {
				"x-request-id": "request_0123456789abcdef",
				traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
			},
		});
		expect(valid.headers.get("x-request-id")).toBe("request_0123456789abcdef");
		expect(valid.headers.get("x-trace-id")).toBe("0123456789abcdef0123456789abcdef");
	});
});
