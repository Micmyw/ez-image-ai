import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(
	require.resolve("@opennextjs/cloudflare/durable-objects/queue"),
	"utf8",
);
// Execute the installed (pnpm-patched) implementation. Only the Workers base
// class and logging imports are substituted; SQL runs against real SQLite.
const body = source
	.replace(/^import .*;\r?\n/gm, "")
	.replace("export class DOQueueHandler", "class DOQueueHandler");
class DurableObject {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
class OpenNextError extends Error {}
const noop = () => {};
const Queue = runInNewContext(`${body}\nDOQueueHandler;`, {
	DurableObject,
	debug: noop,
	error: noop,
	warn: noop,
	FatalError: OpenNextError,
	IgnorableError: OpenNextError,
	RecoverableError: OpenNextError,
	isOpenNextError: (error) => error instanceof OpenNextError,
	process: { env: { __OPEN_NEXT_BUILD_ID: "cache-alarm-regression" } },
	AbortSignal,
});

function message(id = "route-a") {
	return {
		MessageDeduplicationId: id,
		MessageBody: { host: "example.test", url: `/${id}`, lastModified: 0 },
	};
}

function fixture(t, disableSQLite = false) {
	const database = new DatabaseSync(":memory:");
	t.after(() => database.close());
	let alarm = null;
	let calls = 0;
	let status = 500;
	let revalidated = true;
	const sql = {
		exec(query, ...args) {
			const statement = database.prepare(query);
			let rows = [];
			if (query.startsWith("SELECT")) rows = statement.all(...args);
			else statement.run(...args);
			return Object.assign(rows, { toArray: () => rows });
		},
	};
	return {
		database,
		get alarm() {
			return alarm;
		},
		get calls() {
			return calls;
		},
		rows: () => database.prepare("SELECT COUNT(*) AS n FROM failed_state").get().n,
		respond(code, cacheHeader = true) {
			status = code;
			revalidated = cacheHeader;
		},
		async boot() {
			let initialized = Promise.resolve();
			const queue = new Queue(
				{
					storage: {
						sql,
						getAlarm: async () => alarm,
						setAlarm: async (time) => {
							alarm = time;
						},
						deleteAlarm: async () => {
							alarm = null;
						},
					},
					blockConcurrencyWhile: (callback) => {
						initialized = callback();
					},
					waitUntil: noop,
				},
				{
					NEXT_CACHE_DO_QUEUE_DISABLE_SQLITE: String(disableSQLite),
					WORKER_SELF_REFERENCE: {
						fetch: async () => {
							calls++;
							return new Response(null, {
								status,
								headers: revalidated ? { "x-nextjs-cache": "REVALIDATED" } : {},
							});
						},
					},
				},
			);
			await initialized;
			return queue;
		},
		async fire(queue) {
			alarm = null;
			await queue.alarm();
		},
	};
}

for (const [name, code, header] of [
	["success", 200, true],
	["removed page", 404, true],
	["unrevalidatable page", 200, false],
]) {
	await test(`${name} deletes persisted failures and cannot revive after cold starts`, async (t) => {
		const f = fixture(t);
		let queue = await f.boot();
		await queue.executeRevalidation(message());
		assert.equal(f.rows(), 1);
		f.respond(code, header);
		await f.fire(queue);
		assert.equal(f.rows(), 0);
		assert.equal(f.alarm, null);
		for (let restart = 0; restart < 3; restart++) {
			queue = await f.boot();
			assert.equal(queue.routeInFailedState.size, 0);
			assert.equal(f.alarm, null);
			await f.fire(queue); // A previously delivered alarm may still run.
		}
		assert.equal(f.calls, 2);
	});
}

await test("exhausted retries are removed durably, including a cold start before the last retry", async (t) => {
	const f = fixture(t);
	let queue = await f.boot();
	await queue.executeRevalidation(message());
	for (let retry = 0; retry < 5; retry++) await f.fire(queue);
	assert.equal(f.rows(), 1);
	queue = await f.boot();
	await f.fire(queue);
	assert.equal(f.calls, 7);
	assert.equal(f.rows(), 0);
	queue = await f.boot();
	assert.equal(f.alarm, null);
	await f.fire(queue);
	assert.equal(f.calls, 7);
});

await test("settling the last failure cancels an already scheduled alarm", async (t) => {
	const f = fixture(t);
	const queue = await f.boot();
	await queue.executeRevalidation(message());
	assert.notEqual(f.alarm, null);
	f.respond(200);
	await queue.executeRevalidation(message());
	assert.equal(f.alarm, null);
	assert.equal(f.rows(), 0);
});

await test("settling one route preserves another route's persisted retry and alarm", async (t) => {
	const f = fixture(t);
	const queue = await f.boot();
	await queue.executeRevalidation(message("a"));
	await queue.executeRevalidation(message("b"));
	const pendingAlarm = f.alarm;
	f.respond(200);
	await queue.executeRevalidation(message("a"));
	assert.equal(f.rows(), 1);
	assert.equal(f.alarm, pendingAlarm);
	const restored = await f.boot();
	assert.deepEqual([...restored.routeInFailedState.keys()], ["b"]);
	await f.fire(restored);
	assert.equal(f.rows(), 0);
});

await test("transient failures still persist their counter and back off across restarts", async (t) => {
	const f = fixture(t);
	let queue = await f.boot();
	await queue.executeRevalidation(message());
	queue = await f.boot();
	await f.fire(queue);
	const record = JSON.parse(f.database.prepare("SELECT data FROM failed_state").get().data);
	assert.equal(record.retryCount, 2);
	assert.ok(record.nextAlarmMs > Date.now());
	assert.equal(f.rows(), 1);
	assert.notEqual(f.alarm, null);
});

await test("SQLite-disabled mode still clears memory and the pending alarm", async (t) => {
	const f = fixture(t, true);
	const queue = await f.boot();
	await queue.executeRevalidation(message());
	f.respond(200);
	await queue.executeRevalidation(message());
	assert.equal(queue.routeInFailedState.size, 0);
	assert.equal(f.alarm, null);
});
