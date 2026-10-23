import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const secret = "runtime-lifetime-local-test-32-character-secret";

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded(promise, label) {
	let timeout;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

// Keep the actual executor entrypoints, runtime scope, publication, and ALS in the
// workerd bundle. Only business execution, DB I/O, and publication transport are
// local fixtures; this is not PostgreSQL or production artifact certification.
const fixtures = {
	"lifetime-test-state": `
import { AsyncLocalStorage } from "node:async_hooks";
export const database = new AsyncLocalStorage();
export const rows = new Map();
let barrier;
export function configure(env) { barrier = env.BARRIER; }
export async function wait(stage, id) {
  const response = await barrier.fetch("https://barrier.test/" + stage + "/" + id);
  if (response.status !== 204) throw new Error("CONTROLLED_BARRIER_FAILURE");
}
export function observe(client, stage) {
  client.row.observations.push({ stage, scope: database.getStore()?.id, closed: client.row.closed });
}
`,
	"@repo/database/client": `
import { database, rows } from "lifetime-test-state";
export function createRuntimeDatabaseClient(_connection, diagnostics) {
  const id = diagnostics.runId;
  if (rows.has(id)) throw new Error("UNEXPECTED_BUSINESS_REPLAY");
  const row = { closed: false, executions: 0, observations: [] };
  rows.set(id, row);
  const client = { id, row, async $disconnect() {
    row.observations.push({ stage: "disconnect" });
    if (row.closed) throw new Error("DOUBLE_DISCONNECT");
    row.closed = true;
  } };
  return client;
}
export const getDatabaseClient = () => database.getStore();
export const runWithDatabaseClient = (client, callback) => database.run(client, callback);
`,
	"@repo/database/media-job-notifications": `
import { database, observe, wait } from "lifetime-test-state";
import { getRequestDefer } from "@repo/utils/request-lifecycle";
export async function acknowledgePublishedMediaJobNotification(_notification, client) {
  client ??= database.getStore();
  observe(client, "ack-start");
  await wait("ack", client.id);
  observe(client, "ack-end");
  if (client.id === "child-control") {
    getRequestDefer()(wait("child", client.id).then(() => observe(client, "child")));
  }
  if (client.id === "failed-ack") throw new Error("CONTROLLED_ACK_FAILURE");
}
`,
	"@repo/jobs/orchestration/executor": `
import { getDatabaseClient } from "@repo/database/client";
import { publishCommittedMediaJobNotifications } from "@repo/jobs/realtime/publish";
import { observe } from "lifetime-test-state";
export async function executeTask() {
  const client = getDatabaseClient();
  client.row.executions++;
  await publishCommittedMediaJobNotifications([{
    eventId: "mju_" + "a".repeat(64), jobId: client.id, version: "asset:a:g1:ready"
  }], client);
  observe(client, "business-return");
  if (client.id === "failed-business") throw new Error("CONTROLLED_BUSINESS_FAILURE");
  return { done: true, waitSeconds: 0, continuation: { eventIds: [] } };
}
`,
	"@repo/jobs/orchestration/polling": `export async function executePollingTick() { throw new Error("UNEXPECTED_POLL"); }`,
	"@repo/storage/image-processing/cloudflare-images": `export const createCloudflareImagesProcessor = () => ({});`,
};

await test(
	"real workerd service lifetimes retain publication ACKs and descendants after the response",
	{ timeout: 30_000 },
	async () => {
		const { outputFiles } = await build({
			stdin: {
				resolveDir: app,
				contents: `
import { DurableObject } from "cloudflare:workers";
import { createRuntimeExecutionHandler } from "./src/runtime-execution.ts";
import { configure, rows } from "lifetime-test-state";
export { ControlExecutor } from "./src/control-executor.ts";
export { TransferExecutor } from "./src/transfer-executor.ts";
export class PublicationHub extends DurableObject {
  async fetch(request) {
    const notification = await request.json();
    return this.env.BARRIER.fetch(new Request("https://barrier.test/receipt/" + notification.jobId, {
      method: "POST", body: JSON.stringify(notification)
    }));
  }
}
export default { fetch(request, env) {
  configure(env);
  if (new URL(request.url).pathname === "/snapshot") return Response.json(Object.fromEntries(rows));
  const lane = request.headers.get("x-test-lane");
  if (lane === "legacy") return createRuntimeExecutionHandler(env, { admission: "request" })(request);
  return (lane === "transfer" ? env.TRANSFER : env.CONTROL).fetch(request);
} };
`,
			},
			plugins: [
				{
					name: "controlled-runtime-boundaries",
					setup(builder) {
						builder.onResolve({ filter: /^(?:@repo\/|lifetime-test-state$)/ }, (args) =>
							Object.hasOwn(fixtures, args.path)
								? { path: args.path, namespace: "lifetime-fixture" }
								: undefined,
						);
						builder.onLoad({ filter: /.*/, namespace: "lifetime-fixture" }, (args) => ({
							contents: fixtures[args.path],
							resolveDir: app,
							loader: "ts",
						}));
					},
				},
			],
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			conditions: ["workerd", "worker", "browser"],
			external: ["node:*", "cloudflare:*"],
		});
		const gates = new Map();
		let cleaningUp = false;
		function gate(stage, id) {
			const key = `/${stage}/${id}`;
			if (!gates.has(key)) gates.set(key, { started: deferred(), finish: deferred() });
			if (cleaningUp) gates.get(key).finish.resolve();
			return gates.get(key);
		}
		const started = (stage, id) => bounded(gate(stage, id).started.promise, `${stage}/${id}`);
		const runtime = new Miniflare(
			convertV4MiniflareOptions({
				host: "127.0.0.1",
				port: 0,
				name: "lifetime-test",
				modules: true,
				script: outputFiles[0].text,
				compatibilityDate: "2026-09-10",
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				bindings: {
					EZPIC_RUNTIME: "workers",
					MEDIA_JOB_EVENTS_ENABLED: "true",
					WORKFLOWS_DISPATCH_SECRET: secret,
					WORKFLOWS_DISPATCH_URL: "https://jobs.example.test/internal/dispatch",
					HYPERDRIVE: { connectionString: "fixture-only" },
					IMAGES: {},
					JOBS: {},
				},
				durableObjects: { MEDIA_JOB_EVENTS: { className: "PublicationHub", useSQLite: true } },
				serviceBindings: {
					CONTROL: { name: "lifetime-test", entrypoint: "ControlExecutor" },
					TRANSFER: { name: "lifetime-test", entrypoint: "TransferExecutor" },
					BARRIER: async (request) => {
						const [stage, id] = new URL(request.url).pathname.slice(1).split("/");
						assert.ok(["receipt", "ack", "child"].includes(stage));
						const current = gate(stage, id);
						current.started.resolve();
						await current.finish.promise;
						if (stage !== "receipt") return new Response(null, { status: 204 });
						if (id === "failed-receipt") return new Response(null, { status: 503 });
						const { eventId } = await request.json();
						return Response.json({ persisted: true, eventId });
					},
				},
				outboundService: () => new Response("External network forbidden", { status: 502 }),
			}),
		);
		const snapshot = async () =>
			(await bounded(runtime.dispatchFetch("https://runtime.test/snapshot"), "snapshot")).json();
		async function until(predicate) {
			for (let attempt = 0; attempt < 200; attempt++) {
				const state = await snapshot();
				if (predicate(state)) return state;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.fail("Managed runtime work did not reach the expected state");
		}
		function execute(id, lane = "control") {
			const transfer = lane === "transfer";
			const body = JSON.stringify({
				request: transfer
					? { taskId: "media-finalize-generation", payload: { jobId: id, version: 0 } }
					: { taskId: "media-verify-upload", payload: { assetId: id } },
				context: { attempt: 1, maxAttempts: transfer ? 5 : 8, runId: id },
			});
			const timestamp = String(Date.now());
			const signature = createHmac("sha256", secret)
				.update(`POST\n/internal/execute\n${timestamp}\n${body}`)
				.digest("hex");
			return bounded(
				runtime.dispatchFetch("https://runtime.test/internal/execute", {
					method: "POST",
					body,
					headers: {
						"x-test-lane": lane,
						"x-jobs-timestamp": timestamp,
						"x-jobs-signature": signature,
					},
				}),
				`response/${id}`,
			);
		}
		try {
			const controlId = "child-control";
			const transferId = "independent-transfer";
			const responses = await Promise.all([execute(controlId), execute(transferId, "transfer")]);
			assert.deepEqual(
				responses.map(({ status }) => status),
				[200, 200],
			);
			// Cancel the already-returned main body while publication is still blocked.
			await responses[0].body.cancel();
			await responses[1].text();
			await Promise.all([started("receipt", controlId), started("receipt", transferId)]);
			let state = await snapshot();
			assert.equal(state[controlId].closed, false);
			assert.equal(state[transferId].closed, false);
			for (const id of [controlId, transferId]) gate("receipt", id).finish.resolve();
			await Promise.all([started("ack", controlId), started("ack", transferId)]);
			gate("ack", transferId).finish.resolve();
			state = await until((rows) => rows[transferId].closed);
			assert.equal(state[controlId].closed, false);
			gate("ack", controlId).finish.resolve();
			await started("child", controlId);
			assert.equal((await snapshot())[controlId].closed, false);
			gate("child", controlId).finish.resolve();
			state = await until((rows) => rows[controlId].closed);
			for (const id of [controlId, transferId]) {
				assert.equal(state[id].executions, 1);
				assert.deepEqual(state[id].observations, [
					...[
						"business-return",
						"ack-start",
						"ack-end",
						...(id === controlId ? ["child"] : []),
					].map((stage) => ({ stage, scope: id, closed: false })),
					{ stage: "disconnect" },
				]);
			}

			for (const id of ["failed-receipt", "failed-ack", "failed-business"]) {
				const response = await execute(id);
				assert.equal(response.status, id === "failed-business" ? 502 : 200);
				await response.text();
				await started("receipt", id);
				assert.equal((await snapshot())[id].closed, false);
				gate("receipt", id).finish.resolve();
				if (id !== "failed-receipt") {
					await started("ack", id);
					assert.equal((await snapshot())[id].closed, false);
					gate("ack", id).finish.resolve();
				}
				state = await until((rows) => rows[id].closed);
				assert.equal(state[id].executions, 1);
				assert.equal(
					state[id].observations.filter(({ stage }) => stage === "disconnect").length,
					1,
				);
				for (const item of state[id].observations.filter(({ stage }) => stage !== "disconnect")) {
					assert.equal(item.scope, id);
					assert.equal(item.closed, false);
				}
			}

			const legacyId = "legacy";
			let returned = false;
			const legacyResponse = execute(legacyId, "legacy").then((response) => {
				returned = true;
				return response;
			});
			await started("receipt", legacyId);
			assert.equal(returned, false);
			gate("receipt", legacyId).finish.resolve();
			await started("ack", legacyId);
			assert.equal(returned, false);
			assert.equal((await snapshot())[legacyId].closed, false);
			gate("ack", legacyId).finish.resolve();
			assert.equal((await legacyResponse).status, 200);
			assert.equal((await snapshot())[legacyId].closed, true);
		} finally {
			cleaningUp = true;
			for (const current of gates.values()) current.finish.resolve();
			await runtime.dispose();
		}
	},
);
