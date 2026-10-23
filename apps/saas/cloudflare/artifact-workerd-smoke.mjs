import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const app = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(app, "dist/worker");
const assets = path.join(app, ".open-next/assets");
const origin = "https://website-artifact-smoke.invalid";
const callbackSecret = "artifact-callback-only-secret-00000000";
const seeapiKey = "whsec_artifact_callback_only_signing_key";
const wranglerRequire = createRequire(
	realpathSync(path.join(app, "node_modules/wrangler/package.json")),
);
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
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
assert.match(source, /wasm-compiler-edge/);
assert(!source.includes("/runtime/client.mjs"), "Node Prisma runtime leaked into the Worker");
assert(!source.includes("/sharp/lib/"), "Native Sharp leaked into the Worker");
assert(!source.includes("/remote-media-node.ts"), "Node media transport leaked into the Worker");
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
			CANONICAL_ORIGIN: "https://website-artifact-smoke.invalid",
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

async function request(endpoint, { headers, status = 200, method, body: requestBody } = {}) {
	const response = await runtime.dispatchFetch(`${origin}${endpoint}`, {
		headers,
		method,
		body: requestBody,
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	const body = await response.text();
	assert.equal(response.status, status, `${endpoint}: ${body.slice(0, 300)}`);
	return { response, body };
}

try {
	await runtime.ready;
	// Locale cookies are deliberately present, but no authentication cookie is sent.
	// These anonymous routes return before any account/organization/database queries.
	const publicHeaders = { cookie: "NEXT_LOCALE=fr" };
	const [health, login, asset, home, create, video] = await Promise.all([
		request("/api/health"),
		request("/login"),
		request(`/_next/static/${staticFile.replaceAll(path.sep, "/")}`),
		request("/", { headers: publicHeaders }),
		request("/create?lang=es", { headers: publicHeaders }),
		request("/video", { status: 307 }),
	]);
	assert.deepEqual(JSON.parse(health.body), { status: "alive" });
	assert.match(login.response.headers.get("content-type"), /text\/html/);
	assert.match(login.response.headers.get("cache-control"), /private.*no-store/);
	assert.match(asset.response.headers.get("cache-control"), /immutable/);
	// Unlike /login and /api/health, these paths exercise OpenNext's compiled
	// Node proxy adapter and its request-header forwarding into next-intl.
	assert.match(home.body, /<html\b[^>]*\blang="en"/);
	assert.match(create.body, /<html\b[^>]*\blang="es"/);
	for (const [endpoint, page] of Object.entries({ "/": home, "/create?lang=es": create })) {
		assert.match(page.response.headers.get("content-type"), /text\/html/);
		assert.equal(page.response.headers.get("x-robots-tag"), null, endpoint);
		assert.match(
			page.body,
			/<meta\b(?=[^>]*\bname="robots")(?=[^>]*\bcontent="index,\s*follow")[^>]*>/,
			`${endpoint}: public indexing metadata`,
		);
	}
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
			anonymousVideoLoginRedirect: true,
			privateVideoNoindex: true,
			externalHttpRequests: blockedOutboundOrigins.length,
			inlineThemeInitialization: true,
			staticAssetCaching: true,
			concurrentLocalPostgresQueries: checkDatabase,
			imageCallbackSignatureRejection: true,
			imageCallbackUnknownIdentityPostgresChecks: checkDatabase,
			liveCloudflareVerified: false,
		}) + "\n",
	);
} finally {
	await runtime.dispose();
	process.stdout.write("Website artifact workerd runtime disposed\n");
}
