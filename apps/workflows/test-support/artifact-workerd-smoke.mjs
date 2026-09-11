import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(app, "dist-workers");
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

// Load Wrangler's final output directly. Re-bundling source in a test would miss
// wrong conditional exports and generated Prisma/WASM packaging regressions.
const source = await readFile(path.join(output, "workers.js"), "utf8");
assert.match(source, /wasm-compiler-edge/);
assert(!source.includes("/runtime/client.mjs"), "Node Prisma runtime leaked into the Worker");
assert(!source.includes("/sharp/lib/"), "Native Sharp leaked into the Worker");
assert(!source.includes("/remote-media-node.ts"), "Node media transport leaked into the Worker");
const wasmFiles = (await readdir(output)).filter((file) => file.endsWith(".wasm"));
assert.equal(wasmFiles.length, 1, "Expected the generated Prisma query compiler");
const secret = "artifact-smoke-only-32-character-secret";
const compatibility = {
	compatibilityDate: "2026-09-10",
	compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
};
const runtime = new Miniflare(
	convertV4MiniflareOptions({
		host: "127.0.0.1",
		port: 0,
		workers: [
			{
				name: "driver",
				...compatibility,
				modules: true,
				script: `export default { fetch(request, env) {
  if (new URL(request.url).pathname === '/internal/execute') {
    return env.EXECUTOR.get(env.EXECUTOR.idFromName('jobs-primary')).fetch(request);
  }
  return env.JOBS_ENTRY.fetch(request);
} };`,
				durableObjects: {
					EXECUTOR: { className: "WorkerJobs", scriptName: "jobs", useSQLite: true },
				},
				serviceBindings: { JOBS_ENTRY: "jobs" },
			},
			{
				name: "jobs",
				...compatibility,
				modulesRoot: output,
				modules: [
					{ type: "ESModule", path: path.join(output, "workers.js") },
					...wasmFiles.map((file) => ({ type: "CompiledWasm", path: path.join(output, file) })),
				],
				durableObjects: { JOBS_EXECUTOR: { className: "WorkerJobs", useSQLite: true } },
				bindings: {
					EZPIC_RUNTIME: "workers",
					EZPIC_DATABASE_BINDING: "hyperdrive",
					NODE_ENV: "production",
					WORKFLOWS_DISPATCH_SECRET: secret,
					WORKFLOWS_DISPATCH_URL: "https://artifact-smoke.invalid/internal/dispatch",
					MEDIA_ENABLED_PROVIDERS: "",
					MEDIA_RECOVERY_PROVIDERS: "",
				},
				...(checkDatabase ? { hyperdrives: { HYPERDRIVE: connectionString } } : {}),
			},
		],
	}),
);

async function request(endpoint, body, signed = false) {
	const timestamp = String(Date.now());
	const signature = createHmac("sha256", secret)
		.update(`POST\n${endpoint}\n${timestamp}\n${body}`)
		.digest("hex");
	return runtime.dispatchFetch(`https://artifact-smoke.invalid${endpoint}`, {
		method: "POST",
		body,
		headers: signed ? { "x-jobs-timestamp": timestamp, "x-jobs-signature": signature } : {},
		signal: AbortSignal.timeout(30_000),
	});
}

try {
	await runtime.ready;
	assert.equal((await request("/internal/dispatch", "{}")).status, 401);
	assert.equal((await request("/internal/execute", "{}")).status, 401);
	assert.equal((await request("/internal/execute", "{}", true)).status, 400);
	if (checkDatabase) {
		// A random missing attempt performs a real Prisma query through the local
		// Hyperdrive binding, then returns without invoking a provider or mutating jobs.
		const response = await request(
			"/internal/execute",
			JSON.stringify({
				request: { taskId: "media-poll-generation", payload: { attemptId: randomUUID() } },
				context: { attempt: 1, maxAttempts: 3, runId: "artifact-smoke" },
			}),
			true,
		);
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		assert.deepEqual(result, { status: "ok", poll: { done: true, waitSeconds: 0 } });
	}
	process.stdout.write(
		JSON.stringify({
			artifact: "dist-workers/workers.js",
			startedInWorkerd: true,
			unsignedRejected: true,
			invalidSignedTaskRejected: true,
			localPostgresQuery: checkDatabase,
			liveCloudflareVerified: false,
		}) + "\n",
	);
} finally {
	await runtime.dispose();
	process.stdout.write("Artifact workerd runtime disposed\n");
}
