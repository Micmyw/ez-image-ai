import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { measureQueries, summarize } from "./pg-cloudflare-queries.mjs";

assert(process.argv.includes("--execute"), "Explicit --execute is required");
assert.equal(
	process.env.PG_SOCKET_PROBE_EXCLUSIVE_WINDOW,
	"true",
	"Coordinate the exclusive workerd/DB measurement window first",
);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const label = process.env.PG_SOCKET_PROBE_LABEL ?? `pg-socket-${Date.now()}`;
assert(/^[a-z0-9_-]{1,80}$/i.test(label));
const repeats = Number(process.env.PG_SOCKET_PROBE_REPEATS ?? 12);
assert(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 40);
const connectionString = process.env.TEST_DATABASE_URL;
assert(
	connectionString,
	"An explicit local TEST_DATABASE_URL is required; DATABASE_URL is never used",
);
const database = new URL(connectionString);
assert(["postgres:", "postgresql:"].includes(database.protocol));
assert(["127.0.0.1", "localhost"].includes(database.hostname));
assert.equal(database.port, "55432", "Use the dedicated loopback PostgreSQL fixture");
assert(/(?:^|[_-])test(?:[_-]|$)/.test(database.pathname.slice(1)));
assert.equal(
	database.search,
	"",
	"This regression uses the plaintext loopback PostgreSQL fixture without URL options",
);

const requireDatabase = createRequire(path.join(root, "packages/database/package.json"));
const pg = requireDatabase("pg");
const requirePg = createRequire(requireDatabase.resolve("pg"));
const packageDirectory = path.dirname(requirePg.resolve("pg-cloudflare/package.json"));
const socketPath = path.join(packageDirectory, "dist/index.js");
const packageMetadata = JSON.parse(
	await readFile(path.join(packageDirectory, "package.json"), "utf8"),
);
assert.equal(packageMetadata.version, "1.4.0");
const hash = (input) => createHash("sha256").update(input).digest("hex");
const socketHash = hash(await readFile(socketPath));
assert.equal(
	typeof requirePg(socketPath).CloudflareSocket.prototype.cork,
	"function",
	"The pnpm dependency patch must be installed",
);
const wranglerRequire = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const esbuild = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const outputDirectory = path.join(root, ".cache/pg-cloudflare-regression");
await mkdir(outputDirectory, { recursive: true });
const resultPath = path.join(outputDirectory, `${label}.json`);
const result = {
	rootPid: process.pid,
	startedAt: new Date().toISOString(),
	label,
	repeats,
	scope:
		"Read-only local PG; the installed pg-cloudflare class versus the same class with cork/uncork disabled. Node controls before/after; no business writes or external provider requests.",
	connection: {
		host: database.hostname,
		port: database.port,
		database: database.pathname.slice(1),
		ssl: false,
	},
	provenance: {
		installedSocketPath: socketPath,
		installedSocketSha256: socketHash,
		patchSha256: hash(await readFile(path.join(root, "patches/pg-cloudflare@1.4.0.patch"))),
		pgVersion: requireDatabase("pg/package.json").version,
		pgCloudflareVersion: packageMetadata.version,
	},
	limitation:
		"Local workerd/Hyperdrive and plaintext PostgreSQL do not certify deployed latency or TLS handshakes. Workerd clock resolution may round sub-millisecond timings to zero. Pass/fail checks correctness and write grouping, never a latency threshold.",
	processSnapshots: [],
	runs: [],
};
await writeFile(resultPath, JSON.stringify(result, null, 2), { flag: "wx" });
const save = () => writeFile(resultPath, JSON.stringify(result, null, 2));
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
async function nodeRun(phase) {
	const stats = { writerCalls: 0, writerBytes: 0 };
	const socket = new net.Socket();
	const originalWrite = socket._write.bind(socket);
	const originalWritev = socket._writev.bind(socket);
	socket._write = function (chunk, encoding, callback) {
		stats.writerCalls++;
		stats.writerBytes += chunk.byteLength;
		return originalWrite(chunk, encoding, callback);
	};
	socket._writev = function (chunks, callback) {
		stats.writerCalls++;
		stats.writerBytes += chunks.reduce((sum, chunk) => sum + chunk.chunk.byteLength, 0);
		return originalWritev(chunks, callback);
	};
	const client = new pg.Client({
		connectionString,
		stream: socket,
		ssl: false,
		application_name: "ezpic-pg-socket-node-control",
		options:
			"-c default_transaction_read_only=on -c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
		connectionTimeoutMillis: 5000,
		query_timeout: 10000,
	});
	try {
		const started = performance.now();
		await client.connect();
		const connectMs = performance.now() - started;
		const measurements = await measureQueries(client, repeats, () => ({ ...stats }));
		return {
			phase,
			variant: "node-native-cork",
			connectMs,
			...measurements,
			summary: summarize(measurements.samples),
		};
	} finally {
		await bounded("NODE_END", client.end(), 2000).catch((error) => {
			socket.destroy();
			throw error;
		});
	}
}

let runtime;
console.log(
	JSON.stringify({ stage: "pg-socket-regression.started", rootPid: process.pid, resultPath }),
);
try {
	result.processSnapshots.push({
		phase: "before-build",
		at: new Date().toISOString(),
		processes: processTree(),
	});
	const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
	const build = await esbuild.build({
		absWorkingDir: root,
		entryPoints: [path.join(directory, "pg-cloudflare-worker.mjs")],
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd"],
		mainFields: ["module", "main"],
		write: false,
		metafile: true,
		alias: { pg: requireDatabase.resolve("pg") },
		nodePaths: [path.dirname(packageDirectory)],
		external: ["cloudflare:*", "pg-native"],
		plugins: [
			{
				name: "node-builtins",
				setup(build) {
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
			js: "import { createRequire as __probeCreateRequire } from 'node:module'; const require = __probeCreateRequire('file:///pg-socket-regression.mjs');",
		},
	});
	esbuild.stop();
	const worker = build.outputFiles[0].text;
	const bundledSocket = Object.keys(build.metafile.inputs).find((input) =>
		input.replaceAll("\\", "/").endsWith("pg-cloudflare/dist/index.js"),
	);
	assert(
		bundledSocket,
		"The workerd conditional export must bundle the installed CloudflareSocket",
	);
	assert.equal(realpathSync(path.resolve(root, bundledSocket)), realpathSync(socketPath));
	result.provenance.workerBundleSha256 = hash(worker);
	result.provenance.bundledSocket = bundledSocket;
	await writeFile(path.join(outputDirectory, `${label}-worker.mjs`), worker);
	await writeFile(
		path.join(outputDirectory, `${label}-metafile.json`),
		JSON.stringify(build.metafile, null, 2),
	);
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port: 0,
			workers: [
				{
					name: "pg-socket-regression",
					compatibilityDate: "2026-09-10",
					compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
					modules: true,
					script: worker,
					hyperdrives: { HYPERDRIVE: connectionString },
				},
			],
		}),
	);
	await bounded("WORKER_READY", runtime.ready, 10000);
	result.processSnapshots.push({
		phase: "runtime-ready",
		at: new Date().toISOString(),
		processes: processTree(),
	});
	result.runs.push(await nodeRun("before"));
	await save();
	for (const [index, variant] of [
		"cork-disabled",
		"installed",
		"installed",
		"cork-disabled",
	].entries()) {
		const response = await bounded(
			"WORKER_QUERIES",
			runtime.dispatchFetch("http://probe.invalid/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ variant, repeats }),
			}),
			30000,
		);
		const payload = await response.json();
		assert.equal(response.status, 200, JSON.stringify(payload));
		assert.equal(payload.metadata.database, database.pathname.slice(1));
		assert.equal(payload.socket.hasCork, variant === "installed");
		assert(payload.socket.maxBufferedBytes <= 65536 && payload.socket.maxBufferedFrames <= 64);
		const expected =
			variant === "installed"
				? { simple: 1, parameterized: 1, prepared: 1, transaction: 4 }
				: { simple: 1, parameterized: 5, prepared: 4, transaction: 12 };
		for (const [phase, calls] of Object.entries(expected)) {
			assert.equal(payload.summary[phase].count, repeats);
			assert.deepEqual(
				payload.summary[phase].writerCallsPerOperation,
				[calls],
				`${variant}/${phase} native write grouping`,
			);
		}
		result.runs.push({ phase: `abba-${index}`, ...payload });
		await save();
		console.log(
			JSON.stringify({
				stage: "pg-socket-regression.run",
				variant,
				index,
				summary: payload.summary,
			}),
		);
	}
	result.runs.push(await nodeRun("after"));
	result.completedAt = new Date().toISOString();
} catch (error) {
	result.error = { name: error.name, message: error.message, stack: error.stack };
	console.error(error);
	process.exitCode = 1;
} finally {
	esbuild.stop();
	if (runtime)
		await bounded("WORKER_DISPOSE", runtime.dispose(), 10000).catch((error) => {
			result.cleanupError = error.message;
			process.exitCode = 1;
		});
	result.processSnapshots.push({
		phase: "after-dispose",
		at: new Date().toISOString(),
		processes: processTree(),
	});
	result.provenance.installedSocketUnchanged = hash(await readFile(socketPath)) === socketHash;
	result.cleanedAt = new Date().toISOString();
	await save();
	console.log(
		JSON.stringify({
			stage: "pg-socket-regression.finished",
			resultPath,
			completed: Boolean(result.completedAt),
			cleanupError: result.cleanupError,
			provenance: result.provenance,
		}),
	);
}
