/** Bounded in-flight admission, not business ownership. PostgreSQL leases remain authoritative. */
export const CAPACITY_WAIT_MS = 25_000;
const MAX_WAITERS = 128;
type Queue = { queue: string; concurrency: number };
type Admission = { release: (() => void) | null; waited: boolean };
type Waiter = { queue: Queue; admit(): void };

export function parseCapacityWait(value: unknown): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > CAPACITY_WAIT_MS)
		throw new Error("INVALID_CAPACITY_WAIT");
	return value as number;
}

export class ExecutionCapacity {
	private running = 0;
	private queues = new Map<string, number>();
	private waiters: Waiter[] = [];

	constructor(private maximum: number) {
		if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16)
			throw new Error("INVALID_RUNTIME_CONCURRENCY");
	}
	get active(): number {
		return this.running;
	}
	get waiting(): number {
		return this.waiters.length;
	}

	private available(queue: Queue): boolean {
		return this.running < this.maximum && (this.queues.get(queue.queue) ?? 0) < queue.concurrency;
	}
	private reserve(queue: Queue): () => void {
		this.running++;
		this.queues.set(queue.queue, (this.queues.get(queue.queue) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.running--;
			const count = (this.queues.get(queue.queue) ?? 1) - 1;
			if (count) this.queues.set(queue.queue, count);
			else this.queues.delete(queue.queue);
			// Reserve before resolving a waiter, so another request cannot steal its slot.
			for (let index = 0; index < this.waiters.length && this.running < this.maximum;) {
				const waiter = this.waiters[index]!;
				if (!this.available(waiter.queue)) {
					index++;
					continue;
				}
				this.waiters.splice(index, 1);
				waiter.admit();
			}
		};
	}

	acquire(queue: Queue, waitMs = 0, signal?: AbortSignal): Promise<Admission> {
		if (signal?.aborted) return Promise.resolve({ release: null, waited: false });
		if (this.available(queue))
			return Promise.resolve({ release: this.reserve(queue), waited: false });
		if (!waitMs || this.waiters.length >= MAX_WAITERS)
			return Promise.resolve({ release: null, waited: false });
		return new Promise((resolve) => {
			let settled = false;
			const finish = (admitted: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				const index = this.waiters.indexOf(waiter);
				if (index >= 0) this.waiters.splice(index, 1);
				resolve({ release: admitted ? this.reserve(queue) : null, waited: true });
			};
			const waiter: Waiter = { queue, admit: () => finish(true) };
			const abort = () => finish(false);
			const timer = setTimeout(abort, waitMs);
			this.waiters.push(waiter);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
}
