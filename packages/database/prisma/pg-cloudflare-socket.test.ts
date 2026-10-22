import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const pgRequire = createRequire(require.resolve("pg"));
const packageDirectory =
	process.env.PG_CLOUDFLARE_TEST_PACKAGE_DIR ??
	path.dirname(pgRequire.resolve("pg-cloudflare/package.json"));
const { CloudflareSocket } = require(path.join(packageDirectory, "dist/index.js"));

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const drainMicrotasks = async () => {
	for (let index = 0; index < 30; index++) await Promise.resolve();
};

function fixture(
	options: { automatic?: boolean; fail?: Error; throwWrite?: Error } = {},
	Socket = CloudflareSocket,
) {
	const writes: Array<{ stage: string; bytes: Buffer; done: ReturnType<typeof deferred> }> = [];
	const events: string[] = [];
	const makeNativeSocket = (stage: string) => {
		const writer = {
			desiredSize: -1,
			ready: Promise.resolve(),
			write(bytes: Uint8Array) {
				if (options.throwWrite) throw options.throwWrite;
				const done = deferred();
				writes.push({ stage, bytes: Buffer.from(bytes), done });
				if (options.fail) done.reject(options.fail);
				else if (options.automatic) done.resolve();
				return done.promise;
			},
			releaseLock: () => events.push(`${stage}:writer-release`),
		};
		const reader = {
			read: () => new Promise(() => {}),
			releaseLock: () => events.push(`${stage}:reader-release`),
		};
		return {
			closed: new Promise(() => {}),
			writable: { getWriter: () => writer },
			readable: { getReader: () => reader },
			close: () => {
				events.push(`${stage}:close`);
				return Promise.resolve();
			},
			startTls: (input: unknown) => {
				events.push(`${stage}:start-tls:${JSON.stringify(input)}`);
				return makeNativeSocket("tls");
			},
		};
	};
	const socket = new Socket(false);
	socket._cfSocket = makeNativeSocket("plain");
	socket._cfWriter = socket._cfSocket.writable.getWriter();
	socket._cfReader = socket._cfSocket.readable.getReader();
	socket.writable = true;
	return { socket, writes, events };
}

afterEach(() => vi.restoreAllMocks());

describe("patched pg-cloudflare socket protocol boundaries", () => {
	it("publishes the same class through workerd CommonJS/ESM and matching declarations", async () => {
		const esm = await import(pathToFileURL(path.join(packageDirectory, "esm/index.mjs")).href);
		const alternate = fixture({ automatic: true }, esm.CloudflareSocket);
		alternate.socket.cork();
		alternate.socket.write("esm");
		alternate.socket.write("-entry");
		alternate.socket.uncork();
		expect(alternate.writes.map((write) => write.bytes.toString())).toEqual(["esm-entry"]);
		expect(typeof CloudflareSocket.prototype.cork).toBe("function");
		expect(typeof CloudflareSocket.prototype.uncork).toBe("function");
		const declaration = await readFile(path.join(packageDirectory, "dist/index.d.ts"), "utf8");
		expect(declaration).toContain("cork(): void");
		expect(declaration).toContain("uncork(): void");
		expect(declaration).toContain("BufferEncoding | WriteCallback");
		const source = await readFile(path.join(packageDirectory, "src/index.ts"), "utf8");
		expect(source).toContain("MAX_CORK_BYTES = 64 * 1024");
		expect(source).toContain("MAX_CORK_WRITES = 64");
		const defaultEntry = pgRequire("pg-cloudflare");
		expect(defaultEntry.default ?? defaultEntry).toEqual({});
		expect(defaultEntry.CloudflareSocket).toBeUndefined();
	});

	it("keeps uncorked submission immediate and waits for native completion without inventing drain", async () => {
		const { socket, writes } = fixture();
		const callback = vi.fn();
		const onDrain = vi.fn();
		socket.on("drain", onDrain);
		expect(socket.write(Buffer.from("query"), callback)).toBe(true);
		expect(writes).toHaveLength(1);
		await drainMicrotasks();
		expect(callback).not.toHaveBeenCalled();
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(callback).toHaveBeenCalledExactlyOnceWith();
		expect(onDrain).not.toHaveBeenCalled();
	});

	it("combines a synchronous protocol group, copying serializer scratch bytes", async () => {
		const { socket, writes, events } = fixture();
		const scratch = Buffer.from("parse");
		socket.cork();
		socket.write(scratch, () => events.push("parse"));
		scratch.fill(120);
		for (const frame of ["bind", "describe", "execute", "sync"])
			socket.write(frame, "utf8", () => events.push(frame));
		await drainMicrotasks();
		expect(writes).toHaveLength(0);
		socket.uncork();
		expect(writes.map((write) => write.bytes.toString())).toEqual(["parsebinddescribeexecutesync"]);
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(events).toEqual(["parse", "bind", "describe", "execute", "sync"]);
	});

	it("flushes nested cork only when its outer group ends", async () => {
		const { socket, writes } = fixture({ automatic: true });
		socket.cork();
		socket.cork();
		socket.write("nested");
		socket.uncork();
		expect(writes).toHaveLength(0);
		socket.uncork();
		expect(writes).toHaveLength(1);
		socket.uncork();
		expect(writes).toHaveLength(1);
		await drainMicrotasks();
	});

	it("keeps buffers independent for different sockets and request-owned connections", () => {
		const first = fixture({ automatic: true });
		const second = fixture({ automatic: true });
		first.socket.cork();
		second.socket.cork();
		first.socket.write("first");
		second.socket.write("second");
		first.socket.uncork();
		expect(first.writes[0]?.bytes.toString()).toBe("first");
		expect(second.writes).toHaveLength(0);
		second.socket.uncork();
		expect(second.writes[0]?.bytes.toString()).toBe("second");
	});

	it("bounds bytes and frame count while preserving large-frame and overflow order", async () => {
		const { socket, writes } = fixture({ automatic: true });
		const chunks = [
			Buffer.alloc(32_768, 1),
			Buffer.alloc(32_768, 2),
			Buffer.alloc(32_768, 3),
			Buffer.alloc(90_000, 4),
			...Array.from({ length: 130 }, (_, index) => Buffer.from([index])),
		];
		socket.cork();
		for (const chunk of chunks) {
			expect(socket.write(chunk)).toBe(true);
			expect(socket._corkBytes).toBeLessThanOrEqual(65_536);
			expect(socket._corkBuffers.length).toBeLessThanOrEqual(64);
		}
		socket.uncork();
		await drainMicrotasks();
		expect(writes.map((write) => write.bytes.length)).toEqual([65_536, 32_768, 90_000, 64, 64, 2]);
		expect(Buffer.concat(writes.map((write) => write.bytes))).toEqual(Buffer.concat(chunks));
	});

	it.each([false, true])(
		"delivers a native %s synchronous write failure to each callback and end once",
		async (synchronous) => {
			const failure = new Error("write failed");
			const { socket, events } = fixture(synchronous ? { throwWrite: failure } : { fail: failure });
			const first = vi.fn(() => events.push("first"));
			const second = vi.fn(() => events.push("second"));
			const end = vi.fn(() => events.push("end"));
			socket.cork();
			socket.write("one", first);
			socket.write("two", second);
			socket.end(Buffer.alloc(0), end);
			await drainMicrotasks();
			expect(first).toHaveBeenCalledExactlyOnceWith(failure);
			expect(second).toHaveBeenCalledExactlyOnceWith(failure);
			expect(end).toHaveBeenCalledExactlyOnceWith(failure);
			expect(events).toEqual(["first", "second", "plain:close", "end"]);
		},
	);

	it("does not close an empty end until its flushed bytes and all write callbacks complete", async () => {
		const { socket, writes, events } = fixture();
		socket.cork();
		socket.write("held", () => events.push("write"));
		socket.end(Buffer.alloc(0), () => events.push("end"));
		socket.end(Buffer.alloc(0), () => events.push("second-end"));
		await drainMicrotasks();
		expect(writes).toHaveLength(1);
		expect(events).toEqual([]);
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(events).toEqual(["write", "plain:close", "end", "second-end"]);
	});

	it("propagates an earlier error across separate cork groups and closes only once", async () => {
		const { socket, writes, events } = fixture();
		const failure = new Error("earlier write");
		const first = vi.fn();
		const second = vi.fn();
		const ended = vi.fn();
		socket.cork();
		socket.write("first", first);
		socket.uncork();
		socket.cork();
		socket.write("second", second);
		socket.uncork();
		socket.end(Buffer.alloc(0), ended);
		writes[1]!.done.resolve();
		await drainMicrotasks();
		expect(second).not.toHaveBeenCalled();
		writes[0]!.done.reject(failure);
		await drainMicrotasks();
		expect(first).toHaveBeenCalledExactlyOnceWith(failure);
		expect(second).toHaveBeenCalledExactlyOnceWith(failure);
		expect(ended).toHaveBeenCalledExactlyOnceWith(failure);
		expect(events).toEqual(["plain:close"]);
	});

	it("can end from inside a write callback without a completion promise cycle", async () => {
		const { socket, writes, events } = fixture();
		socket.cork();
		socket.write("frame", () => {
			events.push("write");
			socket.end(Buffer.alloc(0), () => events.push("end"));
		});
		socket.uncork();
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(events).toEqual(["write", "plain:close", "end"]);
	});

	it("waits for earlier native writes even when a later final write settles first", async () => {
		const { socket, writes, events } = fixture();
		socket.write("before", () => events.push("before"));
		socket.cork();
		socket.write("held", () => events.push("held"));
		socket.end(Buffer.from("last"), () => events.push("end"));
		expect(writes.map((write) => write.bytes.toString())).toEqual(["before", "held", "last"]);
		writes[2]!.done.resolve();
		writes[1]!.done.resolve();
		await drainMicrotasks();
		expect(events).toEqual([]);
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(events).toEqual(["before", "held", "plain:close", "end"]);
	});

	it("cancels unsent corked bytes on destroy and rejects later writes without native submission", async () => {
		const { socket, writes, events } = fixture();
		const failure = new Error("cancelled");
		const callback = vi.fn();
		const after = vi.fn();
		socket.cork();
		socket.write("unsent", callback);
		socket.destroy(failure);
		socket.destroy(failure);
		expect(socket.write("after", after)).toBe(false);
		socket.uncork();
		await drainMicrotasks();
		expect(writes).toHaveLength(0);
		expect(callback).toHaveBeenCalledExactlyOnceWith(failure);
		expect(after).toHaveBeenCalledOnce();
		expect(events).toEqual(["plain:close"]);
	});

	it("completes remaining callbacks if one consumer callback throws", async () => {
		const queued: VoidFunction[] = [];
		vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => queued.push(callback));
		const { socket, writes } = fixture();
		const failure = new Error("caller callback");
		const next = vi.fn();
		socket.cork();
		socket.write("one", () => {
			throw failure;
		});
		socket.write("two", next);
		socket.uncork();
		writes[0]!.done.resolve();
		await drainMicrotasks();
		expect(next).toHaveBeenCalledExactlyOnceWith();
		expect(queued).toHaveLength(1);
		expect(queued[0]).toThrow(failure);
	});

	it("retains TLS upgrade and switches native writers without carrying buffered plaintext across it", async () => {
		const { socket, writes, events } = fixture();
		socket.cork();
		socket.write("plain");
		expect(() => socket.startTls({ servername: "fixture.invalid" })).toThrow("buffered plaintext");
		socket.uncork();
		writes[0]!.done.resolve();
		await drainMicrotasks();
		socket.startTls({ servername: "fixture.invalid" });
		socket.cork();
		socket.write("encrypted");
		socket.uncork();
		writes[1]!.done.resolve();
		await drainMicrotasks();
		expect(writes.map((write) => [write.stage, write.bytes.toString()])).toEqual([
			["plain", "plain"],
			["tls", "encrypted"],
		]);
		expect(events).toEqual([
			"plain:writer-release",
			"plain:reader-release",
			'plain:start-tls:{"servername":"fixture.invalid"}',
		]);
	});

	it("preserves an empty write callback without submitting a native frame", () => {
		const { socket, writes } = fixture();
		const callback = vi.fn();
		socket.write(Buffer.alloc(0), callback);
		expect(callback).toHaveBeenCalledExactlyOnceWith();
		expect(writes).toHaveLength(0);
	});
});
