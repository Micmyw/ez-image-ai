import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withinScanlessDeadline } from "./scanless-deadline";
import {
	createScanlessSubscriptionNamespace,
	SCANLESS_DRIVER_WORKER,
} from "./scanless-subscription-bridge";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const app = path.join(root, "apps/workflows");
const output = path.resolve(process.env.SCANLESS_ARTIFACT ?? path.join(app, "dist-workers"));
const wr = createRequire(realpathSync(path.join(app, "node_modules/wrangler/package.json")));
const { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
const wasm = (await readdir(output)).filter((name) => name.endsWith(".wasm"));
let fixtureStarted = false;
let fixtureCompleted = false;
let heartbeat = false;
let resolveFixtureStarted!: () => void;
const fixtureStart = new Promise<void>((resolve) => {
	resolveFixtureStarted = resolve;
});
const runtime = new Miniflare(
	convertV4MiniflareOptions({
		workers: [
			{
				name: "driver",
				modules: true,
				script: SCANLESS_DRIVER_WORKER,
				compatibilityDate: "2026-09-10",
				durableObjects: {
					MEDIA_JOB_EVENTS: { className: "MediaJobEvents", scriptName: "jobs", useSQLite: true },
				},
				serviceBindings: { ENTRY: "jobs" },
				outboundService: async (request: Request) => {
					assert.equal(request.url, "https://scanless-fixture.invalid/wait");
					fixtureStarted = true;
					resolveFixtureStarted();
					await new Promise((resolve) => setTimeout(resolve, 100));
					fixtureCompleted = true;
					return new Response("fixture completed");
				},
			},
			{
				name: "jobs",
				compatibilityDate: "2026-09-10",
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				modulesRoot: output,
				modules: [
					{ type: "ESModule", path: path.join(output, "workers.js") },
					...wasm.map((name) => ({ type: "CompiledWasm", path: path.join(output, name) })),
				],
				durableObjects: { MEDIA_JOB_EVENTS: { className: "MediaJobEvents", useSQLite: true } },
			},
		],
	}),
);
const sockets: Array<{ close(code: number): void }> = [];
try {
	await runtime.ready;
	const namespace = createScanlessSubscriptionNamespace((url, init) =>
		runtime.dispatchFetch(url, init),
	);
	const pendingFixture: Promise<Response> = runtime.dispatchFetch(
		"http://scanless.invalid/__scanless/fixture-loopback",
	);
	await withinScanlessDeadline("fixture-started", fixtureStart, 5000);
	assert(!fixtureCompleted, "Fixture must still be pending when subscriptions start");
	const heartbeatTimer = setTimeout(() => {
		heartbeat = true;
	}, 25);
	const responses = await withinScanlessDeadline(
		"concurrent-subscriptions",
		Promise.all(
			Array.from({ length: 50 }, (_, index) => {
				const jobId = `probe-${index}`;
				return namespace
					.get(namespace.idFromName(`media-job:${jobId}`))
					.fetch(
						new Request(
							`https://media-job-events.internal/subscribe?jobId=${jobId}&expiresAt=${Date.now() + 60_000}`,
							{ headers: { upgrade: "websocket" } },
						),
					);
			}),
		),
		5000,
	);
	const ready = await withinScanlessDeadline(
		"real-do-ready-messages",
		Promise.all(
			responses.map((response, index) => {
				assert.equal(response.status, 101);
				const socket = (
					response as unknown as {
						webSocket: {
							accept(): void;
							close(code: number): void;
							addEventListener(type: string, callback: (event: { data: string }) => void): void;
						};
					}
				).webSocket;
				assert(socket);
				sockets.push(socket);
				return new Promise<string>((resolve) => {
					socket.addEventListener("message", (event) => {
						const message = JSON.parse(event.data);
						assert.equal(message.type, "ready");
						assert.equal(message.jobId, `probe-${index}`);
						resolve(message.jobId);
					});
					socket.accept();
				});
			}),
		),
		5000,
	);
	assert.equal(
		await (await withinScanlessDeadline("outbound-fixture", pendingFixture, 5000)).text(),
		"fixture completed",
	);
	clearTimeout(heartbeatTimer);
	assert(fixtureStarted && fixtureCompleted && heartbeat);
	assert.equal(ready.length, 50);
	const result = {
		rootPid: process.pid,
		subscriptions: ready.length,
		realDurableObjectReadyMessages: ready.length,
		fixtureStarted,
		fixtureCompleted,
		fixturePendingAtSubscriptionStart: true,
		nodeTimerProgressed: heartbeat,
		scope:
			"Test transport regression using frozen production DO; no database, model or full-SaaS performance claim.",
	};
	await writeFile(
		path.join(
			root,
			".cache/generation-one-second-20261022",
			`${process.env.SCANLESS_LABEL ?? "bridge-probe"}-probe-result.json`,
		),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result));
} finally {
	for (const socket of sockets) socket.close(1000);
	await withinScanlessDeadline("probe-runtime-dispose", runtime.dispose(), 3000);
}
