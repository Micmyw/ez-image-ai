import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
	loadScanlessBrowserModules,
	SCANLESS_JOB_EVENTS_MODULE,
	SCANLESS_NOTIFICATION_OBSERVATION_MODULE,
	SCANLESS_NOTIFICATION_OBSERVER_MODULE,
} from "./scanless-browser-modules";
import {
	createScanlessNotificationObservation,
	hasScanlessCommittedReadyReceipt,
	SCANLESS_NOTIFICATION_OBSERVATION_MS,
} from "./scanless-notification-observation";

const eventId = `mju_${"a".repeat(64)}`;
const ready = {
	type: "job-updated",
	jobId: "job-a",
	eventId,
	version: "asset:output:g1:ready",
};

class Socket {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	send(_data: string) {}
	message(message: unknown) {
		if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
	}
	close() {
		this.closed = true;
		this.onclose?.({ code: 1000 });
	}
}

async function settle() {
	for (let index = 0; index < 24; index++) await Promise.resolve();
}

for (const delivery of ["ready-received", "deadline"] as const)
	void test(`the served browser preserves visible evidence and independently ends notification observation: ${delivery}`, async (context) => {
		const modules = await loadScanlessBrowserModules();
		const load = async (route: string) => {
			const source = modules.get(route);
			return source
				? import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
				: {};
		};
		const product = await load(SCANLESS_JOB_EVENTS_MODULE);
		const adapter = await load(SCANLESS_NOTIFICATION_OBSERVER_MODULE);
		const observation = await load(SCANLESS_NOTIFICATION_OBSERVATION_MODULE);
		const source = await readFile(new URL("./scanless-runtime.mts", import.meta.url), "utf8");
		const inline = source.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
		assert(inline, "the actual harness inline browser program must exist");
		const script = inline
			.replace(/^import .*;\r?\n/gm, "")
			.replaceAll("${caseIndex}", "0")
			.replaceAll('${browserMode === "notifications"}', "true")
			.replaceAll("${browserPollMs}", "2000");
		assert(!script.includes("${"), "all server-side browser substitutions must be explicit");

		const epoch = 1_800_000_000_000;
		let monotonic = 100;
		let deadline: (() => void) | undefined;
		let timerCount = 0;
		const socket = new Socket();
		context.after(() => socket.close());
		let acknowledgeVisible!: (response: { ok: boolean }) => void;
		const visibleResponse = new Promise<{ ok: boolean }>((resolve) => {
			acknowledgeVisible = resolve;
		});
		const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
		const start = { onclick: undefined as (() => Promise<void>) | undefined };
		const image = {
			src: "",
			naturalWidth: 512,
			naturalHeight: 339,
			decode: async () => {},
			getBoundingClientRect: () => ({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				width: 512,
				height: 339,
				right: 512,
				bottom: 339,
			}),
		};
		runInNewContext(script, {
			connectMediaJobEvents: product.connectMediaJobEvents,
			connectScanlessJobNotifications: (input: Record<string, unknown>) =>
				adapter.connectScanlessJobNotifications({ ...input, createWebSocket: () => socket }),
			createScanlessNotificationObservation: (input?: Record<string, unknown>) =>
				observation.createScanlessNotificationObservation({
					...input,
					now: () => ({ at: epoch + monotonic, monotonic }),
					schedule: (callback: () => void, milliseconds: number) => {
						assert.equal(milliseconds, 1000);
						timerCount++;
						deadline = callback;
						return () => {
							deadline = undefined;
						};
					},
				}),
			document: { getElementById: (id: string) => (id === "start" ? start : image) },
			location: { origin: "http://127.0.0.1:9560" },
			innerWidth: 1024,
			innerHeight: 768,
			getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
			requestAnimationFrame: (callback: () => void) => callback(),
			Date: { now: () => epoch + monotonic },
			performance: {
				now: () => monotonic,
				getEntriesByType: () => [],
				getEntriesByName: () => [],
			},
			URL,
			setTimeout,
			clearTimeout,
			fetch: async (url: string, options?: { body?: string }) => {
				const path = url.split("?")[0];
				if (path === "/start") return { json: async () => ({ job: { id: "job-a" } }) };
				if (path === "/status") {
					socket.message({ type: "ready", jobId: "job-a" });
					return {
						json: async () => ({
							job: { id: "job-a", status: "RUNNING" },
							assets: [{ id: "output", preview: { url: "https://asset.example/output" } }],
						}),
					};
				}
				posts.push({ path: path!, body: JSON.parse(options?.body ?? "{}") });
				if (path === "/visible") return visibleResponse;
				return { ok: true };
			},
		});
		assert(start.onclick);
		const running = start.onclick();
		await settle();
		const visible = posts.find((post) => post.path === "/visible")?.body;
		assert(visible, JSON.stringify(posts));
		assert.equal(visible.visible, epoch + 100);
		assert.deepEqual(
			(visible.notifications as Array<{ type: string }>).map((message) => message.type),
			["ready"],
		);
		assert.equal(socket.closed, false);
		monotonic += delivery === "ready-received" ? 90 : 1000;
		if (delivery === "ready-received") socket.message(ready);
		else deadline!();
		await settle();
		assert.equal(
			socket.closed,
			true,
			"the visible POST cannot extend the socket observation window",
		);
		acknowledgeVisible({ ok: true });
		await running;
		const final = posts.find((post) => post.path === "/notification-observation")?.body;
		assert(final, "READY received after the visible snapshot must have independent final evidence");
		assert.equal(final.reason, delivery);
		const receipt = (final.notifications as Array<Record<string, unknown>>).find(
			(message) => message.eventId === eventId,
		);
		if (delivery === "ready-received") {
			assert.equal(receipt?.receivedAt, epoch + 190);
			assert.equal(receipt?.receivedMonotonic, 190);
		} else assert.equal(receipt, undefined);
		assert.equal(
			hasScanlessCommittedReadyReceipt({
				jobId: "job-a",
				eventId,
				version: ready.version,
				observation: final,
			}),
			delivery === "ready-received",
		);
		assert.equal(
			visible.visible,
			epoch + 100,
			"notification observation must not move visible time",
		);
		assert.equal(
			(visible.notifications as unknown[]).length,
			1,
			"preserve the original visible snapshot",
		);
		assert.equal(socket.closed, true);
		assert.equal(posts.filter((post) => post.path === "/notification-observation").length, 1);
		assert.equal(timerCount, 1);
		assert.equal(deadline, undefined);
	});

function observationFixture() {
	const epoch = 1_800_000_000_000;
	let monotonic = 100;
	const timers: Array<{ callback: () => void; milliseconds: number; cleared: boolean }> = [];
	const observer = createScanlessNotificationObservation({
		now: () => ({ at: epoch + monotonic, monotonic }),
		schedule: (callback, milliseconds) => {
			const timer = { callback, milliseconds, cleared: false };
			timers.push(timer);
			return () => {
				timer.cleared = true;
			};
		},
	});
	return {
		observer,
		timers,
		epoch,
		setTime: (time: number) => {
			monotonic = time;
		},
		wait: () =>
			observer.waitForReady({
				jobId: "job-a",
				assetId: "output",
				visibleAt: epoch + 100,
				visibleMonotonic: 100,
			}),
	};
}

void test("an actual READY already received before visible needs no extra timer", async () => {
	const f = observationFixture();
	f.setTime(80);
	f.observer.record(ready);
	f.setTime(100);
	const final = await f.wait();
	assert.equal(final.reason, "ready-received");
	assert.equal(final.notifications[0]!.receivedMonotonic, 80);
	assert.equal(final.endedMonotonic, 100);
	assert.equal(f.timers.length, 0);
	assert.equal(
		hasScanlessCommittedReadyReceipt({
			jobId: "job-a",
			eventId,
			version: ready.version,
			observation: final,
		}),
		true,
	);
});

void test("handshakes and other job, asset, or stage notifications cannot end READY observation", async () => {
	const f = observationFixture();
	const pending = f.wait();
	let finished = false;
	void pending.then(() => {
		finished = true;
	});
	for (const message of [
		{ type: "ready", jobId: "job-a" },
		{ ...ready, jobId: "job-b" },
		{ ...ready, version: "asset:other:g1:ready" },
		{ ...ready, version: "asset:output:g1:reviewing" },
		{ ...ready, eventId: "invalid" },
	])
		f.observer.record(message);
	await settle();
	assert.equal(finished, false);
	assert.equal(f.timers.length, 1);
	f.setTime(1100);
	f.timers[0]!.callback();
	const final = await pending;
	assert.equal(final.reason, "deadline");
	assert.equal(final.notifications.length, 5);
	assert.equal(final.windowMs, SCANLESS_NOTIFICATION_OBSERVATION_MS);
	assert.equal(f.timers[0]!.cleared, true);
});

void test("the observation deadline remains based on visible time, including late setup", async () => {
	const f = observationFixture();
	f.setTime(400);
	const pending = f.wait();
	assert.equal(f.timers[0]!.milliseconds, 700);
	f.setTime(1100);
	f.timers[0]!.callback();
	const final = await pending;
	assert.equal(final.startedMonotonic, 400);
	assert.equal(final.deadlineMonotonic, 1100);
	assert.equal(final.visibleMonotonic, 100);
});

void test("a delayed timer cannot admit a post-deadline READY and final receipts stay frozen", async () => {
	const f = observationFixture();
	const pending = f.wait();
	f.setTime(1101);
	f.observer.record(ready);
	const final = await pending;
	assert.equal(final.reason, "deadline");
	assert.equal(final.deadlineOverrunMs, 1);
	assert.equal(final.notifications[0]!.receivedMonotonic, 1101);
	assert.equal(
		hasScanlessCommittedReadyReceipt({
			jobId: "job-a",
			eventId,
			version: ready.version,
			observation: final,
		}),
		false,
	);
	f.setTime(1200);
	f.observer.record(ready);
	assert.equal(final.notifications.length, 1);
	assert.equal(f.timers[0]!.cleared, true);
});

void test("final evidence requires the exact committed event ID, version and actual receipt clocks", async () => {
	const f = observationFixture();
	const pending = f.wait();
	f.setTime(190);
	f.observer.record(ready);
	const final = await pending;
	const check = (observation: unknown, expectedEvent = eventId, version = ready.version) =>
		hasScanlessCommittedReadyReceipt({
			jobId: "job-a",
			eventId: expectedEvent,
			version,
			observation,
		});
	assert.equal(check(final), true);
	assert.equal(check(final, `mju_${"b".repeat(64)}`), false);
	assert.equal(check(final, eventId, "asset:output:g2:ready"), false);
	assert.equal(check({ ...final, notifications: [{ ...ready, status: "PROCESSED" }] }), false);
	assert.equal(check({ ...final, notifications: [{ type: "ready", jobId: "job-a" }] }), false);
	assert.equal(check(undefined), false);
	assert.equal(check({ ...final, reason: "deadline" }), false);
	assert.equal(check({ ...final, windowMs: 2000 }), false);
});

void test("cancellation clears the only deadline timer and never supplies successful receipt evidence", async () => {
	const f = observationFixture();
	const pending = f.wait();
	f.observer.cancel();
	const final = await pending;
	assert.equal(final.reason, "cancelled");
	assert.equal(f.timers.length, 1);
	assert.equal(f.timers[0]!.cleared, true);
	assert.throws(() => f.wait(), /ALREADY_STARTED/);
});
