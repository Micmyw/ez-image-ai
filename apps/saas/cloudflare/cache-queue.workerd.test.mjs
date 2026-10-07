import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");

await test("installed queue persists terminal cleanup across real workerd restarts", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ezpic-cache-alarm-"));
	let runtime;
	try {
		const { outputFiles } = await build({
			stdin: {
				resolveDir: app,
				contents: `
import { DOQueueHandler as Queue } from "@opennextjs/cloudflare/durable-objects/queue";
export class TestQueue extends Queue {
  async fetch(request) {
    const action = new URL(request.url).pathname;
    const msg = { MessageDeduplicationId: "cached", MessageBody: {
      host: "cache.test", url: "/cached", lastModified: 0,
    }};
    if (action === "/seed") {
      await this.addToFailedState(msg);
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
    if (action === "/finish") await this.executeRevalidation(msg);
    if (action === "/exhaust") {
      for (let i = 0; i < 6; i++) await this.addToFailedState(msg);
    }
    return Response.json({
      rows: this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM failed_state").one().n,
      memory: this.routeInFailedState.size,
      alarm: await this.ctx.storage.getAlarm(),
    });
  }
}
export default { fetch(request, env) {
  return env.QUEUE.getByName("regression").fetch(request);
}};`,
			},
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			external: ["cloudflare:workers", "node:*"],
			define: { "process.env.__OPEN_NEXT_BUILD_ID": '"cache-alarm-workerd"' },
		});
		const start = () =>
			new Miniflare(
				convertV4MiniflareOptions({
					host: "127.0.0.1",
					port: 0,
					modules: true,
					script: outputFiles[0].text,
					compatibilityDate: "2026-09-10",
					compatibilityFlags: ["nodejs_compat"],
					durableObjectsPersist: directory,
					durableObjects: { QUEUE: { className: "TestQueue", useSQLite: true } },
					serviceBindings: {
						WORKER_SELF_REFERENCE: () =>
							new Response(null, {
								status: 200,
								headers: { "x-nextjs-cache": "REVALIDATED" },
							}),
					},
					outboundService: () => new Response("Network forbidden", { status: 502 }),
				}),
			);
		const request = async (action) => {
			const response = await runtime.dispatchFetch(`https://cache.test/${action}`);
			assert.equal(response.status, 200);
			return response.json();
		};
		runtime = start();
		assert.equal((await request("seed")).rows, 1);
		assert.deepEqual(await request("finish"), { rows: 0, memory: 0, alarm: null });
		await runtime.dispose();
		runtime = start();
		assert.deepEqual(await request("inspect"), { rows: 0, memory: 0, alarm: null });
		await request("seed");
		assert.deepEqual(await request("exhaust"), { rows: 0, memory: 0, alarm: null });
		await runtime.dispose();
		runtime = start();
		assert.deepEqual(await request("inspect"), { rows: 0, memory: 0, alarm: null });
	} finally {
		await runtime?.dispose();
		// mkdtemp provides the task-owned path; never remove a caller-supplied path.
		assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
		assert.ok(path.basename(directory).startsWith("ezpic-cache-alarm-"));
		await rm(directory, { recursive: true, force: true });
	}
});
