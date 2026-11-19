import { describe, expect, it, vi } from "vitest";

import {
	publicHealthResponse,
	serveAnonymousDocument as serveDocument,
	type EdgeCache,
} from "./public-edge";
import type { WorkerExecutionContext } from "./request-scope";

const serveAnonymousDocument: typeof serveDocument = (request, execution, cache, render, options) =>
	serveDocument(request, execution, cache, render, { cacheVersion: "test-release", ...options });

function memoryCache(): EdgeCache & { urls: () => string[] } {
	const entries = new Map<string, Response>();
	return {
		urls: () => [...entries.keys()],
		async match(request) {
			const found = entries.get(request.url);
			return found ? found.clone() : undefined;
		},
		async put(request, response) {
			entries.set(request.url, response.clone());
		},
	};
}

function context() {
	const pending: Promise<unknown>[] = [];
	const execution: WorkerExecutionContext = {
		waitUntil(promise) {
			pending.push(promise);
		},
		passThroughOnException() {},
	};
	return { execution, flush: () => Promise.all(pending) };
}

function html(body = "<html>home</html>", extra?: Record<string, string>) {
	const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
	for (const [name, value] of Object.entries(extra ?? {})) {
		if (value) headers.set(name, value);
	}
	return new Response(body, { status: 200, headers });
}

describe.sequential("public edge health and anonymous homepage", () => {
	it("answers locale health checks with alive JSON and no redirect", async () => {
		for (const path of [
			"/health",
			"/health/",
			"/en/health",
			"/de/health",
			"/es/health",
			"/fr/health",
		]) {
			const response = publicHealthResponse(new Request(`https://ezimageai.com${path}`));
			expect(response?.status).toBe(200);
			expect(response?.headers.get("location")).toBeNull();
			expect(response?.headers.get("cache-control")).toBe("no-store");
			expect(await response?.json()).toEqual({ status: "alive" });
		}
		const head = publicHealthResponse(
			new Request("https://ezimageai.com/de/health", { method: "HEAD" }),
		);
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe("");
		expect(
			publicHealthResponse(new Request("https://ezimageai.com/health", { method: "POST" })),
		).toBeNull();
		expect(publicHealthResponse(new Request("https://ezimageai.com/healthz"))).toBeNull();
	});

	it("serves the cached anonymous homepage for 24 hours without scheduling another render", async () => {
		const cache = memoryCache();
		let renders = 0;
		const render = async () => {
			renders += 1;
			return html(`<html>render-${renders}</html>`);
		};
		const cachedAt = 1_000_000;
		let now = cachedAt;
		const ctx = context();
		const first = await serveAnonymousDocument(
			new Request("https://ezimageai.com/"),
			ctx.execution,
			cache,
			render,
			{
				clock: () => now,
			},
		);
		expect(first.headers.get("x-edge-cache")).toBe("MISS");
		expect(first.headers.get("cache-control")).toBe("private, no-store");
		expect(await first.text()).toContain("render-1");
		await ctx.flush();

		for (const age of [86, 43_200, 86_400]) {
			now = cachedAt + age * 1000;
			const next = context();
			const response = await serveAnonymousDocument(
				new Request("https://ezimageai.com/?lang=en"),
				next.execution,
				cache,
				render,
				{ clock: () => now },
			);
			expect(response.headers.get("x-edge-cache"), `age ${age}s`).toBe("HIT");
			expect(response.headers.get("x-edge-cache-age")).toBe(String(age));
			expect(await response.text()).toContain("render-1");
			expect(await next.flush()).toHaveLength(0);
			expect(renders).toBe(1);
		}
		expect(first.headers.get("x-edge-cache-control")).toBe(
			"public, s-maxage=86400, stale-while-revalidate=3600",
		);

		const head = await serveAnonymousDocument(
			new Request("https://ezimageai.com/", { method: "HEAD" }),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(head.status).toBe(200);
		expect(head.headers.get("x-edge-cache")).toBe("HIT");
		expect(await head.text()).toBe("");
		expect(renders).toBe(1);
	});

	it("gives only the first concurrent stale request ownership of the background refresh", async () => {
		const cache = memoryCache();
		let renders = 0;
		let releaseRefresh: () => void = () => {};
		const render = async () => {
			renders += 1;
			const generation = renders;
			if (generation > 1)
				await new Promise<void>((resolve) => {
					releaseRefresh = resolve;
				});
			return html(`<html>render-${generation}</html>`);
		};
		let now = 5_000_000;
		const ctx = context();
		await serveAnonymousDocument(
			new Request("https://ezimageai.com/?lang=de"),
			ctx.execution,
			cache,
			render,
			{
				clock: () => now,
			},
		);
		await ctx.flush();
		now += (24 * 60 + 1) * 60_000;
		const overlapping = [context(), context(), context()];
		const stale = await Promise.all(
			overlapping.map(({ execution }) =>
				serveAnonymousDocument(
					new Request("https://ezimageai.com/?lang=de"),
					execution,
					cache,
					render,
					{
						clock: () => now,
					},
				),
			),
		);
		for (const response of stale) {
			expect(response.headers.get("x-edge-cache")).toBe("STALE");
			expect(await response.text()).toContain("render-1");
		}
		expect(renders).toBe(2);
		releaseRefresh();
		const registeredRefreshes = await Promise.all(overlapping.map((scope) => scope.flush()));
		expect(registeredRefreshes.flat()).toHaveLength(1);
		expect(renders).toBe(2);
		const fresh = await serveAnonymousDocument(
			new Request("https://ezimageai.com/?lang=de"),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(fresh.headers.get("x-edge-cache")).toBe("HIT");
		expect(await fresh.text()).toContain("render-2");
	});

	it("leaves the stale document readable after a failed refresh and permits a later retry", async () => {
		const cache = memoryCache();
		const render = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(html("<html>previous</html>"))
			.mockRejectedValueOnce(new Error("render failed"))
			.mockResolvedValueOnce(html("<html>recovered</html>"));
		let now = 7_000_000;
		const load = async () => {
			const ctx = context();
			const response = await serveAnonymousDocument(
				new Request("https://ezimageai.com/?lang=es"),
				ctx.execution,
				cache,
				render,
				{ clock: () => now },
			);
			const body = await response.text();
			await ctx.flush();
			return { body, disposition: response.headers.get("x-edge-cache") };
		};
		await load();
		now += (24 * 60 + 1) * 60_000;
		expect(await load()).toEqual({ body: "<html>previous</html>", disposition: "STALE" });
		expect(await load()).toEqual({ body: "<html>previous</html>", disposition: "STALE" });
		expect(await load()).toEqual({ body: "<html>recovered</html>", disposition: "HIT" });
		expect(render).toHaveBeenCalledTimes(3);
	});

	it("lets a newer refresh recover when the previous request loses its waitUntil lifetime", async () => {
		const cache = memoryCache();
		let finishOldRefresh!: (value: Response) => void;
		const render = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(html("<html>initial</html>"))
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishOldRefresh = resolve;
					}),
			)
			.mockResolvedValueOnce(html("<html>current</html>"));
		let now = 8_000_000;
		const get = (ctx: ReturnType<typeof context>) =>
			serveAnonymousDocument(
				new Request("https://ezimageai.com/?lang=fr"),
				ctx.execution,
				cache,
				render,
				{
					clock: () => now,
				},
			);
		const initial = context();
		await get(initial);
		await initial.flush();
		now += (24 * 60 + 1) * 60_000;
		const forgotten = context();
		expect((await get(forgotten)).headers.get("x-edge-cache")).toBe("STALE");

		now += 31_000;
		const recovered = context();
		expect((await get(recovered)).headers.get("x-edge-cache")).toBe("STALE");
		await recovered.flush();
		finishOldRefresh(html("<html>expired</html>"));
		await forgotten.flush();
		expect(await (await get(context())).text()).toBe("<html>current</html>");
		expect(render).toHaveBeenCalledTimes(3);
	});

	it("isolates releases, skips legacy entries, and reuses only the matching document on rollback", async () => {
		const cache = memoryCache();
		const clock = () => 500_000;
		await cache.put(
			new Request("https://homepage-cache.internal/?lang=en&consent=undecided"),
			html("<html>legacy release</html>", { "x-edge-cached-at": String(clock()) }),
		);
		const load = async (cacheVersion?: string) => {
			const ctx = context();
			const response = await serveDocument(
				new Request("https://ezimageai.com/"),
				ctx.execution,
				cache,
				async () => html(`<html>${cacheVersion ?? "no release"}</html>`),
				{ cacheVersion, clock },
			);
			const body = await response.text();
			await ctx.flush();
			return { body, disposition: response.headers.get("x-edge-cache") };
		};
		expect(await load()).toMatchObject({ body: "<html>no release</html>" });
		expect(cache.urls()).toHaveLength(1);
		expect(await load("release-a")).toEqual({
			body: "<html>release-a</html>",
			disposition: "MISS",
		});
		expect(await load("release-b")).toEqual({
			body: "<html>release-b</html>",
			disposition: "MISS",
		});
		expect(await load("release-a")).toEqual({ body: "<html>release-a</html>", disposition: "HIT" });
		expect(cache.urls()).toHaveLength(3);
	});

	it("keeps signed-in, tracked, and client-navigation requests off the anonymous cache", async () => {
		const cache = memoryCache();
		let renders = 0;
		const render = async (request: Request) => {
			renders += 1;
			return html(`<html>${new URL(request.url).pathname}</html>`);
		};
		const ctx = context();
		const requests = [
			new Request("https://ezimageai.com/", {
				headers: { cookie: "better-auth.session_token=signed-in" },
			}),
			new Request("https://ezimageai.com/", {
				headers: { cookie: "__Secure-better-auth.session_token=signed-in" },
			}),
			new Request("https://ezimageai.com/", {
				headers: { cookie: "__Secure-better-auth.session_token =signed-in" },
			}),
			new Request("https://ezimageai.com/", { headers: { authorization: "Bearer ignored" } }),
			new Request("https://ezimageai.com/?job=existing&mode=image"),
			new Request("https://ezimageai.com/?videoJob=existing&mode=video"),
			new Request("https://ezimageai.com/?mode=video"),
			new Request("https://ezimageai.com/?utm=campaign"),
			new Request("https://ezimageai.com/", { headers: { rsc: "1" } }),
			new Request("https://ezimageai.com/", { headers: { "next-router-state-tree": "[]" } }),
			new Request("https://ezimageai.com/", { headers: { "next-router-prefetch": "1" } }),
			new Request("https://ezimageai.com/?_rsc=prediction"),
			new Request("https://ezimageai.com/examples"),
		];
		for (const request of requests) {
			const response = await serveAnonymousDocument(request, ctx.execution, cache, render);
			expect(response.headers.get("x-edge-cache")).toBeNull();
		}
		await ctx.flush();
		expect(cache.urls()).toEqual([]);
		expect(renders).toBe(requests.length);
	});

	it("partitions anonymous HTML by consent and does not store a Set-Cookie response", async () => {
		const cache = memoryCache();
		const render = async (request: Request) =>
			html(`<html>${request.headers.get("cookie") ?? "none"}</html>`);
		const ctx = context();
		const accepted = await serveAnonymousDocument(
			new Request("https://ezimageai.com/", {
				headers: { cookie: "consent=true; consent_version=2" },
			}),
			ctx.execution,
			cache,
			render,
		);
		const declined = await serveAnonymousDocument(
			new Request("https://ezimageai.com/", { headers: { cookie: "consent=false" } }),
			ctx.execution,
			cache,
			render,
		);
		expect(await accepted.text()).toContain("consent=true");
		expect(await declined.text()).toContain("consent=false");
		await ctx.flush();
		expect(cache.urls()).toHaveLength(2);

		const issued = await serveAnonymousDocument(
			new Request("https://ezimageai.com/", { headers: { "x-test-set-cookie": "a=b" } }),
			ctx.execution,
			cache,
			async (request) =>
				html("<html>cookie</html>", {
					"set-cookie": request.headers.get("x-test-set-cookie") ?? "",
				}),
		);
		expect(issued.headers.get("set-cookie")).toBe("a=b");
		expect(issued.headers.get("x-edge-cache")).toBeNull();
		await ctx.flush();
		expect(cache.urls()).toHaveLength(2);
	});

	it("matches Next.js consent parsing for legacy, malformed and duplicate Cookie values", async () => {
		const cache = memoryCache();
		const render = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(html("<html>undecided</html>"))
			.mockResolvedValueOnce(html("<html>declined</html>"));
		const get = async (cookie: string) => {
			const ctx = context();
			const response = await serveAnonymousDocument(
				new Request("https://ezimageai.com/", { headers: { cookie } }),
				ctx.execution,
				cache,
				render,
			);
			await ctx.flush();
			return response.text();
		};
		expect(await get("consent=true; consent_version=1")).toBe("<html>undecided</html>");
		expect(await get("consent=%E0%80; consent_version=2")).toBe("<html>undecided</html>");
		expect(await get("consent=false")).toBe("<html>declined</html>");
		expect(await get("consent=true; consent_version=2; consent=false")).toBe(
			"<html>declined</html>",
		);
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("keeps the crawler document with blocking metadata separate from browser HTML", async () => {
		const cache = memoryCache();
		const render = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(html("<html><body>browser</body></html>"))
			.mockResolvedValueOnce(html('<html><head><link rel="canonical" href="/"/></head></html>'));
		const get = async (userAgent: string) => {
			const ctx = context();
			const response = await serveAnonymousDocument(
				new Request("https://ezimageai.com/", { headers: { "user-agent": userAgent } }),
				ctx.execution,
				cache,
				render,
			);
			await ctx.flush();
			return response.text();
		};
		expect(await get("Mozilla/5.0")).toContain("browser");
		expect(await get("bingbot/2.0")).toContain('<head><link rel="canonical"');
		expect(await get("Twitterbot/1.0")).toContain('<head><link rel="canonical"');
		expect(await get("Mozilla/5.0 Chrome/149.0")).toContain("browser");
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("honors an explicit document reload and updates the existing versioned copy", async () => {
		const cache = memoryCache();
		const render = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(html("<html>initial</html>"))
			.mockResolvedValueOnce(html("<html>reloaded</html>"));
		const ctx = context();
		const get = (headers?: HeadersInit) =>
			serveAnonymousDocument(
				new Request("https://ezimageai.com/", { headers }),
				ctx.execution,
				cache,
				render,
			);
		expect((await get()).headers.get("x-edge-cache")).toBe("MISS");
		await ctx.flush();
		const reloaded = await get({ "cache-control": "no-cache" });
		expect(reloaded.headers.get("x-edge-cache")).toBe("MISS");
		expect(await reloaded.text()).toContain("reloaded");
		await ctx.flush();
		const cached = await get();
		expect(cached.headers.get("x-edge-cache")).toBe("HIT");
		expect(await cached.text()).toContain("reloaded");
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("propagates an anonymous homepage failure instead of serving the fallback", async () => {
		const ctx = context();
		await expect(
			serveAnonymousDocument(
				new Request("https://ezimageai.com/"),
				ctx.execution,
				memoryCache(),
				async () => {
					throw new Error("origin down");
				},
				{ timeoutMs: 1_000 },
			),
		).rejects.toThrow("origin down");
	});

	it("returns a lightweight page when anonymous SSR exceeds the timeout, then stores the late result", async () => {
		const cache = memoryCache();
		let resolveRender: (response: Response) => void = () => {};
		const render = () =>
			new Promise<Response>((resolve) => {
				resolveRender = resolve;
			});
		const ctx = context();
		const response = await serveAnonymousDocument(
			new Request("https://ezimageai.com/?lang=fr"),
			ctx.execution,
			cache,
			render,
			{ timeoutMs: 20, clock: () => 50_000 },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-edge-cache")).toBe("DEGRADED");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("location")).toBeNull();
		const body = await response.text();
		expect(body).toContain('lang="fr"');
		expect(body).toContain("Réessayer");
		expect(body).not.toContain("/login");

		resolveRender(html("<html>late-home</html>"));
		await ctx.flush();
		const hit = await serveAnonymousDocument(
			new Request("https://ezimageai.com/?lang=fr"),
			ctx.execution,
			cache,
			render,
			{ clock: () => 50_000 },
		);
		expect(hit.headers.get("x-edge-cache")).toBe("HIT");
		expect(await hit.text()).toContain("late-home");
	});

	it("renders a new homepage when the prior copy is more than 25 hours old", async () => {
		const cache = memoryCache();
		let renders = 0;
		const render = async () => {
			renders += 1;
			return html(`<html>render-${renders}</html>`);
		};
		let now = 5_000_000;
		const ctx = context();
		await serveAnonymousDocument(
			new Request("https://ezimageai.com/"),
			ctx.execution,
			cache,
			render,
			{
				clock: () => now,
			},
		);
		await ctx.flush();
		const [key] = cache.urls();
		const stored = await cache.match(new Request(key!));
		expect(stored?.headers.get("cache-control")).toBe("public, max-age=90000");

		now += 25 * 60 * 60_000 + 1_000;
		const later = context();
		const fresh = await serveAnonymousDocument(
			new Request("https://ezimageai.com/"),
			later.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(fresh.headers.get("x-edge-cache")).toBe("MISS");
		expect(await fresh.text()).toContain("render-2");
		await later.flush();
		expect(renders).toBe(2);
	});
});

describe.sequential("anonymous document cache", () => {
	it("isolates Create from the existing homepage key and reuses the same version for hours", async () => {
		const cache = memoryCache();
		const render = vi.fn(async (request: Request) => html(new URL(request.url).pathname));
		let now = 5_000_000;
		const load = async (path: string, cacheVersion = "test-release", method = "GET") => {
			const ctx = context();
			const response = await serveAnonymousDocument(
				new Request(`https://ezimageai.com${path}`, { method }),
				ctx.execution,
				cache,
				render,
				{ cacheVersion, clock: () => now },
			);
			const body = await response.text();
			const pending = await ctx.flush();
			return { body, headers: response.headers, pending };
		};
		await cache.put(
			new Request(
				"https://homepage-cache.internal/?version=test-release&origin=https%3A%2F%2Fezimageai.com&lang=en&consent=undecided&bot=browser",
			),
			html("homepage", { "x-edge-cached-at": String(now) }),
		);
		const home = await load("/");
		expect(home.headers.get("x-edge-cache")).toBe("HIT");
		expect(home.body).toBe("homepage");
		const create = await load("/create", "test-release", "HEAD");
		expect(create.headers.get("x-edge-cache")).toBe("MISS");
		expect(create.headers.get("cache-control")).toBe("private, no-store");
		expect(create.headers.get("cdn-cache-control")).toBe("no-store");
		expect(create.headers.get("x-edge-cache-control")).toContain("s-maxage=86400");
		expect(create.body).toBe("");
		expect(render.mock.calls[0]?.[0].method).toBe("GET");

		now += 12 * 60 * 60_000;
		const warm = await load("/create");
		expect(warm.headers.get("x-edge-cache")).toBe("HIT");
		expect(warm.headers.get("x-edge-cache-age")).toBe("43200");
		expect(warm.body).toBe("/create");
		expect(warm.pending).toHaveLength(0);
		expect(render).toHaveBeenCalledOnce();

		const nextRelease = await load("/create", "next-release");
		expect(nextRelease.headers.get("x-edge-cache")).toBe("MISS");
		expect(cache.urls()).toHaveLength(3);
		expect((await load("/create")).headers.get("x-edge-cache")).toBe("HIT");

		now += (12 * 60 + 1) * 60_000;
		const stale = await load("/create");
		expect(stale.headers.get("x-edge-cache")).toBe("STALE");
		expect(stale.pending).toHaveLength(1);
		expect(render).toHaveBeenCalledTimes(3);
	});

	it.each(["/", "/create"])(
		"passes private and non-document requests through untouched on %s",
		async (path) => {
			const cache = memoryCache();
			const load = (request: Request, render: (request: Request) => Promise<Response>) =>
				serveAnonymousDocument(request, context().execution, cache, render);
			const url = `https://ezimageai.com${path}`;
			const publicDocument = new Request(url);
			const warmup = context();
			await serveAnonymousDocument(publicDocument, warmup.execution, cache, async () =>
				html("public document"),
			);
			await warmup.flush();

			const queries = [
				"?job=private",
				"?videoJob=private",
				"?guestAsset=private",
				"?authDraft=private",
				"?mode=video",
				"?resume",
				"?utm_source=campaign",
				"?lang=de&lang=es",
				"?lang=unknown",
				"?_rsc=app-router",
			];
			const requestHeaders: HeadersInit[] = [
				{ cookie: "NEXT_LOCALE=fr; better-auth.session_token=account" },
				{ cookie: "__Secure-better-auth.session_token=guest-session" },
				{ cookie: "__Secure-better-auth.session_data.0=legacy" },
				{ cookie: "__Host-ezpic_guest=recognized-browser" },
				{ cookie: "__prerender_bypass=preview" },
				{ authorization: "Bearer example" },
				{ range: "bytes=0-100" },
				{ "if-none-match": '"etag"' },
				{ rsc: "1" },
				{ "next-router-state-tree": "[]" },
				{ "next-router-prefetch": "1" },
				{ "next-router-segment-prefetch": "/_tree" },
				{ "next-url": path },
				{ purpose: "prefetch" },
				{ "sec-purpose": "prefetch;prerender" },
				{ "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
				{ "x-matched-path": "/examples" },
				{ "x-middleware-set-cookie": "consent=false" },
				{ "x-opennext-initial-url": "/examples" },
				{ "content-security-policy": "script-src 'self'" },
				{ accept: "text/x-component, */*" },
				{ accept: "application/json" },
			];
			const requests = [
				new Request(url, { method: "POST" }),
				new Request(`${url}/`),
				new Request(`${url}.rsc`),
				...queries.map((query) => new Request(url + query)),
				...requestHeaders.map((headers) => new Request(url, { headers })),
			];
			const render = vi.fn(async (_request: Request) => html("origin"));
			for (const [index, request] of requests.entries()) {
				const bypassed = await load(request, render);
				expect(
					bypassed.headers.get("x-edge-cache"),
					`${request.method} ${request.url} (${[...request.headers.keys()].join(", ")})`,
				).toBeNull();
				expect(render.mock.calls[index]?.[0]).toBe(request);
				expect(await bypassed.text()).toBe("origin");
			}
			expect(cache.urls()).toHaveLength(1);
			const ordinary = await load(
				new Request(url, {
					headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
				}),
				render,
			);
			expect(ordinary.headers.get("x-edge-cache")).toBe("HIT");
			expect(await ordinary.text()).toBe("public document");
			expect(render).toHaveBeenCalledTimes(requests.length);
		},
	);

	it.each(["/", "/create"])(
		"accepts regular Next HTML and partitions cache variants on %s",
		async (path) => {
			const cache = memoryCache();
			const render = vi.fn(async () =>
				html("<html>anonymous document</html>", {
					"cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
					vary: "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Accept-Encoding",
				}),
			);
			const url = `https://ezimageai.com${path}`;
			const browsers = [
				new Request(`${url}?lang=fr`),
				new Request(`${url}?lang=de`),
				new Request(`${url}?lang=fr`, {
					headers: { cookie: "consent=true; consent_version=2; NEXT_LOCALE=es" },
				}),
				new Request(`${url}?lang=fr`, { headers: { cookie: "consent=false" } }),
				new Request(`${url}?lang=fr`, { headers: { "user-agent": "Googlebot/2.1" } }),
				new Request(`${url}?lang=fr`, { headers: { "user-agent": "bingbot/2.0" } }),
				new Request(`https://preview.example${path}?lang=fr`),
			];
			const load = async (request: Request) => {
				const ctx = context();
				const response = await serveAnonymousDocument(request, ctx.execution, cache, render);
				await response.text();
				await ctx.flush();
				return response.headers.get("x-edge-cache");
			};
			for (const request of browsers) expect(await load(request)).toBe("MISS");
			for (const request of browsers) expect(await load(request)).toBe("HIT");
			expect(render).toHaveBeenCalledTimes(browsers.length);
			expect(cache.urls()).toHaveLength(browsers.length);
		},
	);

	it.each(["/", "/create"])(
		"preserves unexpected responses without caching them on %s",
		async (path) => {
			const cache = memoryCache();
			const ctx = context();
			const load = (render: () => Promise<Response>, init?: RequestInit) =>
				serveAnonymousDocument(
					new Request(`https://ezimageai.com${path}`, init),
					ctx.execution,
					cache,
					render,
				);
			await load(async () => html("public document"));
			await ctx.flush();

			const unexpected: Record<string, string>[] = [
				{ "set-cookie": "cookie-issued=value" },
				{ "cache-control": "private, no-store" },
				{ "cdn-cache-control": "no-store" },
				{ "cloudflare-cdn-cache-control": "no-store" },
				{ "content-type": "text/x-component" },
				{ "x-robots-tag": "noindex, nofollow" },
				{ vary: "Cookie" },
				{ vary: "*" },
			];
			for (const extra of unexpected) {
				const reload = await load(async () => html("unexpected", extra), {
					headers: { "cache-control": "no-cache" },
				});
				expect(reload.headers.get("x-edge-cache")).toBeNull();
				expect(await reload.text()).toBe("unexpected");
			}
			const head = await load(async () => html("no HEAD body", unexpected[0]), {
				method: "HEAD",
				headers: { "cache-control": "no-cache" },
			});
			expect(head.headers.get("set-cookie")).toBe("cookie-issued=value");
			expect(head.headers.get("x-edge-cache")).toBeNull();
			expect(await head.text()).toBe("");
			await ctx.flush();
			const hit = await load(async () => html("rerender"));
			expect(hit.headers.get("x-edge-cache")).toBe("HIT");
			expect(await hit.text()).toBe("public document");
			expect(cache.urls()).toHaveLength(1);
		},
	);

	it("makes a timed-out Create document retry the same localized route", async () => {
		const cache = memoryCache();
		const ctx = context();
		let resolveRender!: (response: Response) => void;
		const render = () =>
			new Promise<Response>((resolve) => {
				resolveRender = resolve;
			});
		const request = new Request("https://ezimageai.com/create?lang=de");
		const timeout = await serveAnonymousDocument(request, ctx.execution, cache, render, {
			timeoutMs: 1,
		});
		expect(timeout.headers.get("x-edge-cache")).toBe("DEGRADED");
		expect(timeout.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		const body = await timeout.text();
		expect(body).toContain('<html lang="de">');
		expect(body).toContain('href="/create?lang=de">Erneut versuchen</a>');
		expect(body).toContain('href="/?lang=de">Editor öffnen</a>');
		resolveRender(html("private result", { "set-cookie": "cookie-issued=value" }));
		await ctx.flush();
		expect(cache.urls()).toHaveLength(0);
	});
});
