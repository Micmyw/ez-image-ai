import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { subscribeMediaJobEvents } from "../../../packages/api/modules/media/job-events-handler";
import {
	loadScanlessBrowserModules,
	SCANLESS_JOB_EVENTS_MODULE,
	SCANLESS_NOTIFICATION_OBSERVER_MODULE,
} from "./scanless-browser-modules";
import type { connectScanlessJobNotifications } from "./scanless-browser-notifications";
import { scanlessWebSocketClose } from "./scanless-subscription-bridge";

class Socket {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number; reason?: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	sent: string[] = [];
	send(data: string) {
		this.sent.push(data);
	}
	message(message: unknown) {
		if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) });
	}
	finish(code: number, reason: string) {
		if (this.closed) return;
		this.closed = true;
		this.onclose?.(scanlessWebSocketClose(code, reason));
	}
	close() {
		this.finish(1000, "");
	}
}

async function settle() {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function fixture(context: TestContext) {
	const modules = await loadScanlessBrowserModules();
	const load = (route: string) =>
		import(`data:text/javascript;base64,${Buffer.from(modules.get(route)!).toString("base64")}`);
	const product = await load(SCANLESS_JOB_EVENTS_MODULE);
	const observer = (await load(SCANLESS_NOTIFICATION_OBSERVER_MODULE)) as {
		connectScanlessJobNotifications: typeof connectScanlessJobNotifications;
	};
	context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const sockets: Socket[] = [];
	const notifications: Record<string, unknown>[] = [];
	const connections: Array<{ type: string; code?: number; reason?: string }> = [];
	const subscriptions: Array<{ user: string; job: string }> = [];
	const refreshOwners: string[] = [];
	let sessionOwner = "owner";
	let sessionReads = 0;
	let authorizedReads = 0;
	const pending: Promise<void>[] = [];
	const close = observer.connectScanlessJobNotifications({
		connect: product.connectMediaJobEvents,
		jobId: "job-a",
		url: "wss://app.example/api/media/jobs/job-a/events",
		onNotification: (message) => notifications.push(message),
		onConnection: (event) => connections.push(event),
		refresh: async () => {
			// Model the existing authorized status read, with no cached owner credential.
			authorizedReads++;
			if (sessionOwner === "owner") refreshOwners.push(sessionOwner);
		},
		createWebSocket: () => {
			const socket = new Socket();
			sockets.push(socket);
			pending.push(
				(async () => {
					const response = await subscribeMediaJobEvents(
						new Request("https://app.example/api/media/jobs/job-a/events?ownerId=owner", {
							headers: { origin: "https://app.example", upgrade: "websocket" },
						}),
						{
							getSession: async () => {
								sessionReads++;
								return {
									user: { id: sessionOwner },
									session: { expiresAt: new Date(Date.now() + 300_000) },
								};
							},
							ownsJob: async (user, job) => {
								subscriptions.push({ user, job });
								return user === "owner" && job === "job-a";
							},
							binding: {
								idFromName: (id) => id,
								get: () => ({
									fetch: async (request) => {
										const url = new URL(request.url);
										assert(!url.searchParams.has("ownerId"));
										const ttl = Number(url.searchParams.get("expiresAt")) - Date.now();
										assert.equal(ttl, 60_000);
										setTimeout(() => socket.finish(4001, "Reauthenticate"), ttl);
										return { status: 101 } as Response;
									},
								}),
							},
						},
					);
					if (response.status === 101) socket.message({ type: "ready", jobId: "job-a" });
					else socket.finish(1006, "Authorization rejected");
				})(),
			);
			return socket;
		},
	});
	context.after(close);
	await Promise.all(pending);
	await settle();
	return {
		sockets,
		notifications,
		connections,
		subscriptions,
		refreshOwners,
		close,
		changeOwner: (owner: string) => (sessionOwner = owner),
		sessionReads: () => sessionReads,
		authorizedReads: () => authorizedReads,
		settle: async () => {
			await Promise.all(pending);
			await settle();
		},
	};
}

void test("served production connector reauthorizes after 60-second TTL and receives later READY hints", async (context) => {
	const f = await fixture(context);
	assert.equal(f.sockets.length, 1);
	assert.equal(f.authorizedReads(), 1);
	context.mock.timers.tick(60_000);
	context.mock.timers.tick(0);
	await f.settle();
	assert.equal(f.sockets.length, 2);
	assert.equal(f.sessionReads(), 2);
	assert.deepEqual(f.subscriptions, [
		{ user: "owner", job: "job-a" },
		{ user: "owner", job: "job-a" },
	]);
	assert.equal(f.authorizedReads(), 3); // Expiry read and reconnect read cover different windows.
	f.sockets[1]!.message({
		type: "job-updated",
		jobId: "job-a",
		eventId: `mju_${"a".repeat(64)}`,
		version: "asset:output:g1:ready",
	});
	await f.settle();
	assert.equal(f.authorizedReads(), 4);
	assert(f.notifications.some((message) => message.type === "job-updated"));
	assert(f.connections.some((event) => event.code === 4001 && event.reason === "Reauthenticate"));
});

void test("abnormal close retains production backoff and refreshes on restored connection", async (context) => {
	const f = await fixture(context);
	f.sockets[0]!.finish(1006, "Connection lost");
	context.mock.timers.tick(999);
	await f.settle();
	assert.equal(f.sockets.length, 1);
	context.mock.timers.tick(1);
	await f.settle();
	assert.equal(f.sockets.length, 2);
	assert.equal(f.sessionReads(), 2);
	assert.equal(f.authorizedReads(), 3);
	assert(f.connections.some((event) => event.code === 1011 && event.reason === "Connection lost"));
});

void test("expired subscription cannot reuse a previous owner's authorization", async (context) => {
	const f = await fixture(context);
	f.changeOwner("other-owner");
	context.mock.timers.tick(60_000);
	context.mock.timers.tick(0);
	await f.settle();
	assert.equal(f.sessionReads(), 2);
	assert.deepEqual(f.subscriptions.at(-1), { user: "other-owner", job: "job-a" });
	assert.equal(f.authorizedReads(), 2); // The post-expiry read is reauthorized and rejected.
	assert.deepEqual(f.refreshOwners, ["owner"]);
	assert.equal(f.notifications.length, 1);
	f.close();
	context.mock.timers.tick(60_000);
	await f.settle();
	assert.equal(f.sockets.length, 2);
});

void test("bridge preserves legal close codes and UTF-8 reasons without sending reserved codes", () => {
	assert.deepEqual(scanlessWebSocketClose(4001, "Reauthenticate"), {
		code: 4001,
		reason: "Reauthenticate",
	});
	assert.deepEqual(scanlessWebSocketClose(1000, "finished"), { code: 1000, reason: "finished" });
	for (const code of [1005, 1006, 1015, 2000, undefined, NaN])
		assert.equal(scanlessWebSocketClose(code, "").code, 1011);
	const limited = scanlessWebSocketClose(4001, "重新认证".repeat(40));
	assert(new TextEncoder().encode(limited.reason).byteLength <= 123);
	assert(!limited.reason.includes("\uFFFD"));
});

void test("served v2 connector forwards heartbeats and labels replay separately from event delivery", async (context) => {
	const modules = await loadScanlessBrowserModules();
	const load = (route: string) =>
		import(`data:text/javascript;base64,${Buffer.from(modules.get(route)!).toString("base64")}`);
	const product = await load(SCANLESS_JOB_EVENTS_MODULE);
	const observer = (await load(SCANLESS_NOTIFICATION_OBSERVER_MODULE)) as {
		connectScanlessJobNotifications: typeof connectScanlessJobNotifications;
	};
	context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
	const socket = new Socket();
	const frames: Array<{ direction: string; kind: string; message: Record<string, unknown> }> = [];
	const notifications: Record<string, unknown>[] = [];
	const health: boolean[] = [];
	let reads = 0;
	const close = observer.connectScanlessJobNotifications({
		connect: product.connectMediaJobEvents,
		jobId: "job-a",
		url: "wss://app.example/api/media/jobs/job-a/events",
		createWebSocket: (url) => {
			assert.equal(new URL(url).searchParams.get("protocol"), "2");
			return socket;
		},
		refresh: async () => {
			reads++;
		},
		onNotification: (message) => notifications.push(message),
		onProtocolFrame: (frame) => frames.push(frame),
		onHealthChange: (healthy) => health.push(healthy),
		onConnection: () => {},
	});
	context.after(close);
	const latest = {
		eventId: `mju_${"a".repeat(64)}`,
		jobId: "job-a",
		version: "asset:output:g1:ready",
	};
	const ticket = {
		protocol: 2,
		jobId: "job-a",
		expiresAt: Date.now() + 60_000,
		expiresInMs: 60_000,
	};
	socket.message({ type: "ready", ...ticket, latest });
	assert.equal(socket.sent.length, 1);
	const first = JSON.parse(socket.sent[0]!);
	assert.deepEqual(first, { type: "heartbeat", nonce: 1, cursor: latest.eventId });
	socket.message({ type: "heartbeat", ...ticket, nonce: first.nonce, latest });
	await settle();
	assert.equal(reads, 1);
	assert.deepEqual(health, [true]);
	assert.equal(notifications.filter((message) => message.type === "job-updated").length, 0);
	assert.equal(frames.filter((frame) => frame.kind === "replay").length, 2);
	context.mock.timers.tick(5_000);
	assert.equal(socket.sent.length, 2);
	const second = JSON.parse(socket.sent[1]!);
	const missed = { ...latest, eventId: `mju_${"b".repeat(64)}`, version: "job:2:succeeded" };
	socket.message({ type: "heartbeat", ...ticket, nonce: second.nonce, latest: missed });
	await settle();
	assert.equal(reads, 2, "heartbeat replay repairs a missed revision with a fresh authorized read");
	assert.equal(notifications.filter((message) => message.type === "job-updated").length, 0);
	assert.deepEqual(
		frames.filter((frame) => frame.kind === "replay").at(-1)!.message.latest,
		missed,
	);
});
