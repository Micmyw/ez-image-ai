import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({ getDatabaseClient: vi.fn() }));

import {
	isDatabaseLockNotAvailable,
	runSerializable,
	type MediaTransactionClient,
	type SerializableAttemptEvent,
} from "./types";

const lockBusy = {
	code: "P2010",
	meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
};

describe("Serializable lock-not-available opt-in", () => {
	it("leaves existing callers at one attempt for NOWAIT lock contention", async () => {
		const transaction = vi.fn().mockRejectedValue(lockBusy);
		await expect(
			runSerializable({ $transaction: transaction } as unknown as MediaTransactionClient, vi.fn()),
		).rejects.toBe(lockBusy);
		expect(transaction).toHaveBeenCalledOnce();
	});

	it("shares one retry budget and reports actual conflict types when opted in", async () => {
		const serialization = { code: "P2034" };
		const transaction = vi
			.fn()
			.mockRejectedValueOnce(lockBusy)
			.mockRejectedValueOnce(serialization)
			.mockResolvedValue("committed");
		const events: SerializableAttemptEvent[] = [];
		await expect(
			runSerializable({ $transaction: transaction } as unknown as MediaTransactionClient, vi.fn(), {
				retryLockNotAvailable: true,
				onAttempt: (event) => events.push(event),
			}),
		).resolves.toBe("committed");
		expect(events.map(({ outcome }) => outcome)).toEqual([
			"STARTED",
			"LOCK_NOT_AVAILABLE",
			"STARTED",
			"SERIALIZATION_CONFLICT",
			"STARTED",
		]);
		expect(transaction).toHaveBeenCalledTimes(3);
		expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
			isolationLevel: "Serializable",
			maxWait: 5_000,
			timeout: 20_000,
		});
	});

	it("surfaces the original error after four confirmed lock failures", async () => {
		const transaction = vi.fn().mockRejectedValue(lockBusy);
		await expect(
			runSerializable({ $transaction: transaction } as unknown as MediaTransactionClient, vi.fn(), {
				retryLockNotAvailable: true,
			}),
		).rejects.toBe(lockBusy);
		expect(transaction).toHaveBeenCalledTimes(4);
	});

	it.each([
		{ code: "P1001", message: "connection lost after COMMIT" },
		{ code: "ETIMEDOUT", message: "55P03" },
		new Error("55P03"),
	])("does not retry an unknown or network outcome", async (error) => {
		const transaction = vi.fn().mockRejectedValue(error);
		await expect(
			runSerializable({ $transaction: transaction } as unknown as MediaTransactionClient, vi.fn(), {
				retryLockNotAvailable: true,
			}),
		).rejects.toBe(error);
		expect(transaction).toHaveBeenCalledOnce();
	});

	it("recognizes structured PostgreSQL lock failures only", () => {
		expect(isDatabaseLockNotAvailable(lockBusy)).toBe(true);
		expect(isDatabaseLockNotAvailable({ code: "55P03" })).toBe(true);
		expect(isDatabaseLockNotAvailable({ cause: { originalCode: "55P03" } })).toBe(true);
		for (const error of [null, undefined, "55P03", { message: "55P03" }, { code: "P2034" }])
			expect(isDatabaseLockNotAvailable(error)).toBe(false);
	});
});
