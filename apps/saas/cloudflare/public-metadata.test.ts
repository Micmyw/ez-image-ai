import { describe, expect, it, vi } from "vitest";

import { servePublicMetadata } from "./public-metadata";
import { prerenderedMetadata, publicIcons, webManifestPaths } from "./public-metadata-paths.mjs";

const origin = "https://public.example.test";
const session = "__Secure-better-auth.session_token=historical";
const request = (path: string, init?: RequestInit) => new Request(origin + path, init);

describe("website metadata requests after origin validation", () => {
	it("keeps conditional responses bodyless and preserves validators when securing them", async () => {
		const conditional = new Response(null, { status: 304, headers: { etag: '"current"' } });
		const fetch = vi.fn(async () => conditional);
		const head = request("/sitemap.xml?v=current", {
			method: "HEAD",
			headers: { "if-none-match": '"current"' },
		});
		const response = await servePublicMetadata(head, { fetch });
		expect(response?.status).toBe(304);
		expect(response?.headers.get("etag")).toBe('"current"');
		expect(response?.headers.get("x-frame-options")).toBe("DENY");
		expect(response?.body).toBeNull();
		expect(fetch).toHaveBeenCalledExactlyOnceWith(head);
	});

	it("secures the original data stream without buffering it or losing asset headers", async () => {
		const asset = new Response("original stream", {
			headers: [
				["content-type", "image/x-icon"],
				["vary", "Accept-Encoding"],
				["set-cookie", "first=one; Secure"],
				["set-cookie", "second=two; Secure"],
			],
		});
		const response = await servePublicMetadata(request("/favicon.ico"), {
			fetch: async () => asset,
		});
		expect(response?.body).toBe(asset.body);
		expect(asset.bodyUsed).toBe(false);
		expect(response?.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(response?.headers.get("vary")).toMatch(/^Accept-Encoding, Cookie/);
		expect(response?.headers.getSetCookie()).toEqual(["first=one; Secure", "second=two; Secure"]);
		expect(await response?.text()).toBe("original stream");
	});

	it("leaves unexpected HTML to the existing document path", async () => {
		const html = new Response("<!doctype html><title>Document</title>", {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
		expect(await servePublicMetadata(request("/icon.png"), { fetch: async () => html })).toBeNull();
		expect(html.bodyUsed).toBe(true);
	});

	it("leaves staged metadata on the Next route if the binding or exact asset is unavailable", async () => {
		for (const path of Object.keys(prerenderedMetadata)) {
			const read = request(path);
			expect(await servePublicMetadata(read)).toBeNull();
			const miss = new Response("missing", { status: 404 });
			expect(await servePublicMetadata(read, { fetch: async () => miss })).toBeNull();
			expect(miss.bodyUsed).toBe(true);
		}
	});

	it("fetches brand icon bytes without serving their aliases as physical Next assets", async () => {
		const fetch = vi.fn(
			async (_request: Request) => new Response("icon", { headers: { etag: '"version"' } }),
		);
		const icon = request("/favicon.ico?v=1", {
			headers: {
				cookie: session,
				accept: "image/*,*/*;q=0.8",
				"sec-fetch-dest": "image",
				"if-none-match": '"old-version"',
			},
		});
		const response = await servePublicMetadata(icon, { fetch });
		expect(response?.headers.get("etag")).toBe('"version"');
		expect(response?.headers.get("vary")).toMatch(/Cookie.*Accept.*Sec-Fetch-Dest/);
		expect(await response?.text()).toBe("icon");
		const [[assetRequest]] = fetch.mock.calls;
		expect(assetRequest.url).toBe(origin + publicIcons["/favicon.ico"] + "?v=1");
		expect(assetRequest.headers.get("if-none-match")).toBe('"old-version"');
	});

	it.each([...Object.keys(publicIcons), ...webManifestPaths])(
		"preserves document and App Router navigation for historical %s organization slugs",
		(path) => {
			const fetch = vi.fn();
			const navigationHeaders: Array<Record<string, string>> = [
				{ "sec-fetch-mode": "navigate" },
				{ "sec-fetch-dest": "document" },
				{ accept: "text/html,application/xhtml+xml" },
				{ rsc: "1" },
				{ "next-router-state-tree": "present" },
				{ "next-router-prefetch": "1" },
				{ "next-router-segment-prefetch": "/_tree" },
				{ "next-url": "/" },
				{ accept: "text/x-component" },
			];
			for (const headers of navigationHeaders) {
				expect(
					servePublicMetadata(request(path, { headers: { ...headers, cookie: session } }), {
						fetch,
					}),
				).toBeNull();
			}
			expect(
				servePublicMetadata(request(path + "?_rsc=1", { headers: { cookie: session } }), { fetch }),
			).toBeNull();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("lets a manifest asset take precedence when available", async () => {
		const file = { name: "EzPic", icons: [] };
		const fetch = vi.fn(async () => Response.json(file));
		const read = request("/site.webmanifest", { headers: { "sec-fetch-dest": "manifest" } });
		const response = await servePublicMetadata(read, { fetch });
		expect(fetch).toHaveBeenCalledExactlyOnceWith(read);
		expect(await response?.json()).toEqual(file);
	});

	it("returns real, lightweight 404s only for the currently absent exact paths", async () => {
		for (const path of [...webManifestPaths, "/manager/html", "/wp-admin/install.php"]) {
			for (const method of ["GET", "HEAD"]) {
				const read = request(path + "?probe=1", { method });
				const response = await servePublicMetadata(read, {
					fetch: async () => new Response(null, { status: 404 }),
				});
				expect(response?.status).toBe(404);
				expect(response?.headers.get("location")).toBeNull();
				expect(response?.headers.get("cache-control")).toBe("no-store");
				expect(response?.headers.get("x-frame-options")).toBe("DENY");
				expect(await response?.text()).toBe(method === "GET" ? "Not found" : "");
			}
		}
		for (const path of [
			"/legacy.team",
			"/new-metadata.json",
			"/docs/missing-article",
			"/manager/another-path",
			"/wp-admin/install.php/another-path",
		]) {
			expect(servePublicMetadata(request(path))).toBeNull();
		}
		expect(servePublicMetadata(request("/robots.txt", { method: "POST" }))).toBeNull();
	});

	it("keeps trailing-slash redirects canonical and preserves queries", async () => {
		const fetch = vi.fn();
		const response = await servePublicMetadata(request("/sitemap.xml/?v=1"), { fetch });
		expect(response?.status).toBe(308);
		expect(response?.headers.get("location")).toBe("/sitemap.xml?v=1");
		expect(response?.headers.get("strict-transport-security")).toContain("max-age=63072000");
		expect(fetch).not.toHaveBeenCalled();
	});
});
