import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, ".wrangler/streaming-private-image-smoke");
const endpoint = process.env.MINIO_STREAM_TEST_ENDPOINT ?? "http://127.0.0.1:9540";
const parsed = new URL(endpoint);
assert(
	["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.protocol === "http:",
	"Use a disposable loopback MinIO only",
);
const bucket = process.env.MINIO_STREAM_TEST_BUCKET ?? "scanless-private";
assert(
	bucket === "scanless-private" || bucket.startsWith("test-"),
	"An isolated fixture bucket is required",
);
const credentials = { accessKeyId: "scanless", secretAccessKey: "scanless-local-only" };
const wranglerRequire = createRequire(
	realpathSync(path.join(root, "apps/workflows/node_modules/wrangler/package.json")),
);
const { build } = wranglerRequire("esbuild");
const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
const workerd = miniflareRequire("workerd");
const storageRequire = createRequire(path.join(root, "packages/storage/package.json"));
const { S3Client, GetObjectCommand, DeleteObjectCommand } = storageRequire("@aws-sdk/client-s3");
const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials });
const prefix = `users/streaming-workerd-${randomUUID()}/assets/`;
const keys = new Set();
await mkdir(output, { recursive: true });

const entry = `
import { Readable } from 'node:stream';
let active = 0, maximumActive = 0;
const raceReservations = new Map();
export default { async fetch(request) {
  Object.assign(process.env, { S3_ENDPOINT: 'http://storage.fixture', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'scanless', S3_SECRET_ACCESS_KEY: 'scanless-local-only', MEDIA_BUCKET_NAME: ${JSON.stringify(bucket)} });
  const { tryWriteImmutableGenerationImage } = await import(${JSON.stringify(path.join(root, "packages/storage/provider/s3/index.ts"))});
  const input = await request.json();
  let generated = 0, destroyed = false, firstSnapshot, secondSnapshot, reserved = false;
  const source = new Readable({ highWaterMark: 65536,
    read() {
      if (input.mode === 'stalled' && generated > 0) return;
      if (generated >= input.actualLength) { this.push(null); return; }
      const size = Math.min(65536, input.actualLength - generated);
      const chunk = Buffer.alloc(size, input.fill ?? 19);
      if (generated === 0) Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(chunk);
      generated += size;
      this.push(chunk);
    },
    destroy(error, callback) { destroyed = true; callback(error); }
  });
  const firstTimer = setTimeout(() => { firstSnapshot = generated; }, 40);
  const secondTimer = setTimeout(() => { secondSnapshot = generated; }, 80);
  active++; maximumActive = Math.max(maximumActive, active);
  try {
    const result = await tryWriteImmutableGenerationImage({
      bucket: 'media', key: input.key, contentType: 'image/png', streamingOnly: true,
      openedSource: { contentType: 'image/png', status: 200, headers: { 'content-length': String(input.length) }, url: new URL('https://cdn.provider.test/result.png'), stream: source },
      reserve: async () => {
        if (input.mode !== 'race' || reserved) return;
        reserved = true;
        let race = raceReservations.get(input.key);
        if (!race) { let release; const promise = new Promise(resolve => { release = resolve; }); race = { count: 0, promise, release }; raceReservations.set(input.key, race); }
        if (++race.count === 2) { race.release(); raceReservations.delete(input.key); }
        await race.promise;
      },
    }, { totalTimeoutMs: input.mode === 'stalled' ? 200 : 20000 });
    return Response.json({ result, generated, destroyed, firstSnapshot, secondSnapshot, maximumActive });
  } catch (error) { return Response.json({ error: error.message, code: error.code, generated, destroyed, firstSnapshot, secondSnapshot }); }
  finally { active--; clearTimeout(firstTimer); clearTimeout(secondTimer); source.destroy(); }
} };`;
const built = await build({
	stdin: {
		contents: entry,
		resolveDir: root,
		sourcefile: "streaming-private-image-smoke.ts",
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "neutral",
	conditions: ["workerd"],
	mainFields: ["module", "main"],
	external: ["node:*"],
	write: false,
});
await writeFile(path.join(output, "worker.mjs"), built.outputFiles[0].text);
await writeFile(
	path.join(output, "fixture.mjs"),
	`export default { async fetch(request, env) {
  if (request.method === 'PUT' && new URL(request.url).pathname.includes('held-')) await new Promise(resolve => setTimeout(resolve, 150));
  if (request.method === 'PUT' && new URL(request.url).pathname.includes('conflict-')) return new Response(null, { status: 412 });
  return env.MINIO.fetch(request);
} };`,
);
await writeFile(
	path.join(output, "smoke.capnp"),
	`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "test", worker = (compatibilityDate = "2026-09-08", compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"], globalOutbound = "fixture", modules = [(name = "worker.mjs", esModule = embed "worker.mjs")])),
  (name = "fixture", worker = (compatibilityDate = "2026-09-08", modules = [(name = "fixture.mjs", esModule = embed "fixture.mjs")], bindings = [(name = "MINIO", service = "minio")])),
  (name = "minio", external = (address = "${parsed.host}", http = ()))
 ], sockets = [(name = "test", address = "127.0.0.1:0", http = (), service = "test")]
);`,
);

const runtime = spawn(
	workerd.default,
	["serve", "--control-fd=3", path.join(output, "smoke.capnp")],
	{ cwd: root, stdio: ["ignore", "pipe", "pipe", "pipe"], windowsHide: true },
);
const closed = once(runtime, "close");
process.stdout.write(`Streaming image smoke process ${process.pid}, workerd ${runtime.pid}\n`);
let logs = "";
runtime.stderr.on("data", (chunk) => {
	logs += chunk.toString();
});
try {
	const port = await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("workerd startup timeout: " + logs)), 10000);
		runtime.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error("workerd exited: " + code + " " + logs));
		});
		runtime.once("error", reject);
		let data = "";
		runtime.stdio[3].on("data", (chunk) => {
			data += chunk.toString();
			while (data.includes("\n")) {
				const end = data.indexOf("\n");
				const event = JSON.parse(data.slice(0, end));
				data = data.slice(end + 1);
				if (event.event === "listen") {
					clearTimeout(timeout);
					resolve(event.port);
				}
			}
		});
	});
	const run = async (name, length, actualLength = length, mode = "normal", fill = 19) => {
		const key = `${prefix}${name}.png`;
		keys.add(key);
		const response = await fetch(`http://127.0.0.1:${port}`, {
			method: "POST",
			body: JSON.stringify({ key, length, actualLength, mode, fill }),
			signal: AbortSignal.timeout(30000),
		});
		assert.equal(response.status, 200);
		return { key, ...(await response.json()) };
	};
	const read = async (key) => {
		const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
		return Buffer.from(await object.Body.transformToByteArray());
	};
	const hash = (value) => createHash("sha256").update(value).digest("hex");
	const regular = await run("regular", 2 * 1024 * 1024);
	assert(regular.result, JSON.stringify(regular) + logs);
	assert.equal(regular.result.sha256, hash(await read(regular.key)));
	const held = await run("held-backpressure", 10 * 1024 * 1024);
	assert(held.result, JSON.stringify(held) + logs);
	assert(held.firstSnapshot <= 8 * 65536, JSON.stringify(held));
	assert.equal(held.firstSnapshot, held.secondSnapshot, JSON.stringify(held));
	assert.equal(held.result.sha256, hash(await read(held.key)));
	const maximum = await run("business-maximum", 25 * 1024 * 1024);
	assert(maximum.result, JSON.stringify(maximum) + logs);
	assert.equal(maximum.result.sha256, hash(await read(maximum.key)));
	const race = await Promise.all([
		run("conditional-race", 2 * 1024 * 1024, 2 * 1024 * 1024, "race", 19),
		run("conditional-race", 2 * 1024 * 1024, 2 * 1024 * 1024, "race", 37),
	]);
	const winnerHash = hash(await read(race[0].key));
	for (const attempt of race) {
		assert(attempt.result, JSON.stringify(attempt));
		assert.equal(attempt.result.sha256, winnerHash);
	}
	const recovered = await run("regular", 65536, 65536, "normal", 37);
	assert.equal(recovered.result.sha256, regular.result.sha256);
	assert.equal(recovered.generated, 0, JSON.stringify(recovered));
	for (const [name, length, actualLength, mode] of [
		["too-long", 65536, 65537, "normal"],
		["too-short", 65536, 65535, "normal"],
		["stalled", 131072, 131072, "stalled"],
	]) {
		const invalid = await run(name, length, actualLength, mode);
		assert(invalid.error, JSON.stringify(invalid));
		assert(invalid.destroyed, JSON.stringify(invalid));
		await assert.rejects(read(invalid.key), (error) => error.$metadata?.httpStatusCode === 404);
	}
	const concurrent = await Promise.all(
		Array.from({ length: 50 }, (_, i) => run(`concurrent-${i}`, 2 * 1024 * 1024)),
	);
	for (const item of concurrent) {
		assert(item.result, JSON.stringify(item));
		assert.equal(item.result.sha256, hash(await read(item.key)));
	}
	assert(Math.max(...concurrent.map((item) => item.maximumActive)) > 1);
	process.stdout.write(
		JSON.stringify(
			{
				workerd: workerd.version,
				regularBytes: regular.result.bytes,
				heldBytes: held.result.bytes,
				blockedSourceBytes: held.firstSnapshot,
				unchangedBlockedSourceBytes: held.secondSnapshot,
				maximumImageBytes: maximum.result.bytes,
				conditionalRaceConverged: true,
				recoveryWithoutSourceRead: true,
				invalidObjectsAbsent: 3,
				concurrentObjects: concurrent.length,
				maximumActive: Math.max(...concurrent.map((item) => item.maximumActive)),
				actualMinio: true,
				externalProviderCalls: 0,
			},
			null,
			2,
		) + "\n",
	);
} finally {
	if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill();
	await closed;
	assert(runtime.exitCode !== null || runtime.signalCode !== null, "workerd did not exit");
	for (const Key of keys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
	s3.destroy();
	process.stdout.write(`workerd ${runtime.pid} exited; task fixture objects removed\n`);
}
