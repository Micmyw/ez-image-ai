import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

await test(
	"source bundles keep short wakes and derived work in isolated workerd request lifetimes",
	{ timeout: 30_000 },
	async () => {
		const copy = await readFile(
			path.join(app, "../../packages/utils/request-lifecycle.ts"),
			"utf8",
		);
		const { outputFiles } = await build({
			stdin: {
				resolveDir: app,
				contents: `
import { AsyncLocalStorage } from "node:async_hooks";
import { runScopedWorkerRequest } from "./cloudflare/request-scope.ts";
import { getRequestDefer, runWithRequestDefer } from "@repo/utils/request-lifecycle";
import { getRequestDefer as fromServerBundle } from "server-lifecycle-copy";
const database = new AsyncLocalStorage();
const rows = new Map();
export default { async fetch(request, env, execution) {
  const id = new URL(request.url).pathname.slice(1);
  if (id === "snapshot") return Response.json(Object.fromEntries(rows));
  const row = { closed: false, observations: [], copiesAgree: false };
  rows.set(id, row);
  const scope = {
    run: (callback) => database.run(id, callback),
    dispose: async () => {
      row.observations.push({ stage: "dispose", scope: database.getStore() });
      row.closed = true;
    },
  };
  return runScopedWorkerRequest(request, env, execution, scope,
    (request, env, context) => runWithRequestDefer((task) => context.waitUntil(task), async () => {
      row.copiesAgree = fromServerBundle() === getRequestDefer();
      const wake = env.BARRIER.fetch("https://barrier.test/wake/" + id).then(async () => {
        row.observations.push({ stage: "wake", scope: database.getStore(), closed: row.closed });
        if (id === "b") throw new Error("controlled rejected wake");
        const child = env.BARRIER.fetch("https://barrier.test/child/" + id).then(() => {
          row.observations.push({ stage: "child", scope: database.getStore(), closed: row.closed });
        });
        fromServerBundle()(child);
      });
      getRequestDefer()(wake.catch(() => { row.rejected = true; }));
      return Response.json({ accepted: id }, { status: 201 });
    })
  );
}};`,
			},
			plugins: [
				{
					name: "independent-server-copy",
					setup(builder) {
						builder.onResolve({ filter: /^server-lifecycle-copy$/ }, () => ({
							path: "copy",
							namespace: "server-copy",
						}));
						builder.onLoad({ filter: /.*/, namespace: "server-copy" }, () => ({
							contents: copy,
							loader: "ts",
						}));
					},
				},
			],
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			external: ["node:*"],
		});
		const gates = new Map(
			["/wake/a", "/wake/b", "/child/a"].map((key) => [
				key,
				{ finish: deferred(), started: deferred() },
			]),
		);
		const runtime = new Miniflare(
			convertV4MiniflareOptions({
				host: "127.0.0.1",
				port: 0,
				modules: true,
				script: outputFiles[0].text,
				compatibilityDate: "2026-09-10",
				compatibilityFlags: ["nodejs_compat"],
				serviceBindings: {
					BARRIER: async (request) => {
						const gate = gates.get(new URL(request.url).pathname);
						assert.ok(gate, "Only controlled local wakes are allowed");
						gate.started.resolve();
						await gate.finish.promise;
						return new Response(null, { status: 204 });
					},
				},
				outboundService: () => new Response("External network forbidden", { status: 502 }),
			}),
		);
		const snapshot = async () =>
			(await runtime.dispatchFetch("https://scope.test/snapshot")).json();
		const until = async (predicate) => {
			for (let n = 0; n < 100; n++) {
				const rows = await snapshot();
				if (predicate(rows)) return rows;
				await new Promise((done) => setTimeout(done, 10));
			}
			assert.fail("Scoped work did not finish");
		};
		try {
			const responses = await Promise.all(
				["a", "b"].map((id) => runtime.dispatchFetch(`https://scope.test/${id}`)),
			);
			for (const response of responses) {
				assert.equal(response.status, 201);
				await response.text();
			}
			await Promise.all([
				gates.get("/wake/a").started.promise,
				gates.get("/wake/b").started.promise,
			]);
			let rows = await snapshot();
			for (const id of ["a", "b"]) {
				assert.equal(rows[id].closed, false);
				assert.equal(rows[id].copiesAgree, true);
			}
			gates.get("/wake/b").finish.resolve();
			rows = await until((rows) => rows.b.closed);
			assert.equal(rows.b.rejected, true);
			assert.equal(rows.a.closed, false);
			gates.get("/wake/a").finish.resolve();
			await gates.get("/child/a").started.promise;
			assert.equal((await snapshot()).a.closed, false);
			gates.get("/child/a").finish.resolve();
			rows = await until((rows) => rows.a.closed);
			assert.deepEqual(rows.a.observations, [
				{ stage: "wake", scope: "a", closed: false },
				{ stage: "child", scope: "a", closed: false },
				{ stage: "dispose", scope: "a" },
			]);
			assert.deepEqual(rows.b.observations, [
				{ stage: "wake", scope: "b", closed: false },
				{ stage: "dispose", scope: "b" },
			]);
		} finally {
			for (const gate of gates.values()) gate.finish.resolve();
			await runtime.dispose();
		}
	},
);
