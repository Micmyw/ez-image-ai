import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectMediaJobEvents, type JobEventsSocket } from "./job-events";
import { getJobPollingInterval } from "./job-status";

class Socket implements JobEventsSocket {
	onmessage: JobEventsSocket["onmessage"] = null;
	onclose: JobEventsSocket["onclose"] = null;
	onerror: JobEventsSocket["onerror"] = null;
	send = vi.fn();
	close = vi.fn();
	message(value: unknown) {
		this.onmessage?.({ data: JSON.stringify(value) });
	}
}
const notification = (id = "a") => ({
	type: "job-updated",
	jobId: "job",
	eventId: `mju_${id.repeat(64)}`,
	version: "ready",
});
function fixture(refresh = vi.fn(async () => {})) {
	const sockets: Socket[] = [];
	const urls: string[] = [];
	const health = vi.fn();
	const close = connectMediaJobEvents({
		jobId: "job",
		url: "wss://app.example/api/media/jobs/job/events",
		refresh,
		onHealthChange: health,
		createSocket: (url) => {
			urls.push(url);
			const socket = new Socket();
			sockets.push(socket);
			return socket;
		},
	});
	return { sockets, urls, close, refresh, health };
}
const ready = (latest: unknown = null, expiresInMs = 60_000) => ({
	type: "ready",
	protocol: 2,
	jobId: "job",
	expiresAt: Date.now() + expiresInMs,
	expiresInMs,
	latest,
});
function pong(socket: Socket, latest: unknown = null, expiresInMs = 60_000) {
	const request = JSON.parse(socket.send.mock.calls.at(-1)![0]);
	socket.message({ ...ready(latest, expiresInMs), type: "heartbeat", nonce: request.nonce });
}
beforeEach(() =>
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
	}),
);
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("result notifications in the browser", () => {
	it("adapts native browser events and stops their callbacks after cleanup", async () => {
		const transport = new Socket();
		vi.stubGlobal(
			"WebSocket",
			vi.fn(function WebSocket() {
				return transport;
			}),
		);
		const refresh = vi.fn(async () => {});
		const close = connectMediaJobEvents({
			jobId: "job",
			url: "wss://app.example/api/media/jobs/job/events",
			refresh,
		});
		transport.message({ type: "ready", jobId: "job" });
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(1);
		close();
		transport.message(notification());
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(transport.close).toHaveBeenCalledTimes(1);
	});
	it("refreshes on connect even when the job completed before subscription", async () => {
		const f = fixture();
		f.sockets[0]!.message({ type: "ready", jobId: "job" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		f.close();
	});
	it("deduplicates notifications and ignores a different job or malformed payload", async () => {
		const f = fixture();
		f.sockets[0]!.message(notification());
		f.sockets[0]!.message(notification());
		f.sockets[0]!.message({ ...notification("b"), jobId: "other" });
		f.sockets[0]!.message({ type: "job-updated", jobId: "job", url: "private-url" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		f.close();
	});
	it("retains a committed change received during an in-flight authorized read", async () => {
		let release!: () => void;
		const refresh = vi.fn(async () => {});
		refresh.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const f = fixture(refresh);
		f.sockets[0]!.message({ type: "ready", jobId: "job" });
		await Promise.resolve();
		f.sockets[0]!.message(notification());
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(2);
		f.close();
	});
	it("closes and cancels reconnect when the owner, page mode or visibility changes", async () => {
		const f = fixture();
		const oldMessage = f.sockets[0]!.onmessage;
		f.sockets[0]!.onclose?.({ code: 1006 });
		f.close();
		oldMessage?.({ data: JSON.stringify(notification()) });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.sockets).toHaveLength(1);
		expect(f.refresh).not.toHaveBeenCalled();
	});
	it("reauthenticates immediately on expiry and refreshes the new connection", async () => {
		const f = fixture();
		f.sockets[0]!.onclose?.({ code: 4001 });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.sockets).toHaveLength(2);
		f.sockets[1]!.message({ type: "ready", jobId: "job" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		f.close();
	});
	it("opts into v2 and merges a persisted handshake replay with duplicate broadcasts", async () => {
		const f = fixture();
		expect(f.urls).toEqual(["wss://app.example/api/media/jobs/job/events?protocol=2"]);
		f.sockets[0]!.message(ready(notification()));
		await vi.advanceTimersByTimeAsync(0);
		f.sockets[0]!.message(notification());
		pong(f.sockets[0]!, notification());
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		expect(JSON.parse(f.sockets[0]!.send.mock.calls[0]![0])).toMatchObject({
			type: "heartbeat",
			nonce: 1,
			cursor: notification().eventId,
		});
		expect(f.health).toHaveBeenLastCalledWith(true);
		f.close();
	});
	it("coalesces a broadcast racing ahead of the handshake without dropping a distinct in-flight commit", async () => {
		const f = fixture();
		f.sockets[0]!.message(notification());
		f.sockets[0]!.message(ready(notification()));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		f.close();
	});
	it("replays a persisted change missed by the broadcast and never trusts its payload as state", async () => {
		const f = fixture();
		f.sockets[0]!.message(ready());
		await vi.advanceTimersByTimeAsync(0);
		pong(f.sockets[0]!);
		await vi.advanceTimersByTimeAsync(5_000);
		pong(f.sockets[0]!, { ...notification(), url: "not-authorized-result-data" });
		await vi.advanceTimersByTimeAsync(0);
		expect(f.refresh).toHaveBeenCalledTimes(2);
		expect(f.refresh.mock.calls.every((args) => args.length === 0)).toBe(true);
		f.close();
	});
	it("requires both a successful authorized read and a matching heartbeat before becoming healthy", async () => {
		const refresh = vi.fn(async () => {}).mockRejectedValueOnce(new Error("unavailable"));
		const f = fixture(refresh);
		f.sockets[0]!.message(ready());
		await vi.advanceTimersByTimeAsync(0);
		pong(f.sockets[0]!);
		expect(f.health).not.toHaveBeenCalledWith(true);
		f.sockets[0]!.message(notification());
		await vi.advanceTimersByTimeAsync(0);
		expect(f.health).toHaveBeenLastCalledWith(true);
		f.close();
	});
	it("waits for the newer queued commit before certifying synchronization", async () => {
		let first!: () => void;
		let second!: () => void;
		const refresh = vi.fn(async () => {});
		refresh.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					first = resolve;
				}),
		);
		refresh.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					second = resolve;
				}),
		);
		const f = fixture(refresh);
		f.sockets[0]!.message(ready());
		pong(f.sockets[0]!);
		await Promise.resolve();
		f.sockets[0]!.message(notification());
		first();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(f.health).not.toHaveBeenCalledWith(true);
		second();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.health).toHaveBeenLastCalledWith(true);
		f.close();
	});
	it("refreshes immediately after a silent heartbeat timeout and ignores late old-socket frames", async () => {
		const f = fixture();
		const socket = f.sockets[0]!;
		socket.message(ready());
		await vi.advanceTimersByTimeAsync(0);
		pong(socket);
		const oldMessage = socket.onmessage;
		await vi.advanceTimersByTimeAsync(7_000);
		expect(f.health).toHaveBeenLastCalledWith(false);
		expect(f.refresh).toHaveBeenCalledTimes(2);
		expect(socket.close).toHaveBeenCalledTimes(1);
		oldMessage?.({ data: JSON.stringify(notification()) });
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.sockets).toHaveLength(2);
		expect(f.refresh).toHaveBeenCalledTimes(2);
		f.close();
	});
	it("does not accept an unsolicited or wrong-nonce heartbeat as health", async () => {
		const f = fixture();
		const socket = f.sockets[0]!;
		socket.message(ready());
		socket.message({ ...ready(), type: "heartbeat", nonce: 999 });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.health).not.toHaveBeenCalledWith(true);
		expect(socket.close).toHaveBeenCalledTimes(1);
		f.close();
	});
	it("does not let a heartbeat extend the ticket and reauthenticates when it expires", async () => {
		const f = fixture();
		f.sockets[0]!.message(ready(null, 1_000));
		pong(f.sockets[0]!, null, 60_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.sockets[0]!.close).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.sockets).toHaveLength(2);
		f.close();
	});
	it("keeps authoritative 2-second reads when healthy even if publication never reaches the hub", async () => {
		const f = fixture();
		f.sockets[0]!.message(ready());
		await vi.advanceTimersByTimeAsync(0);
		pong(f.sockets[0]!);
		const poll = vi.fn();
		const interval = getJobPollingInterval({ status: "PROVIDER_RUNNING", isDocumentVisible: true });
		expect(interval).toBe(2_000);
		const timer = setInterval(poll, interval as number);
		await vi.advanceTimersByTimeAsync(5_000);
		pong(f.sockets[0]!);
		await vi.advanceTimersByTimeAsync(5_000);
		pong(f.sockets[0]!);
		expect(poll).toHaveBeenCalledTimes(5);
		expect(f.refresh).toHaveBeenCalledTimes(1);
		expect(f.health).toHaveBeenLastCalledWith(true);
		clearInterval(timer);
		f.close();
	});
	it("does not send heartbeats to a legacy server and clears every task timer on cleanup", async () => {
		const f = fixture();
		f.sockets[0]!.message({ type: "ready", jobId: "job" });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.sockets[0]!.send).not.toHaveBeenCalled();
		expect(f.health).not.toHaveBeenCalledWith(true);
		f.close();
		expect(vi.getTimerCount()).toBe(0);
	});
});
