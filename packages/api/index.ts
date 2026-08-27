import { randomBytes, randomUUID } from "node:crypto";

import { auth } from "@repo/auth";
import { isAnonymousUser } from "@repo/auth/lib/anonymous-boundary";
import {
	type GuestMediaRuntimeOverride,
	getGuestMediaConfig,
	validateEzPicLaunchEnvironment,
	validateServerEnvironment,
} from "@repo/config/server";
import { ingestProviderEvent } from "@repo/database";
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

import { createProviderWebhookHandler } from "./modules/media/webhooks/provider-webhook";
import { mediaLoadTestHandler } from "./modules/testing/media-load";
import { openApiHandler, rpcHandler } from "./orpc/handler";

export { router } from "./orpc/router";

type MaybePromise<T> = T | Promise<T>;

export interface ApiAppDependencies {
	hasGuestBootstrapProof: (request: Request) => MaybePromise<boolean>;
	hasGuestLinkIntent: (request: Request, guestUserId: string) => MaybePromise<boolean>;
	resolveGuestRuntimeOverride: (request: Request) => MaybePromise<GuestMediaRuntimeOverride>;
}

const defaultApiAppDependencies: ApiAppDependencies = {
	hasGuestBootstrapProof: () => false,
	hasGuestLinkIntent: () => false,
	resolveGuestRuntimeOverride: () => null,
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
							context.req.path.endsWith("/media/drafts") &&
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
						return c.json({ code: "NOT_FOUND" }, 404);
					}
					const runtimeOverride = await boundaryDependencies.resolveGuestRuntimeOverride(c.req.raw);
					if (!getGuestMediaConfig(process.env, runtimeOverride).enabled) {
						return c.json({ code: "NOT_FOUND" }, 404);
					}
					if (session) return c.json({ code: "ANONYMOUS_SESSION_REPLACEMENT_FORBIDDEN" }, 403);
					if (!(await boundaryDependencies.hasGuestBootstrapProof(c.req.raw))) {
						return c.json({ code: "GUEST_BOOTSTRAP_PROOF_REQUIRED" }, 403);
					}
					return auth.handler(c.req.raw);
				}
				if (session && isAnonymousUser(session.user)) {
					if (isAnonymousSessionAuthRoute(c.req.method, authPath)) {
						return auth.handler(c.req.raw);
					}
					if (isGuestLinkAuthRoute(c.req.method, authPath)) {
						if (await boundaryDependencies.hasGuestLinkIntent(c.req.raw, session.user.id)) {
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
