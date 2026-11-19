import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { text as readBodyText } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { assertCompactWorker } from "./compact-worker.mjs";
import { prerenderedMetadata, publicIcons, webManifestPaths } from "./public-metadata-paths.mjs";
import { openWorkerMemoryProbe } from "./worker-memory.mjs";

const app = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(app, "dist/worker");
const assets = path.join(app, ".open-next/assets");
const origin = "https://website-artifact-smoke.invalid";
const paymentOrigin = "https://website-artifact-smoke.account.workers.dev";
const callbackSecret = "artifact-callback-only-secret-00000000";
const seeapiKey = "whsec_artifact_callback_only_signing_key";
const wranglerRequire = createRequire(
	realpathSync(path.join(app, "node_modules/wrangler/package.json")),
);
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const configuration = JSON.parse(await readFile(path.join(app, "wrangler.jsonc"), "utf8"));
const checkDatabase = process.argv.includes("--database");
const connectionString = process.env.TEST_DATABASE_URL;
if (checkDatabase) {
	const database = new URL(connectionString ?? "");
	assert(["postgres:", "postgresql:"].includes(database.protocol));
	assert(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
	assert.equal(database.port, "55432", "Use the disposable integration PostgreSQL port");
	assert.match(database.pathname, /test|testing/i);
}

// Execute Wrangler's final output so this catches conditional export and WASM
// errors that source-transform tests and a build-only dry-run cannot detect.
const source = await readFile(path.join(output, "cloudflare-worker.js"), "utf8");
assertCompactWorker(source);
// Minification removes source-path comments, and upstream source maps can name
// original TypeScript files. Check esbuild's actual included inputs instead.
const metadata = JSON.parse(await readFile(path.join(output, "bundle-meta.json"), "utf8"));
const bundledSources = Object.values(metadata.outputs).flatMap((entry) =>
	Object.entries(entry.inputs ?? {})
		.filter(([, details]) => details.bytesInOutput > 0)
		.map(([file]) => file.replaceAll("\\", "/")),
);
assert(bundledSources.some((file) => file.endsWith("/runtime/wasm-compiler-edge.mjs")));
for (const forbidden of ["/runtime/client.mjs", "/sharp/lib/", "/remote-media-node.ts"])
	assert(
		!bundledSources.some((file) => file.includes(forbidden)),
		`Forbidden Worker source: ${forbidden}`,
	);
assert(!source.includes("/runtime/client.mjs"), "Node Prisma runtime leaked into the Worker");
assert(!source.includes("/sharp/lib/"), "Native Sharp leaked into the Worker");
assert(!source.includes("/remote-media-node.ts"), "Node media transport leaked into the Worker");
const routeManifest = JSON.parse(
	await readFile(path.join(app, ".next/server/app-paths-manifest.json"), "utf8"),
);
assert(!Object.keys(routeManifest).some((route) => route.includes("/chatbot/")));
assert(!source.includes("This is an example chatbot built with the OpenAI API"));
const files = await readdir(output);
assert(files.some((file) => file.endsWith("query_compiler_fast_bg.wasm")));
const staticFile = (await readdir(path.join(assets, "_next/static"), { recursive: true })).find(
	(file) => file.endsWith(".js"),
);
assert(staticFile, "Expected a built Next.js static asset");
const blockedOutboundOrigins = [];
const runtime = new Miniflare(
	convertV4MiniflareOptions({
		host: "127.0.0.1",
		port: 0,
		inspectorPort: 0,
		name: "website-artifact-smoke",
		compatibilityDate: "2026-09-10",
		compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
		modulesRoot: output,
		modules: [
			{ type: "ESModule", path: path.join(output, "cloudflare-worker.js") },
			...files
				.filter((file) => file.endsWith(".wasm"))
				.map((file) => ({ type: "CompiledWasm", path: path.join(output, file) })),
			...files
				.filter((file) => file.endsWith(".bin"))
				.map((file) => ({ type: "Data", path: path.join(output, file) })),
		],
		assets: {
			directory: assets,
			binding: "ASSETS",
			routerConfig: { has_user_worker: true },
			run_worker_first: configuration.assets.run_worker_first,
		},
		images: { binding: "IMAGES" },
		r2Buckets: ["NEXT_INC_CACHE_R2_BUCKET"],
		durableObjects: {
			NEXT_CACHE_DO_QUEUE: { className: "DOQueueHandler", useSQLite: true },
			NEXT_TAG_CACHE_DO_SHARDED: { className: "DOShardedTagCache", useSQLite: true },
		},
		serviceBindings: { WORKER_SELF_REFERENCE: "website-artifact-smoke" },
		outboundService: (request) => {
			blockedOutboundOrigins.push(new URL(request.url).origin);
			return new Response("Outbound HTTP is disabled for artifact smoke", { status: 502 });
		},
		hyperdrives: {
			HYPERDRIVE: checkDatabase ? connectionString : "postgresql://build:build@127.0.0.1:1/build",
		},
		// Deliberately omit DATABASE_URL: deployed Workers only receive Hyperdrive.
		bindings: {
			CANONICAL_ORIGIN: origin,
			PAYMENT_WEBHOOK_INGRESS_ORIGIN: paymentOrigin,
			WEBSITE_VERSION: { id: "artifact-smoke-version" },
			EZPIC_RUNTIME: "workers",
			EZPIC_DATABASE_BINDING: "hyperdrive",
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "artifact-smoke-only-32-character-secret",
			NEXT_PUBLIC_SAAS_URL: "https://website-artifact-smoke.invalid",
			RESEND_API_KEY: "re_artifact_smoke_only_placeholder",
			MEDIA_PROVIDER_ADAPTER: "kie",
			MEDIA_SAFETY_ADAPTER: "configured",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
			MEDIA_GENERATION_ENABLED: "false",
			MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
			WORKFLOWS_DISPATCH_SECRET: callbackSecret,
			SEEAPI_WEBHOOK_SIGNING_KEYS: JSON.stringify({ whkey_artifact: seeapiKey }),
		},
	}),
);

function artifactFetch(endpoint, { headers, method, body, base = origin } = {}) {
	return runtime.dispatchFetch(`${base}${endpoint}`, {
		headers,
		method,
		body,
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
}

async function request(endpoint, { status = 200, ...options } = {}) {
	const response = await artifactFetch(endpoint, options);
	const body = await response.text();
	assert.equal(response.status, status, `${endpoint}: ${body.slice(0, 300)}`);
	return { response, body };
}

async function requestDocument(endpoint, { headers, method = "GET" } = {}) {
	const url = new URL(endpoint, await runtime.ready);
	const canonical = new URL(endpoint, origin);
	// Miniflare dispatchFetch uses Undici, which replaces Sec-Fetch-Mode with cors.
	const message = await new Promise((resolve, reject) => {
		httpGet(
			url,
			{
				method,
				headers: {
					accept: "text/html",
					"sec-fetch-mode": "navigate",
					"sec-fetch-dest": "document",
					...headers,
					host: canonical.host,
					"MF-Original-URL": canonical.href,
				},
				signal: AbortSignal.timeout(30_000),
			},
			resolve,
		).once("error", reject);
	});
	const body = await readBodyText(message);
	assert.equal(message.statusCode, 200, `${endpoint}: ${body.slice(0, 300)}`);
	return { response: { headers: new Headers(message.headers) }, body };
}

async function requestWithEdgeCacheHit(endpoint, headers) {
	let page = await requestDocument(endpoint, { headers });
	// Consuming the response body can finish before the waitUntil cache write.
	for (const milliseconds of [25, 50, 100, 200]) {
		if (page.response.headers.get("x-edge-cache") !== "MISS") break;
		await delay(milliseconds);
		page = await requestDocument(endpoint, { headers });
	}
	assert.equal(page.response.headers.get("x-edge-cache"), "HIT", endpoint);
	return page;
}

async function verifyAnonymousDocumentCache(headers) {
	const home = await requestWithEdgeCacheHit("/", headers);
	const cold = await requestDocument("/create", { headers });
	assert.equal(cold.response.headers.get("x-edge-cache"), "MISS", "/create cold document");
	const warm = await requestWithEdgeCacheHit("/create", headers);
	assert(warm.body === cold.body, "Cached /create must return the original document");
	const head = await requestDocument("/create", { headers, method: "HEAD" });
	assert.equal(head.response.headers.get("x-edge-cache"), "HIT", "/create HEAD");
	assert.equal(head.body, "", "/create HEAD");
	for (const { response } of [home, cold, warm, head]) {
		assert.match(response.headers.get("content-type") ?? "", /text\/html/);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(response.headers.get("cdn-cache-control"), "no-store");
		assert.equal(
			response.headers.get("x-edge-cache-control"),
			"public, s-maxage=86400, stale-while-revalidate=3600",
		);
		assert.equal(response.headers.get("set-cookie"), null);
		assert.equal(response.headers.get("x-robots-tag"), null);
	}
	for (const [endpoint, page] of Object.entries({ "/": home, "/create": warm })) {
		const canonical = page.body.match(
			/<link\b(?=[^>]*\brel="canonical")[^>]*\bhref="([^"]+)"/,
		)?.[1];
		assert(canonical, `${endpoint}: expected a canonical URL`);
		const { pathname, search } = new URL(canonical);
		assert.equal(pathname + search, endpoint, `${endpoint}: canonical path`);
		assert.match(page.body, /<section\b[^>]*\bid="image-editor"/, endpoint);
	}
	const homeSection = /<section\b[^>]*\bid="quick-start"/;
	assert.match(home.body, homeSection);
	assert.doesNotMatch(warm.body, homeSection);

	const homeTask = await requestDocument("/?job=artifact-private-image", { headers });
	assert.equal(homeTask.response.headers.get("x-robots-tag"), "noindex, nofollow");
	const task = await requestDocument("/create?videoJob=artifact-private-job", { headers });
	assert.equal(task.response.headers.get("x-robots-tag"), "noindex, nofollow");
	assert.match(
		task.body,
		/<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="noindex,\s*nofollow")[^>]*>/,
	);
	// An invalid signature exercises the session-cookie bypass without a database session.
	const sessionCookie = await requestDocument("/create", {
		headers: {
			...headers,
			cookie: `${headers.cookie}; __Secure-better-auth.session_token=artifact-invalid-session`,
		},
	});
	const programmatic = await requestDocument("/create", {
		headers: { ...headers, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" },
	});
	for (const [label, { response }] of Object.entries({
		"homepage private job": homeTask,
		"/create private job": task,
		"/create session cookie": sessionCookie,
		"/create programmatic request": programmatic,
	})) {
		assert.equal(response.headers.get("x-edge-cache"), null, label);
		assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/, label);
	}
	const afterBypasses = await requestDocument("/create", { headers });
	assert.equal(afterBypasses.response.headers.get("x-edge-cache"), "HIT");
	assert(
		afterBypasses.body === warm.body,
		"Private requests must preserve the cached public document",
	);
}

function assertDirectDataSecurity(response, endpoint) {
	const headers = response.headers;
	assert.match(headers.get("content-security-policy") ?? "", /default-src 'none'/, endpoint);
	assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, endpoint);
	assert.equal(headers.get("x-content-type-options"), "nosniff", endpoint);
	assert.equal(headers.get("x-frame-options"), "DENY", endpoint);
	assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin", endpoint);
	assert.equal(
		headers.get("permissions-policy"),
		"camera=(), microphone=(), geolocation=(), payment=()",
		endpoint,
	);
	assert.equal(
		headers.get("strict-transport-security"),
		"max-age=63072000; includeSubDomains; preload",
		endpoint,
	);
}

async function verifyPublicMetadata() {
	const bodies = {};
	for (const [endpoint, contentType] of Object.entries(prerenderedMetadata)) {
		const expected = await readFile(path.join(app, `.next/server/app${endpoint}.body`));
		const served = await artifactFetch(endpoint + "?v=artifact");
		assert.equal(served.status, 200, endpoint);
		assert.equal(served.headers.get("content-type"), contentType, endpoint);
		assert.equal(
			served.headers.get("cache-control"),
			"public, max-age=0, must-revalidate",
			endpoint,
		);
		assertDirectDataSecurity(served, endpoint);
		const etag = served.headers.get("etag");
		assert(etag, `${endpoint}: expected an asset ETag`);
		bodies[endpoint] = Buffer.from(await served.arrayBuffer());
		assert.deepEqual(bodies[endpoint], expected, endpoint);

		const head = await request(endpoint, { method: "HEAD" });
		assert.equal(head.body, "", endpoint);
		assert.equal(head.response.headers.get("etag"), etag, endpoint);
		assert.equal(head.response.headers.get("content-type"), contentType, endpoint);
		assertDirectDataSecurity(head.response, endpoint);
		const conditional = await request(endpoint, {
			headers: { "if-none-match": etag },
			status: 304,
		});
		assert.equal(conditional.body, "", endpoint);
		assert.equal(conditional.response.headers.get("etag"), etag, endpoint);
		assertDirectDataSecurity(conditional.response, endpoint);
	}

	const robots = bodies["/robots.txt"].toString("utf8");
	const maps = [...robots.matchAll(/^Sitemap: (\S+)$/gm)].map((match) => new URL(match[1]));
	assert.deepEqual(
		maps.map((url) => url.pathname),
		["/sitemap.xml", "/sitemap-images.xml"],
	);
	const builtOrigins = new Set(maps.map((url) => url.origin));
	assert.equal(builtOrigins.size, 1);
	for (const endpoint of ["/sitemap.xml", "/sitemap-images.xml"]) {
		const xml = bodies[endpoint].toString("utf8");
		assert.match(xml, /<urlset\b/);
		assert.match(xml, /<loc>https?:\/\/[^<]+<\/loc>/);
		for (const [, url] of xml.matchAll(/<(?:image:)?loc>([^<]+)<\/(?:image:)?loc>/g))
			assert(builtOrigins.has(new URL(url).origin), endpoint);
	}
	assert.match(bodies["/sitemap.xml"].toString("utf8"), /hreflang="x-default"/);
	assert.match(bodies["/sitemap.xml"].toString("utf8"), /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
	assert.match(
		bodies["/sitemap-images.xml"].toString("utf8"),
		/<image:loc>[^<]+\/images\/landing\/variants\//,
	);
	assert.deepEqual(bodies["/icon.png"], await readFile(path.join(app, "app/icon.png")));

	const fileRequests = {
		"/favicon.ico": { type: "image/x-icon", dest: "image" },
		"/apple-touch-icon.png": { type: "image/png", dest: "image" },
	};
	for (const [endpoint, { type, dest }] of Object.entries(fileRequests)) {
		const headers = {
			"sec-fetch-dest": dest,
			accept: "image/*,*/*;q=0.8",
			cookie: "__Secure-better-auth.session_token=artifact-session-cookie",
		};
		const response = await artifactFetch(endpoint, { headers });
		assert.equal(response.status, 200, endpoint);
		assert.equal(response.headers.get("content-type"), type, endpoint);
		assertDirectDataSecurity(response, endpoint);
		const body = Buffer.from(await response.arrayBuffer());
		assert.deepEqual(body, await readFile(path.join(assets, publicIcons[endpoint].slice(1))));
		if (endpoint === "/favicon.ico") {
			assert.deepEqual(body.subarray(0, 4), Buffer.from([0, 0, 1, 0]));
			assert.equal(body.readUInt16LE(4), 3);
		} else {
			assert.deepEqual(body.subarray(0, 8), Buffer.from("89504e470d0a1a0a", "hex"));
			assert.equal(body.readUInt32BE(16), 180);
			assert.equal(body.readUInt32BE(20), 180);
		}
		const head = await request(endpoint, { method: "HEAD" });
		assert.equal(head.body, "", endpoint);
		assert.equal(head.response.headers.get("etag"), response.headers.get("etag"), endpoint);
		assertDirectDataSecurity(head.response, endpoint);
		const conditional = await request(endpoint, {
			headers: { "if-none-match": response.headers.get("etag") },
			status: 304,
		});
		assert.equal(conditional.body, "", endpoint);
		assertDirectDataSecurity(conditional.response, endpoint);
	}

	for (const endpoint of [...webManifestPaths, "/manager/html", "/wp-admin/install.php"]) {
		for (const method of ["GET", "HEAD"]) {
			const missing = await request(endpoint + "?v=artifact", { method, status: 404 });
			assert.equal(missing.response.headers.get("location"), null, endpoint);
			assert.equal(
				missing.response.headers.get("content-type"),
				"text/plain; charset=utf-8",
				endpoint,
			);
			assert.equal(missing.body, method === "GET" ? "Not found" : "", endpoint);
			assertDirectDataSecurity(missing.response, endpoint);
		}
	}

	for (const endpoint of [
		...Object.keys(prerenderedMetadata),
		...Object.keys(publicIcons),
		...webManifestPaths,
	]) {
		const { response: slash } = await request(endpoint + "/?v=artifact", { status: 308 });
		assert.equal(
			new URL(slash.headers.get("location"), origin).href,
			origin + endpoint + "?v=artifact",
		);
		assertDirectDataSecurity(slash, endpoint);
		const { response: redirected } = await request(endpoint + "?v=artifact", {
			base: origin.replace("https:", "http:"),
			status: 308,
		});
		assert.equal(redirected.headers.get("location"), origin + endpoint + "?v=artifact");
		await request(endpoint, { base: paymentOrigin, status: 421 });
	}

	const webhook = await request("/api/webhooks/payments", {
		base: paymentOrigin,
		method: "POST",
		headers: { "stripe-signature": "t=0,v1=artifact-invalid-signature" },
		body: "{}",
		status: 400,
	});
	assert.equal(webhook.body, "Invalid request.");
	const ordinary404 = await request("/missing-public-page/nested", { status: 404 });
	assert.match(ordinary404.response.headers.get("content-type"), /text\/html/);
	assert.match(ordinary404.body, /noindex/);
	const organization = await request("/example.team", { status: 307 });
	assert.equal(
		new URL(organization.response.headers.get("location"), origin).href,
		origin + "/login",
	);
}

async function verifyAnalyticsPolicy() {
	const path = "/api/analytics/policy";
	for (const [headers, policy] of [
		[{ "cf-ipcountry": "US" }, [false, false, true]],
		[{ "cf-ipcountry": "DE" }, [true, false, false]],
		[{}, [true, false, false]],
		[{ "cf-ipcountry": "DE", cookie: "consent=true; consent_version=2" }, [true, false, true]],
		[{ "cf-ipcountry": "DE", cookie: "consent=true; consent_version=1" }, [true, false, false]],
		[{ "cf-ipcountry": "US", cookie: "consent=false" }, [false, false, false]],
		[{ "cf-ipcountry": "US", "sec-gpc": "1" }, [false, true, false]],
		[{ "cf-ipcountry": "US", dnt: "1" }, [false, true, false]],
	]) {
		const [requiresOptIn, privacySignal, analyticsAllowed] = policy;
		const edge = await request(path, { headers });
		const legacy = await request(path + "?contract=legacy", { headers });
		assert.deepEqual(JSON.parse(edge.body), { requiresOptIn, privacySignal, analyticsAllowed });
		assert.deepEqual(JSON.parse(edge.body), JSON.parse(legacy.body));
		assertDirectDataSecurity(edge.response, path);
		for (const { response } of [edge, legacy]) {
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.equal(response.headers.get("set-cookie"), null);
			for (const key of [
				"cookie",
				"cf-ipcountry",
				"x-vercel-ip-country",
				"sec-gpc",
				"dnt",
				"origin",
			])
				assert(response.headers.get("vary")?.toLowerCase().split(/,\s*/).includes(key));
		}
	}
	const sameOrigin = await request(path, { headers: { origin } });
	assert.equal(sameOrigin.response.headers.get("access-control-allow-origin"), origin);
	assert.equal(sameOrigin.response.headers.get("access-control-expose-headers"), "Content-Length");
	assert.equal(sameOrigin.response.headers.get("access-control-allow-credentials"), null);
	const foreignOrigin = await request(path, {
		headers: { origin: "https://foreign.example.test" },
	});
	assert.equal(foreignOrigin.response.headers.get("access-control-allow-origin"), null);
	await request(path, { method: "HEAD", status: 404 });
	await request(path, { method: "OPTIONS", status: 204 });
}

let memoryProbe;
try {
	await runtime.ready;
	memoryProbe = await openWorkerMemoryProbe(runtime, "website-artifact-smoke");
	await memoryProbe.measure("website.loaded", 64);
	// Locale cookies are deliberately present, but no authentication cookie is sent.
	// These anonymous routes return before any account/organization/database queries.
	const publicHeaders = { cookie: "NEXT_LOCALE=fr" };
	const [health, edgeHealth, login, asset, home, create, video] = await Promise.all([
		request("/api/health"),
		request("/health", { headers: publicHeaders }),
		request("/login"),
		request(`/_next/static/${staticFile.replaceAll(path.sep, "/")}`),
		requestDocument("/", { headers: publicHeaders }),
		requestDocument("/create?lang=es", { headers: publicHeaders }),
		request("/video", { status: 307 }),
	]);
	assert.deepEqual(JSON.parse(health.body), { status: "alive" });
	assert.deepEqual(JSON.parse(edgeHealth.body), { status: "alive" });
	assert.equal(edgeHealth.response.headers.get("location"), null);
	assert.equal(edgeHealth.response.headers.get("cache-control"), "no-store");
	const localeHealth = await request("/de/health", { method: "HEAD" });
	assert.equal(localeHealth.response.headers.get("location"), null);
	assert.equal(localeHealth.body, "");
	assert.match(home.response.headers.get("x-edge-cache") ?? "", /HIT|MISS|STALE/);
	assert.equal(home.response.headers.get("cache-control"), "private, no-store");
	assert.match(login.response.headers.get("content-type"), /text\/html/);
	assert.match(login.response.headers.get("cache-control"), /private.*no-store/);
	assert.equal(login.response.headers.get("x-edge-cache"), null, "/login");
	assert.match(asset.response.headers.get("cache-control"), /immutable/);
	// Unlike /login and /api/health, these paths exercise OpenNext's compiled
	// Node proxy adapter and its request-header forwarding into next-intl.
	assert.match(home.body, /<html\b[^>]*\blang="en"/);
	assert.match(create.body, /<html\b[^>]*\blang="es"/);
	for (const [endpoint, page] of Object.entries({ "/": home, "/create?lang=es": create })) {
		assert.match(page.response.headers.get("content-type"), /text\/html/);
		assert.match(page.response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
		assert.equal(page.response.headers.get("x-robots-tag"), null, endpoint);
		assert.match(
			page.body,
			/<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="index,\s*follow")[^>]*>/,
			`${endpoint}: public indexing metadata`,
		);
	}
	await verifyAnonymousDocumentCache(publicHeaders);
	// Inspect the original response: following redirects could hide a lost auth
	// boundary or the private route's proxy headers behind a successful login page.
	const videoLocation = video.response.headers.get("location");
	assert(videoLocation, "Anonymous /video must redirect to login");
	assert.equal(new URL(videoLocation, origin).href, `${origin}/login`);
	assert.equal(video.response.headers.get("x-robots-tag"), "noindex, nofollow");
	// next-themes serializes a server function into browser JavaScript. Execute
	// the actual rendered script to catch bundler helpers escaping that function.
	const themeScript = [...login.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
		.map((match) => match[1])
		.find((script) => script.includes("localStorage.getItem") && script.includes("colorScheme"));
	assert(themeScript, "Expected the inline theme initializer");
	const classes = new Set(["light"]);
	const style = { colorScheme: "light" };
	runInNewContext(
		themeScript,
		{
			document: {
				documentElement: {
					classList: {
						remove: (...values) => values.forEach((value) => classes.delete(value)),
						add: (...values) => values.forEach((value) => classes.add(value)),
					},
					style,
				},
			},
			localStorage: { getItem: () => "dark" },
			window: { matchMedia: () => ({ matches: false }) },
		},
		{ timeout: 1000 },
	);
	assert.deepEqual([...classes], ["dark"]);
	assert.equal(style.colorScheme, "dark");
	// Exercise the real outer Worker callback route, signatures and conditional
	// database imports; these probes never submit generation or moderation work.
	for (const endpoint of ["/api/webhooks/ai/kie", "/api/webhooks/moderation/seeapi-image"]) {
		const rejected = await request(endpoint, { method: "POST", body: "{}", status: 401 });
		assert.equal(JSON.parse(rejected.body).code, "WEBHOOK_VERIFICATION_FAILED");
		assert.equal(rejected.response.headers.get("cache-control"), "no-store");
	}
	for (const endpoint of ["/api/ai/stream", "/api/rpc/ai/stream"])
		await request(endpoint, { method: "POST", body: "{}", status: 404 });
	await memoryProbe.measure("website.public-retained", 112, { retained: true });
	await verifyPublicMetadata();
	await verifyAnalyticsPolicy();
	if (checkDatabase) {
		// The public catalog queries runtimeConfigOverride through the Next server
		// bundle. Concurrent requests also exercise the outer database context.
		const catalogs = await Promise.all(
			Array.from({ length: 3 }, () => request("/api/media/catalog")),
		);
		for (const result of catalogs) assert(Array.isArray(JSON.parse(result.body).products));
		const missingAttempt = "artifact-smoke-missing-attempt";
		const kie = new URL("/api/webhooks/ai/kie", origin);
		kie.searchParams.set("attempt", missingAttempt);
		kie.searchParams.set(
			"token",
			createHmac("sha256", callbackSecret)
				.update(`kie-completion:v1:${missingAttempt}`)
				.digest("base64url"),
		);
		const missingAsset = "artifact-smoke-missing-asset";
		const submission = "artifact-smoke-missing-submission";
		const seeapi = new URL("/api/webhooks/moderation/seeapi-image", origin);
		seeapi.searchParams.set("asset", missingAsset);
		seeapi.searchParams.set("generation", "1");
		seeapi.searchParams.set("submission", submission);
		seeapi.searchParams.set(
			"token",
			createHmac("sha256", callbackSecret)
				.update(JSON.stringify(["ezpic:image-moderation-callback:v1", missingAsset, 1, submission]))
				.digest("base64url"),
		);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const rawBody = '{ "taskId": "ignored", "verdict": "ALLOW", "detail": "原始字节" }';
		const unknownCallbacks = await Promise.all([
			request(kie.pathname + kie.search, {
				method: "POST",
				status: 400,
				body: JSON.stringify({ data: { taskId: "artifact-missing-provider-task" } }),
			}),
			request(seeapi.pathname + seeapi.search, {
				method: "POST",
				status: 400,
				body: rawBody,
				headers: {
					"X-SEEAPI-Timestamp": timestamp,
					"X-SEEAPI-Signing-Key": "whkey_artifact",
					"X-SEEAPI-Signature": `v1=${createHmac("sha256", seeapiKey).update(`${timestamp}.${rawBody}`).digest("hex")}`,
				},
			}),
		]);
		for (const result of unknownCallbacks) {
			assert.equal(JSON.parse(result.body).code, "WEBHOOK_INVALID");
			assert.equal(result.response.headers.get("cache-control"), "no-store");
		}
	}
	assert.deepEqual(blockedOutboundOrigins, [], "Artifact probes must not request external HTTP");
	process.stdout.write(
		JSON.stringify({
			artifact: "dist/worker/cloudflare-worker.js",
			startedInWorkerd: true,
			liveness: true,
			dynamicLoginPage: true,
			publicProxyLocales: true,
			publicIndexingHeaders: true,
			anonymousCreateEdgeCache: true,
			anonymousVideoLoginRedirect: true,
			privateVideoNoindex: true,
			externalHttpRequests: blockedOutboundOrigins.length,
			inlineThemeInitialization: true,
			staticAssetCaching: true,
			publicMetadataAndOriginChecks: true,
			analyticsPolicyParity: true,
			concurrentLocalPostgresQueries: checkDatabase,
			imageCallbackSignatureRejection: true,
			localIsolateMemoryBudget: true,
			imageCallbackUnknownIdentityPostgresChecks: checkDatabase,
			liveCloudflareVerified: false,
		}) + "\n",
	);
} finally {
	memoryProbe?.close();
	await runtime.dispose();
	process.stdout.write("Website artifact workerd runtime disposed\n");
}
