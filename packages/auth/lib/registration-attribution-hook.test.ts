import {
	ATTRIBUTION_COOKIE_NAME,
	type RegistrationAttribution,
} from "@repo/utils/lib/acquisition-attribution";
import type { BetterAuthOptions } from "better-auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	memory: {} as Record<string, Record<string, unknown>[]>,
	snapshots: new Map<string, RegistrationAttribution>(),
	save: vi.fn(),
	sendEmail: vi.fn(),
	logger: { error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: {},
	getInvitationById: vi.fn(),
	getOrganizationMembership: vi.fn(),
	getPurchasesByOrganizationId: vi.fn(),
	getPurchasesByUserId: vi.fn(),
	getUserByEmail: vi.fn(),
	getUserById: vi.fn(async () => ({ lastActiveOrganizationId: null })),
	setUserRegistrationAttributionOnce: state.save,
}));
vi.mock("better-auth/adapters/prisma", async () => {
	const { memoryAdapter } = await import("better-auth/adapters/memory");
	return { prismaAdapter: () => memoryAdapter(state.memory) };
});
vi.mock("better-auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("better-auth")>();
	return {
		...actual,
		// PostgreSQL generates IDs in production; the isolated memory fixture must do so itself.
		betterAuth: (options: BetterAuthOptions) =>
			actual.betterAuth({
				...options,
				advanced: {
					...options.advanced,
					database: { ...options.advanced?.database, generateId: "uuid" },
				},
			}),
	};
});
vi.mock("@repo/logs", () => ({ logger: state.logger }));
vi.mock("@repo/mail", () => ({ sendEmail: state.sendEmail }));
vi.mock("@repo/notifications", () => ({ createWelcomeNotification: vi.fn() }));
vi.mock("@repo/payments", () => ({ cancelProviderSubscription: vi.fn() }));

import { runAnonymousBootstrapIdentity } from "./anonymous-boundary";

const origin = "http://localhost:3000";
const password = "isolated-test-password";
let auth: typeof import("../auth").auth;

function sourceCookie(landingPath = "/blog/new-photo-ideas", consent = "true"): string {
	return `consent=${consent}; ${ATTRIBUTION_COOKIE_NAME}=${encodeURIComponent(
		JSON.stringify({
			version: 1,
			landingPath,
			referrerOrigin: "https://www.google.com/search?token=private",
			source: "referral",
			utmSource: null,
			utmMedium: null,
			utmCampaign: null,
			capturedAt: new Date().toISOString(),
		}),
	)}`;
}

function post(path: string, body: unknown, cookie = "") {
	return auth.handler(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie },
			body: JSON.stringify(body),
		}),
	);
}

async function signup(email: string, cookie = sourceCookie()) {
	const response = await post(
		"/sign-up/email",
		{ name: "Attribution fixture", email, password },
		cookie,
	);
	expect(response.status).toBe(200);
	return {
		response,
		body: (await response.json()) as { user: { id: string }; token: string | null },
	};
}

function latestMailUrl(): string {
	const latest = state.sendEmail.mock.calls.at(-1)?.[0] as
		| { context?: { url?: string } }
		| undefined;
	if (!latest?.context?.url) throw new Error("Verification mail fixture was not generated");
	return latest.context.url;
}

function sessionCookie(response: Response): string {
	const cookies = response.headers
		.getSetCookie()
		.filter((cookie) => cookie.includes("session_token="));
	return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("Better Auth registration attribution hooks with an isolated memory adapter", () => {
	beforeAll(async () => {
		vi.stubEnv("NEXT_PUBLIC_SAAS_URL", origin);
		vi.stubEnv(
			"BETTER_AUTH_SECRET",
			"registration-attribution-isolated-test-secret-at-least-32-characters",
		);
		vi.stubEnv("GOOGLE_CLIENT_ID", "isolated-google-client");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "isolated-google-secret");
		vi.stubEnv("GITHUB_CLIENT_ID", "isolated-github-client");
		vi.stubEnv("GITHUB_CLIENT_SECRET", "isolated-github-secret");
		auth = (await import("../auth")).auth;
	});
	beforeEach(() => {
		for (const model of [
			"user",
			"account",
			"session",
			"verification",
			"organization",
			"member",
			"invitation",
			"twoFactor",
		])
			state.memory[model] = [];
		state.snapshots.clear();
		vi.clearAllMocks();
		state.save.mockImplementation(async (userId: string, snapshot: RegistrationAttribution) => {
			if (state.snapshots.has(userId)) return false;
			state.snapshots.set(userId, snapshot);
			return true;
		});
		state.sendEmail.mockResolvedValue(undefined);
	});
	afterAll(() => vi.unstubAllEnvs());
	afterEach(() => vi.unstubAllGlobals());

	it("snapshots actual email signup, clears its cookie, and ignores client-supplied attribution", async () => {
		const response = await post(
			"/sign-up/email",
			{
				name: "Attribution fixture",
				email: "registration@example.test",
				password,
				registrationAttribution: { landingPath: "/admin", userId: "other-user" },
			},
			sourceCookie(),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			user: { id: string; registrationAttribution?: unknown };
		};
		expect(state.snapshots.get(body.user.id)).toMatchObject({
			landingPath: "/blog/new-photo-ideas",
			referrerOrigin: "https://www.google.com",
		});
		expect(body.user.registrationAttribution).toBeUndefined();
		expect(
			response.headers
				.getSetCookie()
				.some(
					(cookie) =>
						cookie.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`) && cookie.includes("Max-Age=0"),
				),
		).toBe(true);
	});

	it.each([
		"",
		sourceCookie("/blog/declined", "false"),
		`consent=true; ${ATTRIBUTION_COOKIE_NAME}=malformed`,
	])(
		"creates the account without recording absent, declined or malformed source (%s)",
		async (cookie) => {
			await signup("no-source@example.test", cookie);
			expect(state.save).not.toHaveBeenCalled();
		},
	);

	it("does not overwrite a registered user's source on email verification or later login", async () => {
		const { body } = await signup("existing@example.test");
		const initial = state.snapshots.get(body.user.id);
		const verified = await auth.handler(
			new Request(latestMailUrl(), { headers: { cookie: sourceCookie("/pricing") } }),
		);
		expect(verified.status).toBe(302);
		const login = await post(
			"/sign-in/email",
			{ email: "existing@example.test", password },
			sourceCookie("/create"),
		);
		expect(login.status).toBe(200);
		expect(state.save).toHaveBeenCalledTimes(1);
		expect(state.snapshots.get(body.user.id)).toEqual(initial);
		expect(
			login.headers
				.getSetCookie()
				.some(
					(cookie) =>
						cookie.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`) && cookie.includes("Max-Age=0"),
				),
		).toBe(true);
	});

	it("retains source until magic-link verification creates the new user", async () => {
		const cookie = sourceCookie("/blog/magic-link-entry");
		const requested = await post(
			"/sign-in/magic-link",
			{ email: "magic@example.test", callbackURL: "/dashboard" },
			cookie,
		);
		expect(requested.status).toBe(200);
		expect(state.save).not.toHaveBeenCalled();
		expect(
			requested.headers
				.getSetCookie()
				.some((value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`)),
		).toBe(false);
		const verified = await auth.handler(new Request(latestMailUrl(), { headers: { cookie } }));
		expect(verified.status).toBe(302);
		expect([...state.snapshots.values()]).toHaveLength(1);
		expect([...state.snapshots.values()][0]).toMatchObject({
			landingPath: "/blog/magic-link-entry",
		});
		expect(
			verified.headers
				.getSetCookie()
				.some(
					(value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`) && value.includes("Max-Age=0"),
				),
		).toBe(true);
	});

	it("preserves the first touch across the actual OAuth redirect and snapshots its callback", async () => {
		const cookie = sourceCookie("/blog/oauth-entry");
		const requested = await post(
			"/sign-in/social",
			{ provider: "github", callbackURL: "/dashboard" },
			cookie,
		);
		expect(requested.status).toBe(200);
		const authorize = (await requested.json()) as { url: string };
		expect(state.save).not.toHaveBeenCalled();
		expect(
			requested.headers
				.getSetCookie()
				.some((value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`)),
		).toBe(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url === "https://github.com/login/oauth/access_token")
					return Response.json({
						access_token: "mock-oauth-token",
						token_type: "bearer",
						scope: "user:email",
					});
				if (url === "https://api.github.com/user")
					return Response.json({
						id: 101,
						name: "OAuth fixture",
						login: "oauth-fixture",
						email: "oauth@example.test",
					});
				if (url === "https://api.github.com/user/emails")
					return Response.json([{ email: "oauth@example.test", primary: true, verified: true }]);
				throw new Error(`Unexpected fixture request: ${url}`);
			}),
		);
		const callback = new URL(`${origin}/api/auth/callback/github`);
		callback.searchParams.set("code", "mock-oauth-code");
		callback.searchParams.set("state", new URL(authorize.url).searchParams.get("state") ?? "");
		const oauthCookies = requested.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const completed = await auth.handler(
			new Request(callback, { headers: { cookie: `${oauthCookies}; ${cookie}` } }),
		);
		expect(completed.status).toBe(302);
		expect(new URL(completed.headers.get("location") ?? "", origin).toString()).toBe(
			`${origin}/dashboard`,
		);
		expect([...state.snapshots.values()]).toHaveLength(1);
		expect([...state.snapshots.values()][0]).toMatchObject({ landingPath: "/blog/oauth-entry" });
		expect(
			completed.headers
				.getSetCookie()
				.some(
					(value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`) && value.includes("Max-Age=0"),
				),
		).toBe(true);
	});

	it("attributes the newly registered principal after anonymous bootstrap, leaving the guest without a snapshot", async () => {
		const cookie = sourceCookie("/try");
		const guest = await runAnonymousBootstrapIdentity("attribution-guest@anonymous.invalid", () =>
			post("/sign-in/anonymous", {}, cookie),
		);
		expect(guest.status).toBe(200);
		const guestBody = (await guest.json()) as { user: { id: string } };
		expect(state.save).not.toHaveBeenCalled();
		expect(
			guest.headers.getSetCookie().some((value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`)),
		).toBe(false);
		const registered = await signup(
			"guest-registration@example.test",
			`${sessionCookie(guest)}; ${cookie}`,
		);
		expect(registered.body.user.id).not.toBe(guestBody.user.id);
		expect(state.snapshots.get(guestBody.user.id)).toBeUndefined();
		expect(state.snapshots.get(registered.body.user.id)).toMatchObject({ landingPath: "/try" });
	});

	it("does not backfill an existing account when a guest logs into it", async () => {
		const existing = await signup("guest-login-existing@example.test", "");
		await auth.handler(new Request(latestMailUrl()));
		const cookie = sourceCookie("/blog/later-guest-session");
		const guest = await runAnonymousBootstrapIdentity(
			"existing-login-guest@anonymous.invalid",
			() => post("/sign-in/anonymous", {}, cookie),
		);
		expect(guest.status).toBe(200);
		const login = await post(
			"/sign-in/email",
			{ email: "guest-login-existing@example.test", password },
			`${sessionCookie(guest)}; ${cookie}`,
		);
		expect(login.status).toBe(200);
		expect(state.save).not.toHaveBeenCalled();
		expect(state.snapshots.get(existing.body.user.id)).toBeUndefined();
	});

	it("clears a lingering source cookie on actual sign-out without changing account attribution", async () => {
		const existing = await signup("signout@example.test");
		const verified = await auth.handler(new Request(latestMailUrl()));
		const original = state.snapshots.get(existing.body.user.id);
		const signedOut = await post(
			"/sign-out",
			{},
			`${sessionCookie(verified)}; ${sourceCookie("/blog/later-session")}`,
		);
		expect(signedOut.status).toBe(200);
		expect(await signedOut.json()).toEqual({ success: true });
		expect(
			signedOut.headers
				.getSetCookie()
				.some(
					(value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`) && value.includes("Max-Age=0"),
				),
		).toBe(true);
		expect(state.save).toHaveBeenCalledTimes(1);
		expect(state.snapshots.get(existing.body.user.id)).toEqual(original);
	});

	it("does not emit attribution cookie cleanup when sign-out uses a rejected HTTP method", async () => {
		const rejected = await auth.handler(
			new Request(`${origin}/api/auth/sign-out`, {
				method: "GET",
				headers: { cookie: sourceCookie() },
			}),
		);
		expect(rejected.status).toBeGreaterThanOrEqual(400);
		expect(
			rejected.headers
				.getSetCookie()
				.some((value) => value.startsWith(`${ATTRIBUTION_COOKIE_NAME}=`)),
		).toBe(false);
		expect(state.save).not.toHaveBeenCalled();
	});

	it("keeps two browser registration sources separate", async () => {
		const first = await signup("source-a@example.test", sourceCookie("/blog/source-a"));
		const second = await signup("source-b@example.test", sourceCookie("/blog/source-b"));
		expect(state.snapshots.get(first.body.user.id)).toMatchObject({
			landingPath: "/blog/source-a",
		});
		expect(state.snapshots.get(second.body.user.id)).toMatchObject({
			landingPath: "/blog/source-b",
		});
	});

	it("keeps signup successful if optional analytics persistence fails and logs no source URL", async () => {
		state.save.mockRejectedValueOnce(new Error("private-token-in-database-error"));
		await signup("analytics-failure@example.test");
		expect(state.logger.error).toHaveBeenCalledWith(
			"Registration attribution could not be saved",
			expect.objectContaining({ ctx: "registrationAttribution", errorType: "Error" }),
		);
		expect(JSON.stringify(state.logger.error.mock.calls)).not.toContain(
			"private-token-in-database-error",
		);
	});
});
