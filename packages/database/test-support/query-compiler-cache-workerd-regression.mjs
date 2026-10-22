import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert(process.argv.includes("--execute"), "Explicit --execute is required");
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const label = process.env.COMPILER_CACHE_TEST_LABEL ?? `compiler-cache-${Date.now()}`;
assert(/^[a-z0-9_-]{1,80}$/i.test(label));
const connectionString = process.env.TEST_DATABASE_URL;
assert(connectionString && connectionString !== process.env.DATABASE_URL);
const database = new URL(connectionString);
assert(["postgres:", "postgresql:"].includes(database.protocol));
assert(["127.0.0.1", "localhost"].includes(database.hostname));
assert.equal(database.port, "55432");
assert.match(database.pathname, /test/i);
const requireDatabase = createRequire(path.join(root, "packages/database/package.json"));
const runtimeDirectory = path.dirname(
	requireDatabase.resolve("@prisma/client/runtime/wasm-compiler-edge"),
);
const wranglerRequire = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const esbuild = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const outputDirectory = path.join(root, ".cache/generation-one-second-20261022", label);
await mkdir(outputDirectory, { recursive: false });
const resultPath = path.join(outputDirectory, "result.json");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [
	path.join(runtimeDirectory, "query-compiler-reuse.js"),
	path.join(runtimeDirectory, "query-compiler-reuse.mjs"),
	path.join(runtimeDirectory, "wasm-compiler-edge.mjs"),
	path.join(directory, "query-compiler-cache-worker.ts"),
];
const result = {
	rootPid: process.pid,
	parentPid: process.ppid,
	startedAt: new Date().toISOString(),
	label,
	boundary:
		"Two tiny sequential local workerd requests, each with independent clients and isolated PG fixtures. Actual installed helper and real compiler/WASM. No benchmark, application build, provider call or production certification.",
	provenance: await Promise.all(
		sourceFiles.map(async (file) => ({ file, sha256: hash(await readFile(file)) })),
	),
	processSnapshots: [],
	runs: [],
};
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));
await save();
const processTree = () => {
	if (process.platform !== "win32") return [{ pid: process.pid, parentPid: process.ppid }];
	const script = `$all = Get-CimInstance Win32_Process; $ids = [Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${process.pid}); do { $added = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId; parentPid=$_.ParentProcessId; name=$_.Name; created=$_.CreationDate} }) | ConvertTo-Json -Compress`;
	const value = JSON.parse(
		execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
		}),
	);
	return Array.isArray(value) ? value : [value];
};
function bounded(name, promise, milliseconds) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${name}_TIMEOUT`)), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
}
let workerd;
try {
	result.processSnapshots.push({ phase: "before-build", processes: processTree() });
	const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
	const build = await esbuild.build({
		absWorkingDir: root,
		entryPoints: [path.join(directory, "query-compiler-cache-worker.ts")],
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd"],
		mainFields: ["module", "main"],
		write: false,
		metafile: true,
		external: ["cloudflare:*", "pg-native"],
		plugins: [
			{
				name: "worker-externals",
				setup(build) {
					build.onResolve({ filter: /\.wasm\?module$/ }, () => ({
						path: "./query-compiler.wasm",
						external: true,
					}));
					build.onResolve({ filter: /.*/ }, (args) =>
						builtins.has(args.path)
							? {
									path: args.path.startsWith("node:") ? args.path : `node:${args.path}`,
									external: true,
								}
							: undefined,
					);
				},
			},
		],
		banner: {
			js: "import { createRequire as __testCreateRequire } from 'node:module'; const require = __testCreateRequire('file:///compiler-cache-worker.mjs');",
		},
	});
	esbuild.stop();
	const inputs = Object.keys(build.metafile.inputs);
	assert(
		inputs.some((input) => input.replaceAll("\\", "/").endsWith("runtime/query-compiler-reuse.js")),
		"The actual installed cache helper must be bundled",
	);
	assert(
		inputs.some((input) => input.replaceAll("\\", "/").endsWith("runtime/wasm-compiler-edge.mjs")),
		"The actual edge runtime must be bundled",
	);
	assert(
		!inputs.some((input) => /runtime\/client\.(mjs|js)$/.test(input.replaceAll("\\", "/"))),
		"Node Prisma engine must not enter workerd",
	);
	const scriptPath = path.join(outputDirectory, "worker.mjs");
	const wasmPath = path.join(outputDirectory, "query-compiler.wasm");
	await writeFile(scriptPath, build.outputFiles[0].contents);
	await writeFile(
		wasmPath,
		await readFile(
			path.join(
				root,
				"packages/database/prisma/generated-worker/internal/query_compiler_fast_bg.wasm",
			),
		),
	);
	await writeFile(
		path.join(outputDirectory, "metafile.json"),
		JSON.stringify(build.metafile, null, 2),
	);
	result.bundleSha256 = hash(build.outputFiles[0].contents);
	workerd = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port: 0,
			workers: [
				{
					name: "compiler-cache-regression",
					compatibilityDate: "2026-09-10",
					compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
					modulesRoot: outputDirectory,
					modules: [
						{ type: "ESModule", path: scriptPath },
						{ type: "CompiledWasm", path: wasmPath },
					],
					hyperdrives: { HYPERDRIVE: connectionString },
					bindings: { TEST_RUN_LABEL: label },
				},
			],
		}),
	);
	await bounded("WORKER_READY", workerd.ready, 15_000);
	result.processSnapshots.push({ phase: "runtime-ready", processes: processTree() });
	await save();
	for (let index = 0; index < 2; index++) {
		const response = await bounded(
			"WORKER_REGRESSION",
			workerd.dispatchFetch("http://compiler-cache.invalid/run", { method: "POST" }),
			25_000,
		);
		const payload = await response.json();
		result.runs.push(payload);
		await save();
		assert.equal(response.status, 200, JSON.stringify(payload));
		assert.equal(payload.passed, true);
		assert.equal(payload.compiler.constructions, 1);
		assert.equal(payload.compiler.freeCalls, 0);
	}
	assert.equal(
		new Set(result.runs.flatMap((run) => run.ids)).size,
		4,
		"Dynamic defaults must remain distinct across requests",
	);
	result.completedAt = new Date().toISOString();
} catch (error) {
	result.error = { message: error.message, stack: error.stack };
	process.exitCode = 1;
} finally {
	esbuild.stop();
	if (workerd)
		await bounded("WORKER_DISPOSE", workerd.dispose(), 10_000).catch((error) => {
			result.cleanupError = error.message;
			process.exitCode = 1;
		});
	result.processSnapshots.push({ phase: "after-dispose", processes: processTree() });
	result.cleanedAt = new Date().toISOString();
	await save();
	console.log(
		JSON.stringify({
			resultPath,
			passed: Boolean(result.completedAt),
			error: result.error,
			cleanupError: result.cleanupError,
			rootPid: process.pid,
		}),
	);
}
