import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { handler: vi.fn(), api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: vi.fn() } }));
vi.mock("@repo/jobs", () => ({
	createProviderRegistry: () => ({ get: vi.fn() }),
	createProviderWebhookVerifierRegistry: () => ({ get: vi.fn(() => null) }),
}));
vi.mock("@repo/storage", () => ({ checkStorageMetadataAccess: vi.fn() }));
vi.mock("@repo/payments", () => ({
	paymentProviderNames: ["stripe", "paypal", "waffo"] as const,
	webhookHandler: vi.fn(),
}));
vi.mock("@repo/jobs/orchestration/client", () => ({ dispatchJob: vi.fn() }));

import { app } from "./index";

describe("same-origin draft CORS", () => {
	beforeEach(() => {
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.example.com";
		delete process.env.NEXT_PUBLIC_VERCEL_URL;
		delete process.env.PORT;
	});

	it("allows only the configured SaaS origin on the draft endpoint", async () => {
		const allowed = await app.request("/api/media/drafts", {
			method: "OPTIONS",
			headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "POST" },
		});
		expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

		const denied = await app.request("/api/media/jobs", {
			method: "OPTIONS",
			headers: { Origin: "https://www.example.com", "Access-Control-Request-Method": "GET" },
		});
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();

		const retiredOriginDenied = await app.request("/api/media/drafts", {
			method: "OPTIONS",
			headers: { Origin: "https://www.example.com", "Access-Control-Request-Method": "POST" },
		});
		expect(retiredOriginDenied.headers.get("access-control-allow-origin")).toBeNull();
	});

	it.each([
		["missing", undefined, "http://localhost:3000"],
		["empty", "", "http://localhost:3000"],
		["malformed", "not-an-origin", "not-an-origin"],
		["path-bearing", "https://app.example.com/public", "https://app.example.com/public"],
		[
			"credential-bearing",
			"https://operator:secret@app.example.com",
			"https://operator:secret@app.example.com",
		],
	])("denies %s explicit SaaS origin configuration", async (_case, configured, origin) => {
		if (configured === undefined) delete process.env.NEXT_PUBLIC_SAAS_URL;
		else process.env.NEXT_PUBLIC_SAAS_URL = configured;

		const response = await app.request("/api/media/drafts", {
			method: "OPTIONS",
			headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});
});
