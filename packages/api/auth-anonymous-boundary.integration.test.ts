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

import { app, createApiApp } from "./index";

const createOpenBoundaryDependencies = () => ({
	hasGuestBootstrapProof: vi.fn().mockResolvedValue(true),
	hasGuestLinkIntent: vi.fn().mockResolvedValue(true),
	resolveGuestRuntimeOverride: vi.fn().mockResolvedValue(true),
});

describe("anonymous Better Auth wildcard boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getGuestMediaConfig).mockImplementation(
			(_environment, runtimeOverride) => ({ enabled: runtimeOverride === true }) as never,
		);
		vi.mocked(auth.api.getSession).mockResolvedValue(null);
		vi.mocked(auth.handler).mockImplementation(async () =>
			Promise.resolve(new Response("handled", { status: 200 })),
		);
	});

	it("keeps the exported app closed until persistent boundary dependencies are wired", async () => {
		const response = await app.request("/api/auth/sign-in/anonymous", { method: "POST" });

		expect(response.status).toBe(404);
		expect(getGuestMediaConfig).toHaveBeenCalledWith(process.env, null);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("does not create an anonymous session while the guest gate is disabled", async () => {
		vi.mocked(getGuestMediaConfig).mockReturnValue({
			enabled: false,
			reason: "GUEST_ENVIRONMENT_DISABLED",
		} as never);
		const dependencies = createOpenBoundaryDependencies();

		const response = await createApiApp(dependencies).request("/api/auth/sign-in/anonymous", {
			method: "POST",
		});

		expect(response.status).toBe(404);
		expect(getGuestMediaConfig).toHaveBeenCalledWith(process.env, true);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("requires a durable bootstrap proof for the exact anonymous POST route", async () => {
		const dependencies = createOpenBoundaryDependencies();
		dependencies.hasGuestBootstrapProof.mockResolvedValue(false);

		const missingProof = await createApiApp(dependencies).request("/api/auth/sign-in/anonymous", {
			method: "POST",
		});
		const wrongMethod = await createApiApp(createOpenBoundaryDependencies()).request(
			"/api/auth/sign-in/anonymous",
			{ method: "GET" },
		);

		expect(missingProof.status).toBe(403);
		expect(await missingProof.json()).toEqual({ code: "GUEST_BOOTSTRAP_PROOF_REQUIRED" });
		expect(wrongMethod.status).toBe(404);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("allows an enabled, proven, unauthenticated anonymous sign-in", async () => {
		const dependencies = createOpenBoundaryDependencies();

		const response = await createApiApp(dependencies).request("/api/auth/sign-in/anonymous", {
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("handled");
		expect(dependencies.resolveGuestRuntimeOverride).toHaveBeenCalledOnce();
		expect(dependencies.hasGuestBootstrapProof).toHaveBeenCalledOnce();
	});

	it("rejects existing users attempting to replace their session with an anonymous one", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "registered", isAnonymous: false },
			session: { id: "registered-session" },
		} as never);

		const response = await createApiApp(createOpenBoundaryDependencies()).request(
			"/api/auth/sign-in/anonymous",
			{ method: "POST" },
		);

		expect(response.status).toBe(403);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it.each([
		["POST", "/api/auth/sign-in/email"],
		["POST", "/api/auth/sign-up/email"],
		["POST", "/api/auth/sign-in/magic-link"],
		["GET", "/api/auth/magic-link/verify"],
		["POST", "/api/auth/sign-in/social"],
		["GET", "/api/auth/callback/google"],
		["GET", "/api/auth/callback/github"],
		["GET", "/api/auth/verify-email"],
	] as const)(
		"allows canonical guest linking route %s %s with durable intent",
		async (method, path) => {
			vi.mocked(auth.api.getSession).mockResolvedValue({
				user: { id: "guest", isAnonymous: true },
				session: { id: "guest-session" },
			} as never);
			const dependencies = createOpenBoundaryDependencies();

			const response = await createApiApp(dependencies).request(path, { method });

			expect(response.status).toBe(200);
			expect(dependencies.hasGuestLinkIntent).toHaveBeenCalledOnce();
		},
	);

	it("requires durable link intent before a guest reaches a canonical linking route", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);
		const dependencies = createOpenBoundaryDependencies();
		dependencies.hasGuestLinkIntent.mockResolvedValue(false);

		const response = await createApiApp(dependencies).request("/api/auth/sign-in/email", {
			method: "POST",
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_LINK_INTENT_REQUIRED" });
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it.each([
		["POST", "/api/auth/passkey/verify-authentication"],
		["POST", "/api/auth/phone-number/verify"],
		["POST", "/api/auth/two-factor/verify-totp"],
		["POST", "/api/auth/organization/create"],
		["GET", "/api/auth/admin/list-users"],
		["GET", "/api/auth/callback/attacker"],
		["GET", "/api/auth/callback/google/extra"],
		["GET", "/api/auth/oauth2/callback/google"],
		["GET", "/api/auth/sign-in/email"],
	] as const)("denies noncanonical guest auth route %s %s", async (method, path) => {
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);

		const response = await createApiApp(createOpenBoundaryDependencies()).request(path, {
			method,
		});

		expect(response.status).toBe(403);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it.each([
		["GET", "/api/auth/get-session"],
		["POST", "/api/auth/sign-out"],
	] as const)(
		"allows the minimal guest session route %s %s without link intent",
		async (method, path) => {
			vi.mocked(auth.api.getSession).mockResolvedValue({
				user: { id: "guest", isAnonymous: true },
				session: { id: "guest-session" },
			} as never);
			const dependencies = createOpenBoundaryDependencies();
			dependencies.hasGuestLinkIntent.mockResolvedValue(false);

			const response = await createApiApp(dependencies).request(path, { method });

			expect(response.status).toBe(200);
			expect(dependencies.hasGuestLinkIntent).not.toHaveBeenCalled();
		},
	);
});
