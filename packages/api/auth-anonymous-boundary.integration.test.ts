/* oxlint-disable typescript/unbound-method -- assertions configure Vitest-mocked dependency methods */
import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => ({
	consumeGuestBootstrap: vi.fn(),
	hasDurableGuestBootstrapProof: vi.fn(),
	ingestProviderEvent: vi.fn(),
	resolveGuestRuntimeConfigOverride: vi.fn(),
}));

const databaseClientMocks = vi.hoisted(() => ({
	$queryRaw: vi.fn(),
	guestLinkIntent: { findFirst: vi.fn() },
	user: { findFirst: vi.fn() },
}));

vi.mock("@repo/auth", () => ({
	auth: { handler: vi.fn(), api: { getSession: vi.fn() } },
}));
vi.mock("@repo/config/server", () => ({
	getGuestMediaConfig: vi.fn(),
	isLocalProductionBuildE2EEnvironment: vi.fn(() => false),
	validateEzPicLaunchEnvironment: vi.fn(),
	validateServerEnvironment: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	...databaseMocks,
}));
vi.mock("@repo/database/client", () => ({ db: databaseClientMocks }));
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
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-guest-abuse-secret");
		vi.stubEnv("GUEST_ABUSE_HMAC_VERSION", "launch-key-v1");
		databaseMocks.hasDurableGuestBootstrapProof.mockResolvedValue(false);
		databaseMocks.resolveGuestRuntimeConfigOverride.mockResolvedValue(null);
		databaseClientMocks.guestLinkIntent.findFirst.mockResolvedValue(null);
		vi.mocked(getGuestMediaConfig).mockImplementation((environment, runtimeOverride) => {
			const normalizedString = (value: unknown) =>
				typeof value === "string" && value.trim() ? value.trim() : null;
			return {
				enabled:
					runtimeOverride === true ||
					(typeof runtimeOverride === "object" &&
						runtimeOverride !== null &&
						Reflect.get(runtimeOverride, "enabled") === true),
				promotionPeriod: normalizedString(environment.GUEST_PROMOTION_PERIOD),
				abuseHmac: {
					secretKey:
						typeof environment.GUEST_ABUSE_HMAC_SECRET === "string"
							? environment.GUEST_ABUSE_HMAC_SECRET
							: null,
					keyVersion: normalizedString(environment.GUEST_ABUSE_HMAC_VERSION),
				},
				limits: {},
				abuseEvidenceTtlMs: 30 * 24 * 60 * 60_000,
			} as never;
		});
		vi.mocked(auth.api.getSession).mockResolvedValue(null);
		vi.mocked(auth.handler).mockImplementation(async () =>
			Promise.resolve(new Response("handled", { status: 200 })),
		);
	});

	afterEach(() => vi.unstubAllEnvs());

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
		const clearedBootstrapCookie = missingProof.headers.get("set-cookie");
		expect(clearedBootstrapCookie).not.toBeNull();
		expect(clearedBootstrapCookie ?? "").toContain("media_guest_bootstrap=;");
		expect(clearedBootstrapCookie ?? "").toContain("Max-Age=0");
		expect(clearedBootstrapCookie ?? "").toContain("Path=/api/auth/sign-in/anonymous");
		expect(wrongMethod.status).toBe(404);
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("maps malformed percent-encoded bootstrap cookies to the stable denial boundary", async () => {
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.resolveGuestRuntimeConfigOverride.mockResolvedValue({ enabled: true });

		const response = await app.request("/api/auth/sign-in/anonymous", {
			method: "POST",
			headers: {
				origin: "https://app.test",
				"cf-connecting-ip": "203.0.113.10",
				cookie: "media_guest_bootstrap=%E0%A4%A",
			},
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_BOOTSTRAP_PROOF_REQUIRED" });
		const clearedBootstrapCookie = response.headers.get("set-cookie");
		expect(clearedBootstrapCookie).not.toBeNull();
		expect(clearedBootstrapCookie ?? "").toContain("media_guest_bootstrap=;");
		expect(clearedBootstrapCookie ?? "").toContain("Max-Age=0");
		expect(clearedBootstrapCookie ?? "").toContain("Path=/api/auth/sign-in/anonymous");
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

	it("maps unexpected durable bootstrap failures to one reviewed public code", async () => {
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.hasDurableGuestBootstrapProof.mockResolvedValue(true);
		databaseMocks.resolveGuestRuntimeConfigOverride.mockResolvedValue({ enabled: true });
		databaseMocks.consumeGuestBootstrap.mockRejectedValue(
			new Error("Prisma connection failed: password=do-not-expose"),
		);

		const response = await app.request("/api/auth/sign-in/anonymous", {
			method: "POST",
			headers: {
				origin: "https://app.test",
				"cf-connecting-ip": "203.0.113.10",
				cookie: `media_guest_bootstrap=${"a".repeat(43)}`,
			},
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_BOOTSTRAP_FAILED" });
	});

	it("normalizes the proven anonymous HTML form POST to Better Auth JSON", async () => {
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.hasDurableGuestBootstrapProof.mockResolvedValue(true);
		databaseMocks.resolveGuestRuntimeConfigOverride.mockResolvedValue({ enabled: true });
		databaseClientMocks.user.findFirst.mockResolvedValue({ id: "guest-user" });
		databaseMocks.consumeGuestBootstrap.mockImplementation(
			async (_input, createPrincipal: (input: { email: string }) => Promise<unknown>) => ({
				outcome: "CREATED",
				value: await createPrincipal({ email: "guest@anonymous.invalid" }),
			}),
		);
		let forwardedRequest: Request | undefined;
		vi.mocked(auth.handler).mockImplementation(async (request) => {
			forwardedRequest = request;
			return Response.json({ user: { id: "guest-user" } });
		});

		const response = await app.request("/api/auth/sign-in/anonymous", {
			method: "POST",
			headers: {
				origin: "https://app.test",
				"cf-connecting-ip": "203.0.113.10",
				"content-length": "0",
				"content-type": "application/x-www-form-urlencoded",
				cookie: `media_guest_bootstrap=${"a".repeat(43)}`,
			},
			body: "",
		});

		expect(response.status).toBe(200);
		expect(forwardedRequest).toBeDefined();
		expect(forwardedRequest?.url).toBe("http://localhost/api/auth/sign-in/anonymous");
		expect(forwardedRequest?.headers.get("origin")).toBe("https://app.test");
		expect(forwardedRequest?.headers.get("cf-connecting-ip")).toBe("203.0.113.10");
		expect(forwardedRequest?.headers.get("cookie")).toBe(`media_guest_bootstrap=${"a".repeat(43)}`);
		expect(forwardedRequest?.headers.get("content-type")).toBe("application/json");
		expect(forwardedRequest?.headers.get("content-length")).toBeNull();
		expect(await forwardedRequest?.clone().json()).toEqual({});
		const bootstrapToken = "a".repeat(43);
		const claimHash = createHash("sha256").update(bootstrapToken, "utf8").digest("hex");
		expect(databaseMocks.consumeGuestBootstrap).toHaveBeenCalledWith(
			expect.objectContaining({
				principalEmail: `guest-${createHmac("sha256", "test-secret")
					.update(`anonymous-principal:${claimHash}`, "utf8")
					.digest("hex")
					.slice(0, 48)}@anonymous.invalid`,
				ipHash: testGuestAbuseBinding("guest-ip", "203.0.113.10"),
				subnetHash: testGuestAbuseBinding("guest-subnet", "203.0.113.0/24"),
			}),
			expect.any(Function),
			expect.anything(),
		);
	});

	it("waits for lease cleanup and maps a non-OK Better Auth response without leaking it", async () => {
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", "https://app.test");
		vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
		vi.stubEnv("MEDIA_TRUSTED_PROXY_PROVIDER", "cloudflare");
		databaseMocks.hasDurableGuestBootstrapProof.mockResolvedValue(true);
		databaseMocks.resolveGuestRuntimeConfigOverride.mockResolvedValue({ enabled: true });
		let cleanupStarted!: () => void;
		const cleanupStartedSignal = new Promise<void>((resolve) => {
			cleanupStarted = resolve;
		});
		let releaseCleanup!: () => void;
		const cleanupRelease = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		databaseMocks.consumeGuestBootstrap.mockImplementation(
			async (_input, createPrincipal: (input: { email: string }) => Promise<unknown>) => {
				try {
					return await createPrincipal({ email: "guest@anonymous.invalid" });
				} catch (error) {
					cleanupStarted();
					await cleanupRelease;
					throw error;
				}
			},
		);
		vi.mocked(auth.handler).mockResolvedValue(
			new Response("Prisma auth failure: password=do-not-expose", {
				status: 418,
				headers: {
					"set-cookie": "leaked_session=do-not-expose; HttpOnly",
					"x-auth-debug": "internal-constraint-detail",
				},
			}),
		);

		let responseSettled = false;
		const responsePromise = Promise.resolve(
			app.request("/api/auth/sign-in/anonymous", {
				method: "POST",
				headers: {
					origin: "https://app.test",
					"cf-connecting-ip": "203.0.113.10",
					cookie: `media_guest_bootstrap=${"a".repeat(43)}`,
				},
			}),
		).then((response) => {
			responseSettled = true;
			return response;
		});
		await cleanupStartedSignal;
		expect(responseSettled).toBe(false);
		releaseCleanup();
		const response = await responsePromise;
		const body = await response.text();

		expect(response.status).toBe(403);
		expect(JSON.parse(body)).toEqual({ code: "GUEST_BOOTSTRAP_FAILED" });
		expect(body).not.toContain("password");
		expect(response.headers.get("x-auth-debug")).toBeNull();
		expect(response.headers.get("set-cookie")).not.toContain("leaked_session");
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

	it("uses the real durable LINKING intent for the exact anonymous owner and session", async () => {
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-link-secret");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);
		databaseClientMocks.guestLinkIntent.findFirst.mockResolvedValue({ id: "intent-1" });
		const token = "a".repeat(43);

		const response = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { cookie: `media_guest_link_intent=${token}` },
		});

		expect(response.status).toBe(200);
		expect(databaseClientMocks.guestLinkIntent.findFirst).toHaveBeenCalledWith({
			where: {
				tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
				anonymousOwnerId: "guest",
				promotionPeriod: "2026-launch",
				sourceSessionHash: createHmac("sha256", "independent-link-secret")
					.update("launch-key-v1:guest-source-session:guest-session", "utf8")
					.digest("hex"),
				state: "LINKING",
				expiresAt: { gt: expect.any(Date) },
			},
			select: { id: true },
		});
		expect(auth.handler).toHaveBeenCalledOnce();
	});

	it("maps a malformed percent-encoded link cookie to the stable generic denial", async () => {
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-link-secret");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);

		const response = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { cookie: "media_guest_link_intent=%E0%A4%A" },
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_LINK_INTENT_REQUIRED" });
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it.each([
		["missing cookie", undefined],
		["malformed cookie", "short"],
	] as const)("fails closed for a %s on a real guest link route", async (_label, token) => {
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-link-secret");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);

		const response = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: token ? { cookie: `media_guest_link_intent=${token}` } : undefined,
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_LINK_INTENT_REQUIRED" });
		expect(databaseClientMocks.guestLinkIntent.findFirst).not.toHaveBeenCalled();
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("fails closed when the real link intent is wrong, expired, linked, or unavailable", async () => {
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-link-secret");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);
		databaseClientMocks.guestLinkIntent.findFirst.mockRejectedValue(
			new Error("database unavailable: do-not-expose"),
		);

		const response = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { cookie: `media_guest_link_intent=${"a".repeat(43)}` },
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ code: "GUEST_LINK_INTENT_REQUIRED" });
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it.each([
		["wrong owner", { anonymousOwnerId: "other-guest" }],
		["wrong session", { sourceSessionHash: "f".repeat(64) }],
		["already linked", { state: "LINKED" }],
		["expired", { expiresAt: new Date("2020-01-01T00:00:00.000Z") }],
	] as const)("rejects a durable intent bound to the %s", async (_label, override) => {
		vi.stubEnv("GUEST_ABUSE_HMAC_SECRET", "independent-link-secret");
		vi.stubEnv("GUEST_PROMOTION_PERIOD", "2026-launch");
		vi.mocked(auth.api.getSession).mockResolvedValue({
			user: { id: "guest", isAnonymous: true },
			session: { id: "guest-session" },
		} as never);
		const token = "a".repeat(43);
		const row = {
			tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
			anonymousOwnerId: "guest",
			promotionPeriod: "2026-launch",
			sourceSessionHash: createHmac("sha256", "independent-link-secret")
				.update("launch-key-v1:guest-source-session:guest-session", "utf8")
				.digest("hex"),
			state: "LINKING",
			expiresAt: new Date("2099-01-01T00:00:00.000Z"),
			...override,
		};
		databaseClientMocks.guestLinkIntent.findFirst.mockImplementation(
			async (query: {
				where: {
					tokenHash: string;
					anonymousOwnerId: string;
					promotionPeriod: string;
					sourceSessionHash: string;
					state: string;
					expiresAt: { gt: Date };
				};
			}) =>
				row.tokenHash === query.where.tokenHash &&
				row.anonymousOwnerId === query.where.anonymousOwnerId &&
				row.promotionPeriod === query.where.promotionPeriod &&
				row.sourceSessionHash === query.where.sourceSessionHash &&
				row.state === query.where.state &&
				row.expiresAt > query.where.expiresAt.gt
					? { id: "intent-1" }
					: null,
		);

		const response = await app.request("/api/auth/sign-in/email", {
			method: "POST",
			headers: { cookie: `media_guest_link_intent=${token}` },
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

function testGuestAbuseBinding(purpose: string, value: string): string {
	return createHmac("sha256", "independent-guest-abuse-secret")
		.update(`launch-key-v1:${purpose}:${value}`, "utf8")
		.digest("hex");
}
