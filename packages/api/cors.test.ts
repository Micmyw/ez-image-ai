import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({ auth: { handler: vi.fn(), api: { getSession: vi.fn() } } }));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: vi.fn() } }));
vi.mock("@repo/jobs", () => ({ createProviderRegistry: () => ({ get: vi.fn() }) }));
vi.mock("@repo/storage", () => ({ checkStorageMetadataAccess: vi.fn() }));
vi.mock("@repo/payments", () => ({ webhookHandler: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { app } from "./index";

describe("marketing draft CORS", () => {
	beforeEach(() => {
		process.env.NEXT_PUBLIC_SAAS_URL = "https://app.example.com";
		process.env.NEXT_PUBLIC_MARKETING_URL = "https://www.example.com";
	});

	it("allows the configured marketing origin only on the draft endpoint", async () => {
		const allowed = await app.request("/api/media/drafts", {
			method: "OPTIONS",
			headers: { Origin: "https://www.example.com", "Access-Control-Request-Method": "POST" },
		});
		expect(allowed.headers.get("access-control-allow-origin")).toBe("https://www.example.com");
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();

		const denied = await app.request("/api/media/jobs", {
			method: "OPTIONS",
			headers: { Origin: "https://www.example.com", "Access-Control-Request-Method": "GET" },
		});
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();
	});
});
