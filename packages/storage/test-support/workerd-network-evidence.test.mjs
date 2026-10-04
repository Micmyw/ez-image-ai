import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertWorkerdNetworkDenied } from "./workerd-network-evidence.mjs";

const reference = "fixture-reference";
const message = `internal error; reference = ${reference}`;
const cause = "workerd: connect() blocked by restrictPeers()";
const record = (id = reference, reason = cause) => `${reason}\nstack: fixture; wdErrId = ${id}\n`;

function fixture() {
	const runtime = new EventEmitter();
	runtime.stderr = new PassThrough();
	let logs = "";
	runtime.stderr.on("data", (chunk) => {
		logs += chunk.toString();
	});
	return {
		runtime,
		assertDenied: () =>
			assertWorkerdNetworkDenied(message, { runtime, readLogs: () => logs, timeoutMs: 100 }),
		assertClean: () => {
			expect(runtime.eventNames()).toEqual([]);
			expect(runtime.stderr.listenerCount("data")).toBe(1);
			expect(runtime.stderr.listenerCount("end")).toBe(0);
			expect(runtime.stderr.listenerCount("close")).toBe(0);
			expect(runtime.stderr.listenerCount("error")).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("workerd network denial evidence", () => {
	it("accepts already collected matching denial evidence", async () => {
		vi.useFakeTimers();
		const test = fixture();
		test.runtime.stderr.write(record());
		await test.assertDenied();
		test.assertClean();
	});

	it("waits for delayed stderr without resending the request", async () => {
		vi.useFakeTimers();
		const test = fixture();
		const result = test.assertDenied();
		setTimeout(() => test.runtime.stderr.write(record()), 40);
		await vi.advanceTimersByTimeAsync(40);
		await result;
		test.assertClean();
	});

	it("waits for the entire matching ID and newline across chunks", async () => {
		vi.useFakeTimers();
		const test = fixture();
		const settled = vi.fn();
		const result = test.assertDenied().then(settled);
		test.runtime.stderr.write(`${cause}\nstack: fixture; wdErrId = fixture-`);
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		test.runtime.stderr.write("reference");
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		test.runtime.stderr.write("\n");
		await result;
		test.assertClean();
	});

	it.each(["different-reference", `${reference}-longer`])(
		"rejects denial evidence for another exact ID: %s",
		async (id) => {
			vi.useFakeTimers();
			const test = fixture();
			test.runtime.stderr.write(record(id));
			const result = expect(test.assertDenied()).rejects.toThrow(/deadline exceeded/);
			await vi.advanceTimersByTimeAsync(100);
			await result;
			test.assertClean();
		},
	);

	it("rejects a matching ID whose own cause is not network denial", async () => {
		vi.useFakeTimers();
		const test = fixture();
		test.runtime.stderr.write(record("other") + record(reference, "TLS handshake failed"));
		await expect(test.assertDenied()).rejects.toThrow();
		test.assertClean();
	});

	it.each(["", record().trimEnd()])(
		"times out when evidence is missing or truncated: %j",
		async (logs) => {
			vi.useFakeTimers();
			const test = fixture();
			test.runtime.stderr.write(logs);
			const result = expect(test.assertDenied()).rejects.toThrow(/deadline exceeded/);
			await vi.advanceTimersByTimeAsync(100);
			await result;
			test.assertClean();
		},
	);

	it.each(["runtime", "stderr-end", "stderr-close"])(
		"fails if %s closes before evidence arrives",
		async (target) => {
			vi.useFakeTimers();
			const test = fixture();
			const result = expect(test.assertDenied()).rejects.toThrow(/runtime or stderr closed/);
			if (target === "runtime") test.runtime.emit("close", 0);
			else test.runtime.stderr.emit(target === "stderr-end" ? "end" : "close");
			await result;
			test.assertClean();
		},
	);

	it("fails immediately if stderr was already destroyed", async () => {
		vi.useFakeTimers();
		const test = fixture();
		test.runtime.stderr.destroy();
		await expect(test.assertDenied()).rejects.toThrow(/runtime or stderr closed/);
		test.assertClean();
	});

	it.each(["runtime", "stderr"])("fails on a %s error while waiting", async (target) => {
		vi.useFakeTimers();
		const test = fixture();
		const result = expect(test.assertDenied()).rejects.toThrow("fixture stream failure");
		(target === "runtime" ? test.runtime : test.runtime.stderr).emit(
			"error",
			new Error("fixture stream failure"),
		);
		await result;
		test.assertClean();
	});

	it("keeps direct errors restricted to explicit denial causes", async () => {
		const test = fixture();
		const options = { runtime: test.runtime, readLogs: () => "" };
		await assertWorkerdNetworkDenied("Connection to private network is disallowed", options);
		await expect(assertWorkerdNetworkDenied("Connection timed out", options)).rejects.toThrow();
	});
});
