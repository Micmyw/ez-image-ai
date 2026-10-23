import { signRequest } from "@repo/jobs/orchestration/auth";
import {
	env,
	SELF,
	evictDurableObject,
	runInDurableObject,
	runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import type { MediaJobEvents } from "./media-job-events";

const sockets: WebSocket[] = [];
const namespace = (env as Cloudflare.Env).MEDIA_JOB_EVENTS;
const notification = (jobId: string, character = "a") => ({
	eventId: `mju_${character.repeat(64)}`,
	jobId,
	version: "asset:output:g1:ready",
});
function nextMessage(socket: WebSocket): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Notification missing")), 2_000);
		socket.addEventListener(
			"message",
			(event) => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)));
			},
			{ once: true },
		);
	});
}
async function subscribe(jobId: string, protocol = false, latest: unknown = null) {
	const response = await SELF.fetch(
		`https://app.example/api/media/jobs/${jobId}/events${protocol ? "?protocol=2" : ""}`,
		{
			headers: { origin: "https://app.example", upgrade: "websocket", cookie: "session=owner" },
		},
	);
	expect(response.status).toBe(101);
	expect(response.webSocket).not.toBeNull();
	const socket = response.webSocket!;
	sockets.push(socket);
	const ready = nextMessage(socket);
	socket.accept();
	if (protocol) {
		const message = await ready;
		expect(message).toMatchObject({ type: "ready", jobId, protocol: 2, latest });
		expect((message as { expiresInMs: number }).expiresInMs).toBeGreaterThan(0);
		expect((message as { expiresInMs: number }).expiresInMs).toBeLessThanOrEqual(60_000);
	} else expect(await ready).toEqual({ type: "ready", jobId });
	return socket;
}
async function publish(value: ReturnType<typeof notification>) {
	const body = JSON.stringify(value);
	return SELF.fetch("https://app.example/internal/job-events", {
		method: "POST",
		body,
		headers: await signRequest(
			"test-only-32-character-shared-secret",
			"POST",
			"/internal/job-events",
			body,
		),
	});
}
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.close(1000, "Test finished");
});

describe("real workerd job notifications", () => {
	it.each([
		[1005, 1000],
		[1006, 1011],
		[1015, 1011],
		[1004, 1011],
		[1016, 1011],
		[2999, 1011],
		[5000, 1011],
		[1000, 1000],
		[1001, 1001],
		[1008, 1008],
		[1011, 1011],
		[4001, 4001],
	])("handles close status %s on a real socket using wire status %s", async (code, expected) => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId, true);
		const closed: number[] = [];
		socket.addEventListener("close", (event) => closed.push(event.code));
		await runInDurableObject(
			namespace.get(namespace.idFromName(`media-job:${jobId}`)),
			(instance: MediaJobEvents, state) => {
				// The close event's status is synthetic; close() validates a real workerd WebSocket.
				instance.webSocketClose(state.getWebSockets()[0]!, code);
			},
		);
		await expect.poll(() => closed).toEqual([expected]);
	});
	it("reconnects after a client close without status and keeps a single notification stream", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId, true);
		socket.close();
		const stub = namespace.get(namespace.idFromName(`media-job:${jobId}`));
		await expect
			.poll(() => runInDurableObject(stub, (_instance, state) => state.getWebSockets().length))
			.toBe(0);
		const reconnected = await subscribe(jobId, true);
		const messages: string[] = [];
		reconnected.addEventListener("message", (event) => {
			messages.push((JSON.parse(String(event.data)) as { type: string }).type);
		});
		const value = notification(jobId);
		const changed = nextMessage(reconnected);
		expect((await publish(value)).status).toBe(200);
		expect(await changed).toEqual({ type: "job-updated", ...value });
		const heartbeat = nextMessage(reconnected);
		reconnected.send(JSON.stringify({ type: "heartbeat", nonce: 1, cursor: value.eventId }));
		expect(await heartbeat).toMatchObject({ type: "heartbeat", nonce: 1, latest: value });
		expect(messages).toEqual(["job-updated", "heartbeat"]);
	});
	it("does not overwrite a publication while the first subscription is being initialized", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const value = notification(jobId);
		const [, result] = await Promise.all([subscribe(jobId), publish(value)]);
		expect(result.status).toBe(200);
		expect(
			await runInDurableObject(
				namespace.get(namespace.idFromName(`media-job:${jobId}`)),
				async (_instance, state) => state.storage.get("notification-state"),
			),
		).toMatchObject({ latest: value, recent: [value.eventId] });
	});
	it("keeps the 101 upgrade through canonical forwarding, request scope and subscription authorization", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId);
		const value = notification(jobId);
		const changed = nextMessage(socket);
		const response = await publish(value);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ persisted: true, eventId: value.eventId });
		expect(await changed).toEqual({ type: "job-updated", ...value });
		const state = await runInDurableObject(
			namespace.get(namespace.idFromName(`media-job:${jobId}`)),
			async (_instance, state) => state.storage.get("notification-state"),
		);
		expect(state).toMatchObject({ latest: value, recent: [value.eventId] });
	});
	it("delivers through hibernation and safely rebroadcasts duplicate recovery intents", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId);
		const stub = namespace.get(namespace.idFromName(`media-job:${jobId}`));
		await evictDurableObject(stub);
		const value = notification(jobId, "b");
		for (let count = 0; count < 2; count += 1) {
			const changed = nextMessage(socket);
			expect((await publish(value)).status).toBe(200);
			expect(await changed).toEqual({ type: "job-updated", ...value });
		}
		expect(
			await runInDurableObject(stub, async (_instance, state) =>
				state.storage.get("notification-state"),
			),
		).toMatchObject({ recent: [value.eventId] });
	});
	it("refreshes a connection established after the committed publication", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		expect((await publish(notification(jobId))).status).toBe(200);
		await subscribe(jobId);
	});
	it("replays the persisted final hint in the v2 handshake without a second event frame", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const value = notification(jobId);
		expect((await publish(value)).status).toBe(200);
		const socket = await subscribe(jobId, true, value);
		const response = nextMessage(socket);
		socket.send(JSON.stringify({ type: "heartbeat", nonce: 1, cursor: value.eventId }));
		expect(await response).toMatchObject({
			type: "heartbeat",
			protocol: 2,
			jobId,
			nonce: 1,
			latest: value,
		});
	});
	it("repairs persistence-before-broadcast loss after hibernation using an identity-only heartbeat", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId, true);
		const stub = namespace.get(namespace.idFromName(`media-job:${jobId}`));
		const value = notification(jobId, "b");
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("notification-state", {
				jobId,
				latest: value,
				recent: [value.eventId],
			});
		});
		await evictDurableObject(stub);
		const response = nextMessage(socket);
		socket.send(JSON.stringify({ type: "heartbeat", nonce: 1, cursor: null, jobId: "attacker" }));
		expect(await response).toMatchObject({ type: "heartbeat", jobId, latest: value, nonce: 1 });
	});
	it("does not let heartbeat traffic renew an expired authorization ticket", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId, true);
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
		);
		await runInDurableObject(
			namespace.get(namespace.idFromName(`media-job:${jobId}`)),
			(_instance, state) => {
				for (const connected of state.getWebSockets())
					connected.serializeAttachment({ jobId, protocol: 2, expiresAt: Date.now() - 1 });
			},
		);
		socket.send(
			JSON.stringify({ type: "heartbeat", nonce: 1, cursor: null, expiresAt: Date.now() + 60_000 }),
		);
		expect(await closed).toBe(4001);
	});
	it("bounds heartbeat traffic and keeps clients unable to publish a result", async () => {
		for (const malicious of [
			JSON.stringify({ type: "job-updated", ...notification("attacker") }),
			JSON.stringify({ type: "heartbeat", nonce: 1, cursor: "invalid" }),
			"x".repeat(257),
		]) {
			const jobId = `owner-${crypto.randomUUID()}`;
			const socket = await subscribe(jobId, true);
			const closed = new Promise<number>((resolve) =>
				socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
			);
			socket.send(malicious);
			expect(await closed).toBe(1008);
		}
		const socket = await subscribe(`owner-${crypto.randomUUID()}`, true);
		const response = nextMessage(socket);
		socket.send(JSON.stringify({ type: "heartbeat", nonce: 1, cursor: null }));
		await response;
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
		);
		socket.send(JSON.stringify({ type: "heartbeat", nonce: 2, cursor: null }));
		expect(await closed).toBe(1008);
	});
	it("requires reauthentication when a connection expires", async () => {
		const jobId = `owner-${crypto.randomUUID()}`;
		const socket = await subscribe(jobId);
		const closed = new Promise<number>((resolve) =>
			socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
		);
		const stub = namespace.get(namespace.idFromName(`media-job:${jobId}`));
		await runInDurableObject(stub, (_instance, state) => {
			for (const connected of state.getWebSockets())
				connected.serializeAttachment({ jobId, expiresAt: Date.now() - 1 });
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await closed).toBe(4001);
	});
	it("denies wrong owners, cross-origin requests and unsigned publications", async () => {
		const request = (jobId: string, origin = "https://app.example") =>
			SELF.fetch(`https://app.example/api/media/jobs/${jobId}/events`, {
				headers: { origin, upgrade: "websocket", cookie: "session=owner" },
			});
		expect((await request("other-job")).status).toBe(404);
		expect((await request("owner-job", "https://other.example")).status).toBe(403);
		expect(
			(
				await SELF.fetch("https://app.example/internal/job-events", {
					method: "POST",
					body: JSON.stringify(notification("owner-job")),
				})
			).status,
		).toBe(401);
	});
});
