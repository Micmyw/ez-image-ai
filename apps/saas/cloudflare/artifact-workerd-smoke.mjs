import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(app, "dist/worker");
const assets = path.join(app, ".open-next/assets");
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
			MEDIA_SAFETY_ADAPTER: "sightengine",
			MEDIA_ALLOW_TEST_SAFETY_ADAPTER: "false",
			MEDIA_GENERATION_ENABLED: "false",
			MEDIA_TRUSTED_PROXY_PROVIDER: "cloudflare",
		},
	}),
);

async function request(endpoint) {
	const response = await runtime.dispatchFetch(
		`https://website-artifact-smoke.invalid${endpoint}`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	const body = await response.text();
	assert.equal(response.status, 200, `${endpoint}: ${body.slice(0, 300)}`);
	return { response, body };
}

try {
	await runtime.ready;
	const [health, login, asset] = await Promise.all([
		request("/api/health"),
		request("/login"),
		request(`/_next/static/${staticFile.replaceAll(path.sep, "/")}`),
	]);
	assert.deepEqual(JSON.parse(health.body), { status: "alive" });
	assert.match(login.response.headers.get("content-type"), /text\/html/);
	assert.match(login.response.headers.get("cache-control"), /private.*no-store/);
	assert.match(asset.response.headers.get("cache-control"), /immutable/);
	if (checkDatabase) {
		// The public catalog queries runtimeConfigOverride through the Next server
		// bundle. Concurrent requests also exercise the outer database context.
		const catalogs = await Promise.all(
			Array.from({ length: 3 }, () => request("/api/media/catalog")),
		);
		for (const result of catalogs) assert(Array.isArray(JSON.parse(result.body).products));
	}
	process.stdout.write(
		JSON.stringify({
			artifact: "dist/worker/cloudflare-worker.js",
			startedInWorkerd: true,
			liveness: true,
			dynamicLoginPage: true,
			staticAssetCaching: true,
			concurrentLocalPostgresQueries: checkDatabase,
			liveCloudflareVerified: false,
		}) + "\n",
	);
} finally {
	await runtime.dispose();
	process.stdout.write("Website artifact workerd runtime disposed\n");
}
