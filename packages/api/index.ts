import { randomBytes, randomUUID } from "node:crypto";

import { auth } from "@repo/auth";
import { isAnonymousUser, runAnonymousBootstrapIdentity } from "@repo/auth/lib/anonymous-boundary";
import {
	type GuestMediaRuntimeOverride,
	getGuestMediaConfig,
	validateEzPicLaunchEnvironment,
	validateServerEnvironment,
} from "@repo/config/server";
import {
	consumeGuestBootstrap,
	hasDurableGuestBootstrapProof,
	ingestProviderEvent,
	resolveGuestRuntimeConfigOverride,
} from "@repo/database";
import { db } from "@repo/database/client";
import { createProviderWebhookVerifierRegistry } from "@repo/jobs";
import { getLogContext, logger, withLogContext } from "@repo/logs";
import { webhookHandler as paymentsWebhookHandler } from "@repo/payments";
import { checkStorageMetadataAccess } from "@repo/storage";
import { getBaseUrl } from "@repo/utils";
import { tasks } from "@trigger.dev/sdk";
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import type { StatusCode } from "hono/utils/http-status";

import { trustedGuestClientIdentity } from "./modules/media/lib/draft-client-identity";
import {
	GUEST_BOOTSTRAP_COOKIE,
	getExpiredGuestBootstrapCookie,
	hashDraftClaimToken,
} from "./modules/media/lib/draft-security";
import {
	guestPrincipalEmail,
	hashGuestAbuseBinding,
	requireGuestAbuseHmac,
} from "./modules/media/lib/guest-capability";
import { createProviderWebhookHandler } from "./modules/media/webhooks/provider-webhook";
import { mediaLoadTestHandler } from "./modules/testing/media-load";
import { openApiHandler, rpcHandler } from "./orpc/handler";

export { router } from "./orpc/router";

type MaybePromise<T> = T | Promise<T>;

export interface ApiAppDependencies {
	hasGuestBootstrapProof: (request: Request) => MaybePromise<boolean>;
	hasGuestLinkIntent: (
		request: Request,
		guestUserId: string,
		guestSessionId: string,
	) => MaybePromise<boolean>;
	resolveGuestRuntimeOverride: (request: Request) => MaybePromise<GuestMediaRuntimeOverride>;
}

const defaultApiAppDependencies: ApiAppDependencies = {
	hasGuestBootstrapProof: defaultHasGuestBootstrapProof,
	hasGuestLinkIntent: defaultHasGuestLinkIntent,
	resolveGuestRuntimeOverride: defaultResolveGuestRuntimeOverride,
};

const providerWebhookVerifiers = createProviderWebhookVerifierRegistry();
const providerWebhookHandler = createProviderWebhookHandler({
	getVerifier(provider) {
		return providerWebhookVerifiers.get(provider) ?? null;
	},
	async persist({ provider, event, envelope }) {
		const result = await ingestProviderEvent(
			{
				provider,
				providerEventId: event.eventId,
				providerTaskId: event.providerTaskId,
				verifiedAt: event.receivedAt,
				receivedAt: event.receivedAt,
				providerOccurredAt: event.providerOccurredAt,
				providerSequence: event.providerSequence,
				envelope: envelope as never,
			},
			db,
		);
		return { replayed: result.replayed, eventId: result.event.id };
	},
	deliver: (payload) =>
		tasks.trigger("media-process-provider-webhook", payload).then(() => undefined),
});

export function createApiApp(dependencies: Partial<ApiAppDependencies> = {}) {
	const usesDefaultGuestBootstrap = dependencies.hasGuestBootstrapProof === undefined;
	const boundaryDependencies: ApiAppDependencies = {
		hasGuestBootstrapProof:
			dependencies.hasGuestBootstrapProof ?? defaultApiAppDependencies.hasGuestBootstrapProof,
		hasGuestLinkIntent:
			dependencies.hasGuestLinkIntent ?? defaultApiAppDependencies.hasGuestLinkIntent,
		resolveGuestRuntimeOverride:
			dependencies.resolveGuestRuntimeOverride ??
			defaultApiAppDependencies.resolveGuestRuntimeOverride,
	};

	return (
		new Hono()
			.basePath("/api")
			// Correlation values are bounded and validated before entering structured logs.
			.use("*", async (c, next) => {
				const requestId = trustedRequestId(c.req.header("x-request-id")) ?? randomUUID();
				const traceId =
					trustedTraceId(c.req.header("traceparent")) ?? randomBytes(16).toString("hex");
				return await withLogContext(
					{
						requestId,
						traceId,
						deploymentVersion:
							process.env.DEPLOYMENT_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
					},
					async () => {
						await next();
						c.header("x-request-id", requestId);
						c.header("x-trace-id", traceId);
					},
				);
			})
			// Size is enforced on both declared and streamed bodies. Webhooks keep the reconstructed raw bytes.
			.use("*", boundedRequestBody)
			// Logger middleware
			.use(honoLogger((message, ...rest) => logger.log(message, ...rest)))
			// Cors middleware
			.use(
				cors({
					origin: (origin, context) => {
						const saasOrigin = getBaseUrl(process.env.NEXT_PUBLIC_SAAS_URL, 3000);
						const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL;
						if (
							isMarketingMediaPath(context.req.path) &&
							marketingOrigin &&
							origin === marketingOrigin
						) {
							return marketingOrigin;
						}
						return origin === saasOrigin ? saasOrigin : null;
					},
					allowHeaders: ["Content-Type", "Authorization"],
					allowMethods: ["POST", "GET", "OPTIONS"],
					exposeHeaders: ["Content-Length"],
					maxAge: 600,
					credentials: false,
				}),
			)
			// Auth handler
			.on(["POST", "GET"], "/auth/**", async (c) => {
				const authPath = c.req.path.slice(c.req.path.indexOf("/auth") + "/auth".length);
				const session = await auth.api.getSession({ headers: c.req.raw.headers });
				if (authPath === "/sign-in/anonymous") {
					if (c.req.method !== "POST") {
						return withExpiredGuestBootstrapCookie(c.json({ code: "NOT_FOUND" }, 404));
					}
					const runtimeOverride = await boundaryDependencies.resolveGuestRuntimeOverride(c.req.raw);
					if (!getGuestMediaConfig(process.env, runtimeOverride).enabled) {
						return withExpiredGuestBootstrapCookie(c.json({ code: "NOT_FOUND" }, 404));
					}
					if (session) {
						return withExpiredGuestBootstrapCookie(
							c.json({ code: "ANONYMOUS_SESSION_REPLACEMENT_FORBIDDEN" }, 403),
						);
					}
					if (!(await boundaryDependencies.hasGuestBootstrapProof(c.req.raw))) {
						return withExpiredGuestBootstrapCookie(
							c.json({ code: "GUEST_BOOTSTRAP_PROOF_REQUIRED" }, 403),
						);
					}
					return usesDefaultGuestBootstrap
						? handleDurableGuestAnonymousSignIn(c.req.raw)
						: auth.handler(c.req.raw);
				}
				if (session && isAnonymousUser(session.user)) {
					if (isAnonymousSessionAuthRoute(c.req.method, authPath)) {
						return auth.handler(c.req.raw);
					}
					if (isGuestLinkAuthRoute(c.req.method, authPath)) {
						if (
							await boundaryDependencies.hasGuestLinkIntent(
								c.req.raw,
								session.user.id,
								session.session.id,
							)
						) {
							return auth.handler(c.req.raw);
						}
						return c.json({ code: "GUEST_LINK_INTENT_REQUIRED" }, 403);
					}
					return c.json({ code: "ANONYMOUS_AUTH_ROUTE_FORBIDDEN" }, 403);
				}
				return auth.handler(c.req.raw);
			})
			// Payments webhook handler
			.post("/webhooks/payments", (c) => paymentsWebhookHandler(c.req.raw))
			// Provider webhooks must receive the untouched raw body before the oRPC catch-all.
			.post("/webhooks/ai/:provider", (c) =>
				providerWebhookHandler(c.req.param("provider"), c.req.raw),
			)
			.post("/webhooks/moderation/:provider", (c) => c.json({ code: "WEBHOOK_NOT_SUPPORTED" }, 404))
			// Pure process liveness; no dependencies or business effects.
			.get("/health", (c) => c.json({ status: "alive" }))
			// Deliberately absent unless the guarded local/staging load-test environment is explicit.
			.post("/testing/media-load", mediaLoadTestHandler)
			// Read-only readiness checks. Storage access is metadata-only.
			.get("/ready", async (c) => {
				const checks = await Promise.allSettled([
					Promise.resolve().then(() =>
						validateServerEnvironment(process.env, { requireProviderCredentials: false }),
					),
					db.$queryRaw`SELECT 1 AS "ready"`,
					checkStorageMetadataAccess(),
					Promise.resolve().then(() => assertTriggerConfiguration()),
					Promise.resolve().then(() => assertEzPicLaunchReadinessEnvironment()),
				]);
				const ready = checks.every((check) => check.status === "fulfilled");
				const session = await auth.api.getSession({ headers: c.req.raw.headers });
				const isAdmin = session?.user.role === "admin";
				return c.json(
					{
						status: ready ? "ready" : "not_ready",
						...(isAdmin
							? {
									checks: ["configuration", "database", "storage", "trigger", "launch"].map(
										(name, index) => ({
											name,
											ok: checks[index]?.status === "fulfilled",
											error:
												checks[index]?.status === "rejected" ? safeReadinessError() : undefined,
										}),
									),
								}
							: {}),
					},
					ready ? 200 : 503,
				);
			})
			// oRPC handlers (for RPC and OpenAPI)
			.use("*", async (c, next) => {
				const { requestId, traceId } = getLogContext();
				const context = {
					headers: new Headers(c.req.raw.headers),
					responseHeaders: new Headers(),
					requestId,
					traceId,
				};

				const isRpc = c.req.path.includes("/rpc/");

				const handler = isRpc ? rpcHandler : openApiHandler;

				const prefix = isRpc ? "/api/rpc" : "/api";

				const { matched, response } = await handler.handle(c.req.raw, {
					prefix,
					context,
				});

				if (matched) {
					const outgoing = c.newResponse(response.body, response.status as StatusCode);
					for (const [name, value] of response.headers) outgoing.headers.append(name, value);
					for (const [name, value] of context.responseHeaders) outgoing.headers.append(name, value);
					return outgoing;
				}

				await next();
			})
	);
}

export const app = createApiApp();

async function defaultResolveGuestRuntimeOverride(): Promise<GuestMediaRuntimeOverride> {
	try {
		return await resolveGuestRuntimeConfigOverride(db);
	} catch {
		return null;
	}
}

async function defaultHasGuestBootstrapProof(request: Request): Promise<boolean> {
	const promotionPeriod = process.env.GUEST_PROMOTION_PERIOD;
	const token = readRequestCookie(request, GUEST_BOOTSTRAP_COOKIE);
	if (!promotionPeriod || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
	try {
		return await hasDurableGuestBootstrapProof(
			{ claimHash: hashDraftClaimToken(token), promotionPeriod },
			db,
		);
	} catch {
		return false;
	}
}

async function defaultHasGuestLinkIntent(
	request: Request,
	guestUserId: string,
	guestSessionId: string,
): Promise<boolean> {
	const token = readRequestCookie(request, "media_guest_link_intent");
	if (!guestUserId || !guestSessionId || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
		return false;
	}
	const runtimeOverride = await defaultResolveGuestRuntimeOverride();
	const guestConfig = getGuestMediaConfig(process.env, runtimeOverride);
	const promotionPeriod = guestConfig.promotionPeriod;
	if (!promotionPeriod) return false;
	let abuseHmac: ReturnType<typeof requireGuestAbuseHmac>;
	try {
		abuseHmac = requireGuestAbuseHmac(guestConfig);
	} catch {
		return false;
	}
	try {
		return Boolean(
			await db.guestLinkIntent.findFirst({
				where: {
					tokenHash: hashDraftClaimToken(token),
					anonymousOwnerId: guestUserId,
					promotionPeriod,
					sourceSessionHash: hashGuestAbuseBinding(
						abuseHmac.secretKey,
						abuseHmac.keyVersion,
						"guest-source-session",
						guestSessionId,
					),
					state: "LINKING",
					expiresAt: { gt: new Date() },
				},
				select: { id: true },
			}),
		);
	} catch {
		return false;
	}
}

async function handleDurableGuestAnonymousSignIn(request: Request): Promise<Response> {
	const saasOriginValue = process.env.NEXT_PUBLIC_SAAS_URL;
	const authSecret = process.env.BETTER_AUTH_SECRET;
	const token = readRequestCookie(request, GUEST_BOOTSTRAP_COOKIE);
	const identity = trustedGuestClientIdentity(request.headers, process.env);
	if (
		!saasOriginValue ||
		!authSecret ||
		!token ||
		!/^[A-Za-z0-9_-]{43}$/.test(token) ||
		!identity
	) {
		return withExpiredGuestBootstrapCookie(
			guestAuthErrorResponse("GUEST_BOOTSTRAP_BOUNDARY_REJECTED", 403),
		);
	}
	const saasOrigin = new URL(saasOriginValue).origin;
	const claimHash = hashDraftClaimToken(token);
	const principalEmail = guestPrincipalEmail(authSecret, claimHash);
	const runtimeOverride = await defaultResolveGuestRuntimeOverride();
	const guestConfig = getGuestMediaConfig(process.env, runtimeOverride);
	const promotionPeriod = guestConfig.promotionPeriod;
	let abuseHmac: ReturnType<typeof requireGuestAbuseHmac>;
	try {
		abuseHmac = requireGuestAbuseHmac(guestConfig);
	} catch {
		return withExpiredGuestBootstrapCookie(
			guestAuthErrorResponse("GUEST_BOOTSTRAP_BOUNDARY_REJECTED", 403),
		);
	}
	if (!promotionPeriod) {
		return withExpiredGuestBootstrapCookie(
			guestAuthErrorResponse("GUEST_BOOTSTRAP_BOUNDARY_REJECTED", 403),
		);
	}
	if (!guestConfig.enabled) {
		return withExpiredGuestBootstrapCookie(
			guestAuthErrorResponse("GUEST_CAPABILITY_DISABLED", 404),
		);
	}

	try {
		const result = await consumeGuestBootstrap(
			{
				claimHash,
				expectedOrigin: saasOrigin,
				origin: request.headers.get("origin"),
				principalEmail,
				promotionPeriod,
				ipHash: hashGuestAbuseBinding(
					abuseHmac.secretKey,
					abuseHmac.keyVersion,
					"guest-ip",
					identity.ip,
				),
				subnetHash: hashGuestAbuseBinding(
					abuseHmac.secretKey,
					abuseHmac.keyVersion,
					"guest-subnet",
					identity.subnet,
				),
				limits: guestConfig.limits,
				abuseEvidenceTtlMs: guestConfig.abuseEvidenceTtlMs,
			},
			async ({ email }) => {
				const authHeaders = new Headers(request.headers);
				authHeaders.set("content-type", "application/json");
				authHeaders.delete("content-length");
				const authRequest = new Request(request, {
					body: "{}",
					headers: authHeaders,
				});
				const response = await runAnonymousBootstrapIdentity(email, () =>
					auth.handler(authRequest),
				);
				if (!response.ok) {
					throw new GuestAuthHandlerResponseError("GUEST_BOOTSTRAP_FAILED", 403);
				}
				const payload = (await response.clone().json()) as { user?: { id?: unknown } };
				if (typeof payload.user?.id !== "string") {
					throw new GuestAuthHandlerResponseError("GUEST_PRINCIPAL_INVALID", 500);
				}
				const canonicalUser = await db.user.findFirst({
					where: { id: payload.user.id, email, isAnonymous: true },
					select: { id: true },
				});
				if (!canonicalUser) {
					throw new GuestAuthHandlerResponseError("GUEST_PRINCIPAL_INVALID", 500);
				}
				return { userId: payload.user.id, value: response };
			},
			db,
		);
		if (result.outcome === "REPLAY") {
			return withExpiredGuestBootstrapCookie(
				guestAuthErrorResponse("GUEST_BOOTSTRAP_RETRY_IN_ORIGINAL_BROWSER", 409),
			);
		}
		return requestUrlFlag(request, "handoff") === "1"
			? guestHandoffRedirect(result.value, request)
			: withExpiredGuestBootstrapCookie(result.value);
	} catch (error) {
		if (error instanceof GuestAuthHandlerResponseError) {
			return withExpiredGuestBootstrapCookie(
				guestAuthErrorResponse(error.publicCode, error.publicStatus),
			);
		}
		const failure = stableGuestAuthFailure(error);
		return withExpiredGuestBootstrapCookie(guestAuthErrorResponse(failure.code, failure.status));
	}
}

export function stableGuestAuthFailure(error: unknown): {
	code:
		| "GUEST_BOOTSTRAP_FAILED"
		| "GUEST_BOOTSTRAP_IN_PROGRESS"
		| "GUEST_BOOTSTRAP_LEASE_LOST"
		| "GUEST_BOOTSTRAP_UNAVAILABLE"
		| "GUEST_TEMPORARY_USER_CAP_EXCEEDED";
	status: StatusCode;
} {
	const code = error instanceof Error ? error.message : "";
	if (code === "GUEST_BOOTSTRAP_IN_PROGRESS" || code === "GUEST_BOOTSTRAP_LEASE_LOST") {
		return { code, status: 409 };
	}
	if (code === "GUEST_BOOTSTRAP_UNAVAILABLE") return { code, status: 403 };
	if (code === "GUEST_TEMPORARY_USER_CAP_EXCEEDED") return { code, status: 429 };
	return { code: "GUEST_BOOTSTRAP_FAILED", status: 403 };
}

class GuestAuthHandlerResponseError extends Error {
	constructor(
		readonly publicCode: "GUEST_BOOTSTRAP_FAILED" | "GUEST_PRINCIPAL_INVALID",
		readonly publicStatus: StatusCode,
	) {
		super(publicCode);
	}
}

function guestHandoffRedirect(authResponse: Response, request: Request): Response {
	const headers = new Headers({
		Location: new URL("/draft/continue", request.url).toString(),
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	for (const cookie of authResponse.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
	headers.append(
		"Set-Cookie",
		getExpiredGuestBootstrapCookie(process.env.NODE_ENV === "production"),
	);
	return new Response(null, { status: 303, headers });
}

function withExpiredGuestBootstrapCookie(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.append(
		"Set-Cookie",
		getExpiredGuestBootstrapCookie(process.env.NODE_ENV === "production"),
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function guestAuthErrorResponse(code: string, status: StatusCode): Response {
	return Response.json({ code }, { status });
}

function readRequestCookie(request: Request, name: string): string | null {
	for (const entry of request.headers.get("cookie")?.split(";") ?? []) {
		const [key, ...value] = entry.trim().split("=");
		if (key === name) {
			try {
				return decodeURIComponent(value.join("="));
			} catch {
				return null;
			}
		}
	}
	return null;
}

function requestUrlFlag(request: Request, name: string): string | null {
	try {
		return new URL(request.url).searchParams.get(name);
	} catch {
		return null;
	}
}

function isMarketingMediaPath(path: string): boolean {
	return [
		"/media/drafts",
		"/media/guest-capability",
		"/media/guest-drafts/upload-intents",
		"/media/guest-drafts/upload-completions",
	].some((suffix) => path.endsWith(suffix));
}

function assertTriggerConfiguration(): void {
	if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Trigger credentials are missing");
	if (!process.env.TRIGGER_PROJECT_REF) throw new Error("Trigger project reference is missing");
}

function assertEzPicLaunchReadinessEnvironment(): void {
	if (process.env.NODE_ENV === "production") {
		validateEzPicLaunchEnvironment(process.env, { requireProviderCredentials: false });
	}
}

function safeReadinessError(): string {
	return "Readiness check failed";
}

const ANONYMOUS_SESSION_AUTH_ROUTES = new Set(["GET /get-session", "POST /sign-out"]);

const GUEST_LINK_AUTH_ROUTES = new Set([
	"POST /sign-in/email",
	"POST /sign-up/email",
	"POST /sign-in/magic-link",
	"GET /magic-link/verify",
	"POST /sign-in/social",
	"GET /callback/google",
	"GET /callback/github",
	"GET /verify-email",
]);

function isAnonymousSessionAuthRoute(method: string, path: string): boolean {
	return ANONYMOUS_SESSION_AUTH_ROUTES.has(`${method} ${path}`);
}

function isGuestLinkAuthRoute(method: string, path: string): boolean {
	return GUEST_LINK_AUTH_ROUTES.has(`${method} ${path}`);
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DRAFT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

function requestBodyLimit(path: string): number {
	return path.endsWith("/media/drafts") ? DRAFT_BODY_LIMIT_BYTES : DEFAULT_BODY_LIMIT_BYTES;
}

async function boundedRequestBody(context: Context, next: Next) {
	const request = context.req.raw;
	if (!request.body) return next();
	const maximumBytes = requestBodyLimit(context.req.path);
	const declaredBytes = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
		return context.json({ code: "PAYLOAD_TOO_LARGE" }, 413);
	}

	const reader = Reflect.get(Object.getPrototypeOf(request.body), "getReader").call(
		request.body,
	) as ReadableStreamDefaultReader<Uint8Array> | undefined;
	if (!reader) return context.json({ code: "INVALID_REQUEST_BODY" }, 400);
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maximumBytes) return context.json({ code: "PAYLOAD_TOO_LARGE" }, 413);
		chunks.push(value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	context.req.raw = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body,
	});
	return next();
}

function trustedRequestId(value: string | undefined): string | null {
	return value && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
}

function trustedTraceId(value: string | undefined): string | null {
	if (!value) return null;
	const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(value);
	return match?.[1]?.toLowerCase() ?? null;
}
