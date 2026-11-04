import { describe, expect, it } from "vitest";

import {
	homepageCachePolicy,
	publicHealthResponse,
	serveAnonymousHomepage,
	type EdgeCache,
} from "./public-edge";
import type { WorkerExecutionContext } from "./request-scope";

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

	it("caches an anonymous homepage and serves it without rendering again", async () => {
		const cache = memoryCache();
		let renders = 0;
		const render = async () => {
			renders += 1;
			return html(`<html>render-${renders}</html>`);
		};
		let now = 1_000_000;
		const ctx = context();
		const first = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/"),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(first.headers.get("x-edge-cache")).toBe("MISS");
		expect(first.headers.get("cache-control")).toBe("private, no-store");
		expect(first.headers.get("x-edge-cache-control")).toBe(
			`public, s-maxage=${homepageCachePolicy.freshSeconds}, stale-while-revalidate=${homepageCachePolicy.staleWhileRevalidateSeconds}`,
		);
		expect(await first.text()).toContain("render-1");
		await ctx.flush();

		const second = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/?lang=en"),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(second.headers.get("x-edge-cache")).toBe("HIT");
		expect(await second.text()).toContain("render-1");
		expect(renders).toBe(1);

		const head = await serveAnonymousHomepage(
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

	it("refreshes a stale anonymous homepage in the background", async () => {
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
		await serveAnonymousHomepage(
			new Request("https://ezimageai.com/?lang=de"),
			ctx.execution,
			cache,
			render,
			{
				clock: () => now,
			},
		);
		await ctx.flush();
		now += 120_000;
		const stale = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/?lang=de"),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(stale.headers.get("x-edge-cache")).toBe("STALE");
		expect(await stale.text()).toContain("render-1");
		expect(renders).toBe(2);
		releaseRefresh();
		await ctx.flush();
		expect(renders).toBe(2);
		const fresh = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/?lang=de"),
			ctx.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(fresh.headers.get("x-edge-cache")).toBe("HIT");
		expect(await fresh.text()).toContain("render-2");
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
			new Request("https://ezimageai.com/?utm=campaign"),
			new Request("https://ezimageai.com/", { headers: { rsc: "1" } }),
			new Request("https://ezimageai.com/create"),
		];
		for (const request of requests) {
			const response = await serveAnonymousHomepage(request, ctx.execution, cache, render);
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
		const accepted = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/", {
				headers: { cookie: "consent=true; consent_version=2" },
			}),
			ctx.execution,
			cache,
			render,
		);
		const declined = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/", { headers: { cookie: "consent=false" } }),
			ctx.execution,
			cache,
			render,
		);
		expect(await accepted.text()).toContain("consent=true");
		expect(await declined.text()).toContain("consent=false");
		await ctx.flush();
		expect(cache.urls()).toHaveLength(2);

		const issued = await serveAnonymousHomepage(
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

	it("propagates an anonymous homepage failure instead of serving the fallback", async () => {
		const ctx = context();
		await expect(
			serveAnonymousHomepage(
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
		const response = await serveAnonymousHomepage(
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
		const hit = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/?lang=fr"),
			ctx.execution,
			cache,
			render,
			{ clock: () => 50_000 },
		);
		expect(hit.headers.get("x-edge-cache")).toBe("HIT");
		expect(await hit.text()).toContain("late-home");
	});

	it("serves a 50-minute-old anonymous copy immediately while refreshing it", async () => {
		expect(homepageCachePolicy.staleWhileRevalidateSeconds).toBe(3_600);
		const cache = memoryCache();
		let renders = 0;
		const render = async () => {
			renders += 1;
			return html(`<html>render-${renders}</html>`);
		};
		let now = 5_000_000;
		const ctx = context();
		await serveAnonymousHomepage(
			new Request("https://ezimageai.com/"),
			ctx.execution,
			cache,
			render,
			{
				clock: () => now,
			},
		);
		await ctx.flush();
		now += 50 * 60_000;
		const later = context();
		const stale = await serveAnonymousHomepage(
			new Request("https://ezimageai.com/"),
			later.execution,
			cache,
			render,
			{ clock: () => now },
		);
		expect(stale.headers.get("x-edge-cache")).toBe("STALE");
		expect(await stale.text()).toContain("render-1");
		await later.flush();
		expect(renders).toBe(2);
	});
});
