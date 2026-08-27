/* oxlint-disable typescript/unbound-method -- assertions configure Vitest-mocked dependency methods */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/auth", () => ({
	auth: { handler: vi.fn(), api: { getSession: vi.fn() } },
}));
vi.mock("@repo/config/server", () => ({
	getGuestMediaConfig: vi.fn(),
	validateEzPicLaunchEnvironment: vi.fn(),
	validateServerEnvironment: vi.fn(),
}));
vi.mock("@repo/database/client", () => ({ db: { $queryRaw: vi.fn() } }));
vi.mock("@repo/jobs", () => ({
	createProviderWebhookVerifierRegistry: () => ({ get: vi.fn(() => null) }),
}));
vi.mock("@repo/storage", () => ({ checkStorageMetadataAccess: vi.fn() }));
vi.mock("@repo/payments", () => ({ webhookHandler: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: vi.fn() } }));

import { auth } from "@repo/auth";
import { getGuestMediaConfig } from "@repo/config/server";

import { app } from "./index";

describe("anonymous Better Auth wildcard boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getGuestMediaConfig).mockReturnValue({ enabled: true } as never);
		vi.mocked(auth.api.getSession).mockResolvedValue(null);
		vi.mocked(auth.handler).mockResolvedValue(new Response("handled", { status: 200 }));
	});

	it("does not create an anonymous session while the guest gate is disabled", async () => {
		vi.mocked(getGuestMediaConfig).mockReturnValue({
			enabled: false,
			reason: "GUEST_ENVIRONMENT_DISABLED",
		} as never);

		const response = await app.request("/api/auth/sign-in/anonymous", { method: "POST" });

		expect(response.status).toBe(404);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("allows a gated unauthenticated anonymous sign-in", async () => {
		const response = await app.request("/api/auth/sign-in/anonymous", { method: "POST" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("handled");
	});

	it("rejects registered users attempting to replace their session with an anonymous one", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "registered", isAnonymous: false },
			session: { id: "registered-session" },
		} as never);

		const response = await app.request("/api/auth/sign-in/anonymous", { method: "POST" });

		expect(response.status).toBe(403);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("allows account-link sign-in routes but denies the remaining auth wildcard to guests", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);

		const linking = await app.request("/api/auth/sign-in/email", { method: "POST" });
		expect(linking.status).toBe(200);

		const denied = await app.request("/api/auth/update-user", { method: "POST" });
		expect(denied.status).toBe(403);
		expect(auth.handler).toHaveBeenCalledTimes(1);
	});
});
