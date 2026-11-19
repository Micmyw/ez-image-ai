import { config as i18nConfig, isLocale, type Locale } from "@repo/i18n/config";
import { ANALYTICS_CONSENT_VERSION } from "@repo/utils/lib/analytics-policy";
import { parseCookie } from "next/dist/compiled/@edge-runtime/cookies";
import { getBotType } from "next/dist/shared/lib/router/utils/is-bot";

import type { WorkerExecutionContext } from "./request-scope";

/**
 * Anonymous homepage entries stay fresh for one minute, then refresh in the
 * background. A one-hour stale window keeps low-traffic colos from falling back
 * to a cold 1.3-2.4 s SSR render after five idle minutes (measured 2026-11-04).
 */
export const homepageCachePolicy = {
	freshSeconds: 60,
	staleWhileRevalidateSeconds: 3_600,
	ssrTimeoutMs: 8_000,
	maxCachedBytes: 2_000_000,
} as const;

const freshMs = homepageCachePolicy.freshSeconds * 1000;
const retainMs =
	(homepageCachePolicy.freshSeconds + homepageCachePolicy.staleWhileRevalidateSeconds) * 1000;
const versionId = /^[\w-]{1,128}$/;
const refreshLimitMs = 30_000;
// Only deadlines cross request boundaries. Responses and refresh I/O stay in the owning request.
const activeRefreshes = new Map<string, number>();
const localeAlternates = Object.keys(i18nConfig.locales)
	.map((locale) => locale.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|");
const healthPath = new RegExp(`^/(?:${localeAlternates})/health$`);
const sessionCookieNames = new Set([
	"better-auth.session_token",
	"__Secure-better-auth.session_token",
]);

export interface EdgeCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

export interface HomepageEdgeOptions {
	cacheVersion?: string;
	clock?: () => number;
	timeoutMs?: number;
}

const fallbackCopy: Record<Locale, { body: string; retry: string; create: string }> = {
	en: {
		body: "The page is taking longer than usual. You can retry or open the editor.",
		retry: "Retry",
		create: "Open the editor",
	},
	de: {
		body: "Die Seite braucht gerade länger als gewöhnlich. Sie können es erneut versuchen oder den Editor öffnen.",
		retry: "Erneut versuchen",
		create: "Editor öffnen",
	},
	es: {
		body: "La página está tardando más de lo habitual. Puede reintentar o abrir el editor.",
		retry: "Reintentar",
		create: "Abrir el editor",
	},
	fr: {
		body: "La page prend plus de temps que d'habitude. Vous pouvez réessayer ou ouvrir l'éditeur.",
		retry: "Réessayer",
		create: "Ouvrir l'éditeur",
	},
};

export function readDefaultCache(): EdgeCache | null {
	const cache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
	if (!cache || typeof cache.match !== "function" || typeof cache.put !== "function") return null;
	return cache;
}

/** Liveness only. Same JSON contract as `/api/health`, without a session lookup. */
export function publicHealthResponse(request: Request): Response | null {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const pathname = normalizePath(new URL(request.url).pathname);
	if (pathname !== "/health" && !healthPath.test(pathname)) return null;
	const body = JSON.stringify({ status: "alive" });
	const headers = new Headers({
		"cache-control": "no-store",
		"cdn-cache-control": "no-store",
		"content-type": "application/json",
		"x-content-type-options": "nosniff",
		"x-robots-tag": "noindex, nofollow",
	});
	return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

export async function serveAnonymousHomepage(
	request: Request,
	executionContext: WorkerExecutionContext,
	cache: EdgeCache | null,
	render: (request: Request) => Promise<Response>,
	options: HomepageEdgeOptions = {},
): Promise<Response> {
	const variant = anonymousHomepageVariant(request);
	if (!variant) return render(request);

	const clock = options.clock ?? Date.now;
	const timeoutMs = options.timeoutMs ?? homepageCachePolicy.ssrTimeoutMs;
	const cacheVersion = options.cacheVersion;
	const cacheKey =
		cache && cacheVersion && versionId.test(cacheVersion)
			? homepageCacheRequest(variant, cacheVersion)
			: null;
	const cached = cache && cacheKey ? await matchCache(cache, cacheKey) : undefined;
	const age = cached ? cachedAgeMs(cached, clock()) : null;
	if (cached && cache && cacheKey && age !== null && age <= retainMs && !bypassCacheRead(request)) {
		if (age <= freshMs) return present(cached, "HIT", age, request.method);
		refresh(render, request, executionContext, cache, cacheKey, clock);
		return present(cached, "STALE", age, request.method);
	}

	const documentRequest =
		request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
	const pending = render(documentRequest).then(
		(response) => ({ ok: true as const, response }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	const outcome = await Promise.race([
		pending,
		delay(timeoutMs).then(() => ({ ok: "timeout" as const })),
	]);
	if (outcome.ok === "timeout") {
		executionContext.waitUntil(
			pending
				.then(async (result) => {
					if (!result.ok) return;
					if (cache && cacheKey && cacheableHomepage(result.response)) {
						await store(cache, cacheKey, result.response, clock);
					} else {
						await result.response.body?.cancel();
					}
				})
				.catch(() => undefined),
		);
		if (cached && age !== null && age <= retainMs)
			return present(cached, "STALE", age, request.method);
		return degradedHomepage(variant.lang, request.method);
	}
	if (!outcome.ok) throw outcome.error;
	if (!cacheableHomepage(outcome.response)) return outcome.response;
	if (cache && cacheKey) {
		try {
			const copy = outcome.response.clone();
			executionContext.waitUntil(store(cache, cacheKey, copy, clock).catch(() => undefined));
		} catch {
			return outcome.response;
		}
	}
	return present(outcome.response, "MISS", 0, request.method);
}

function refresh(
	render: (request: Request) => Promise<Response>,
	request: Request,
	executionContext: WorkerExecutionContext,
	cache: EdgeCache,
	cacheKey: Request,
	clock: () => number,
) {
	const key = cacheKey.url;
	const now = clock();
	if ((activeRefreshes.get(key) ?? -Infinity) > now) return;
	// The platform can cancel waitUntil work. Bound ownership even if its cleanup is interrupted.
	const deadline = now + refreshLimitMs;
	activeRefreshes.set(key, deadline);
	const ownsRefresh = () => activeRefreshes.get(key) === deadline && clock() < deadline;
	const update = async () => {
		try {
			const documentRequest =
				request.method === "HEAD" ? new Request(request, { method: "GET" }) : request;
			const response = await render(documentRequest);
			if (ownsRefresh() && cacheableHomepage(response)) {
				await store(cache, cacheKey, response, clock, ownsRefresh);
			} else {
				await response.body?.cancel();
			}
		} catch {
			// Keep the previous homepage until another request can refresh it.
		} finally {
			if (activeRefreshes.get(key) === deadline) activeRefreshes.delete(key);
		}
	};
	executionContext.waitUntil(update());
}

function anonymousHomepageVariant(request: Request) {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const url = new URL(request.url);
	if (normalizePath(url.pathname) !== "/") return null;
	if (request.headers.has("authorization") || request.headers.has("range")) return null;
	if (
		request.headers.has("rsc") ||
		request.headers.has("next-router-state-tree") ||
		request.headers.has("next-router-prefetch") ||
		request.headers.has("next-router-segment-prefetch") ||
		request.headers.has("next-url") ||
		url.searchParams.has("_rsc")
	)
		return null;
	const accept = request.headers.get("accept");
	if (
		accept &&
		!accept.includes("text/html") &&
		!accept.includes("application/xhtml+xml") &&
		!accept.includes("*/*")
	)
		return null;
	const cookie = request.headers.get("cookie") ?? "";
	if (hasSessionCookie(cookie)) return null;
	const keys = [...new Set(url.searchParams.keys())];
	if (keys.some((key) => key !== "lang")) return null;
	const langValues = url.searchParams.getAll("lang");
	if (langValues.length > 1) return null;
	const requested = langValues[0] ?? "en";
	if (!isLocale(requested)) return null;
	return {
		origin: url.origin,
		lang: requested,
		consent: consentVariant(cookie),
		// Next.js serves blocking metadata to HTML-limited crawlers.
		bot: getBotType(request.headers.get("user-agent") ?? "") ?? "browser",
	};
}

function homepageCacheRequest(
	variant: NonNullable<ReturnType<typeof anonymousHomepageVariant>>,
	version: string,
) {
	const url = new URL("https://homepage-cache.internal/");
	url.searchParams.set("version", version);
	url.searchParams.set("origin", variant.origin);
	url.searchParams.set("lang", variant.lang);
	url.searchParams.set("consent", variant.consent);
	url.searchParams.set("bot", variant.bot);
	return new Request(url, { method: "GET" });
}

function bypassCacheRead(request: Request) {
	const cacheControl = request.headers.get("cache-control") ?? "";
	return (
		request.headers.get("pragma") === "no-cache" ||
		/(?:^|,)\s*(?:no-cache|no-store)\s*(?:,|$)/i.test(cacheControl)
	);
}

export function hasSessionCookie(cookie: string): boolean {
	return cookie.split(";").some((part) => sessionCookieNames.has(part.split("=")[0]?.trim() ?? ""));
}

function consentVariant(cookie: string) {
	// Use the same parser as RootLayout's cookies(), including repeated or malformed values.
	const cookies = parseCookie(cookie);
	const consent = cookies.get("consent");
	const version = cookies.get("consent_version");
	if (consent === "true" && version === ANALYTICS_CONSENT_VERSION) return "accepted";
	if (consent === "false") return "declined";
	return "undecided";
}

function cacheableHomepage(response: Response) {
	return (
		response.status === 200 &&
		(response.headers.get("content-type") ?? "").includes("text/html") &&
		!response.headers.has("set-cookie")
	);
}

async function matchCache(cache: EdgeCache, key: Request) {
	try {
		const response = await cache.match(key);
		if (!response) return undefined;
		if (!(response.headers.get("content-type") ?? "").includes("text/html")) return undefined;
		return response;
	} catch {
		return undefined;
	}
}

async function store(
	cache: EdgeCache,
	key: Request,
	response: Response,
	clock: () => number,
	ownsRefresh?: () => boolean,
) {
	const body = await response.arrayBuffer();
	if (body.byteLength === 0 || body.byteLength > homepageCachePolicy.maxCachedBytes) return;
	if (ownsRefresh && !ownsRefresh()) return;
	const headers = new Headers(response.headers);
	headers.set(
		"cache-control",
		`public, max-age=${homepageCachePolicy.freshSeconds + homepageCachePolicy.staleWhileRevalidateSeconds}`,
	);
	headers.set("x-edge-cached-at", String(clock()));
	headers.delete("cdn-cache-control");
	headers.delete("cloudflare-cdn-cache-control");
	headers.delete("content-length");
	headers.delete("set-cookie");
	headers.delete("transfer-encoding");
	headers.delete("vary");
	await cache.put(key, new Response(body, { status: 200, headers }));
}

function cachedAgeMs(response: Response, now: number) {
	const header = response.headers.get("x-edge-cached-at");
	const cachedAt = Number(header);
	if (header === null || !Number.isSafeInteger(cachedAt) || cachedAt < 0) return null;
	return Math.max(0, now - cachedAt);
}

function present(
	source: Response,
	disposition: "HIT" | "STALE" | "MISS",
	ageMs: number,
	method: string,
) {
	const headers = new Headers(source.headers);
	// The zone and browser must not reuse this copy: the cache key is anonymous-only.
	headers.set("cache-control", "private, no-store");
	headers.set("cdn-cache-control", "no-store");
	headers.set("x-edge-cache", disposition);
	headers.set("x-edge-cache-age", String(Math.floor(ageMs / 1000)));
	headers.set(
		"x-edge-cache-control",
		`public, s-maxage=${homepageCachePolicy.freshSeconds}, stale-while-revalidate=${homepageCachePolicy.staleWhileRevalidateSeconds}`,
	);
	headers.delete("x-edge-cached-at");
	headers.delete("set-cookie");
	if (method === "HEAD") {
		void source.body?.cancel();
		return new Response(null, { status: source.status, headers });
	}
	return new Response(source.body, { status: source.status, headers });
}

function degradedHomepage(lang: Locale, method: string) {
	const copy = fallbackCopy[lang];
	const query = lang === "en" ? "" : `?lang=${lang}`;
	const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>EzImageAI</title></head><body><main><h1>EzImageAI</h1><p>${copy.body}</p><p><a href="/${query}">${copy.retry}</a> · <a href="/create${query}">${copy.create}</a></p></main></body></html>`;
	const headers = new Headers({
		"cache-control": "private, no-store",
		"cdn-cache-control": "no-store",
		"content-type": "text/html; charset=utf-8",
		"x-content-type-options": "nosniff",
		"x-edge-cache": "DEGRADED",
		"x-robots-tag": "noindex, nofollow",
	});
	return new Response(method === "HEAD" ? null : html, { status: 200, headers });
}

function normalizePath(pathname: string) {
	if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
	return pathname;
}

function delay(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
