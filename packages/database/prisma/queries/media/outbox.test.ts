import { describe, expect, it, vi } from "vitest";

import { deferOutboxEvent } from "./outbox";
import type { MediaTransactionClient } from "./types";

describe("pending Outbox delivery lease CAS", () => {
	it("defers the current unexpired lease atomically without consuming an attempt", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const client = { outboxEvent: { updateMany } } as unknown as MediaTransactionClient;
		const now = new Date("2026-09-08T16:00:00.000Z");
		const retryAt = new Date(now.getTime() + 30_000);
		expect(
			await deferOutboxEvent(
				{ id: "event-1", workerId: "worker-1", leaseToken: "lease-1", retryAt, now },
				client,
			),
		).toEqual({ applied: true });
		expect(updateMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				id: "event-1",
				status: "LEASED",
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				leasedUntil: { gt: now },
				attempts: { gt: 0 },
			},
			data: {
				status: "PENDING",
				availableAt: retryAt,
				attempts: { decrement: 1 },
				leaseOwner: null,
				leaseToken: null,
				leasedUntil: null,
			},
		});
	});

	it("reports an expired or reclaimed lease without a fallback mutation", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const client = { outboxEvent: { updateMany } } as unknown as MediaTransactionClient;
		expect(
			await deferOutboxEvent(
				{ id: "event-1", workerId: "worker-old", leaseToken: "lease-old", retryAt: new Date() },
				client,
			),
		).toEqual({ applied: false });
		expect(updateMany).toHaveBeenCalledTimes(1);
	});
});
