import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPACITY_WAIT_MS, ExecutionCapacity, parseCapacityWait } from "./capacity";

const heavy = { queue: "heavy", concurrency: 1 };
afterEach(() => vi.useRealTimers());

describe("release driven bounded executor admission", () => {
	it("reserves a released slot for the waiter before another request can steal it", async () => {
		const capacity = new ExecutionCapacity(1);
		const first = await capacity.acquire(heavy);
		const next = capacity.acquire(heavy, CAPACITY_WAIT_MS);
		expect(capacity.active).toBe(1);
		expect(capacity.waiting).toBe(1);
		first.release!();
		expect(capacity.active).toBe(1);
		expect((await capacity.acquire(heavy)).release).toBeNull();
		const admitted = await next;
		expect(admitted.waited).toBe(true);
		expect(capacity.waiting).toBe(0);
		admitted.release!();
		admitted.release!();
		expect(capacity.active).toBe(0);
	});
	it("retains queue limits and admits another eligible queue without head of line blocking", async () => {
		const capacity = new ExecutionCapacity(2);
		const first = await capacity.acquire(heavy);
		const second = await capacity.acquire({ queue: "other", concurrency: 1 });
		const heavyWaiter = capacity.acquire(heavy, CAPACITY_WAIT_MS);
		const otherWaiter = capacity.acquire({ queue: "other", concurrency: 1 }, CAPACITY_WAIT_MS);
		second.release!();
		const other = await otherWaiter;
		expect(capacity.waiting).toBe(1);
		expect(capacity.active).toBe(2);
		other.release!();
		expect(capacity.active).toBe(1);
		first.release!();
		(await heavyWaiter).release!();
		expect(capacity.active).toBe(0);
	});
	it("expires bounded waiting without stealing or releasing active execution", async () => {
		vi.useFakeTimers();
		const capacity = new ExecutionCapacity(1);
		const running = await capacity.acquire(heavy);
		const pending = capacity.acquire(heavy, 50);
		await vi.advanceTimersByTimeAsync(50);
		expect(await pending).toEqual({ release: null, waited: true });
		expect(capacity.waiting).toBe(0);
		expect(capacity.active).toBe(1);
		running.release!();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels only waiting requests, keeping admitted work until actual completion", async () => {
		const capacity = new ExecutionCapacity(1);
		const runningAbort = new AbortController();
		const running = await capacity.acquire(heavy, 100, runningAbort.signal);
		const waitingAbort = new AbortController();
		const waiting = capacity.acquire(heavy, 100, waitingAbort.signal);
		runningAbort.abort();
		waitingAbort.abort();
		expect(await waiting).toEqual({ release: null, waited: true });
		expect(capacity.active).toBe(1);
		expect(capacity.waiting).toBe(0);
		expect(await capacity.acquire(heavy, 100, waitingAbort.signal)).toEqual({
			release: null,
			waited: false,
		});
		running.release!();
	});
	it("bounds waiter memory and clears all listeners after cancellation", async () => {
		vi.useFakeTimers();
		const capacity = new ExecutionCapacity(1);
		const running = await capacity.acquire(heavy);
		const aborts = Array.from({ length: 128 }, () => new AbortController());
		const pending = aborts.map((abort) => capacity.acquire(heavy, CAPACITY_WAIT_MS, abort.signal));
		expect(capacity.waiting).toBe(128);
		expect(await capacity.acquire(heavy, CAPACITY_WAIT_MS)).toEqual({
			release: null,
			waited: false,
		});
		aborts.forEach((abort) => abort.abort());
		await Promise.all(pending);
		expect(capacity.waiting).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		running.release!();
	});
	it.each([-1, 25_001, 0.1, "100", null, NaN, Infinity])(
		"rejects unbounded/invalid waiting %s",
		(value) => {
			expect(() => parseCapacityWait(value)).toThrow("INVALID_CAPACITY_WAIT");
		},
	);
	it("defaults old callers to immediate admission and allows the bounded opt-in", () => {
		expect(parseCapacityWait(undefined)).toBe(0);
		expect(parseCapacityWait(0)).toBe(0);
		expect(parseCapacityWait(CAPACITY_WAIT_MS)).toBe(CAPACITY_WAIT_MS);
	});
});
