import { describe, expect, it, vi } from "vitest";

import { OutboxDeliveryPendingError, type OutboxLease, type OutboxStore } from "../contracts";
import { dispatchOutbox } from "./dispatch-outbox";

function fixture() {
	let attempts = 0;
	let leaseSequence = 0;
	let processed = false;
	const store = {
		claimBatch: vi.fn<OutboxStore["claimBatch"]>(async () => {
			if (processed) return [];
			attempts += 1;
			return [
				{
					id: "outbox-payment",
					eventType: "PAYMENT_EVENT_RECEIVED",
					aggregateId: "payment-1",
					payload: { paymentEventId: "payment-1" },
					attempts,
					leaseToken: `lease-${++leaseSequence}`,
				},
			];
		}),
		complete: vi.fn<OutboxStore["complete"]>(async () => {
			processed = true;
		}),
		defer: vi.fn<NonNullable<OutboxStore["defer"]>>(async () => {
			attempts -= 1;
		}),
		release: vi.fn<OutboxStore["release"]>().mockResolvedValue(undefined),
	};
	const now = () => new Date("2026-09-08T16:00:00.000Z");
	return { store, now, attempts: () => attempts };
}

describe("Outbox completion receipts", () => {
	it("can query pending work repeatedly without ACK or spending the dead-letter attempt budget", async () => {
		const f = fixture();
		const deliver = vi
			.fn<(event: OutboxLease) => Promise<void>>()
			.mockRejectedValue(new OutboxDeliveryPendingError());
		for (let cycle = 0; cycle < 20; cycle += 1) {
			expect(await dispatchOutbox({ workerId: "worker-1" }, { ...f, deliver })).toEqual({
				claimed: 1,
				delivered: 0,
			});
		}
		expect(deliver.mock.calls.map(([event]) => event.attempts)).toEqual(Array(20).fill(1));
		expect(f.store.defer).toHaveBeenCalledTimes(20);
		expect(f.store.defer).toHaveBeenLastCalledWith({
			id: "outbox-payment",
			workerId: "worker-1",
			leaseToken: "lease-20",
			retryAt: new Date("2026-09-08T16:00:30.000Z"),
		});
		expect(f.store.complete).not.toHaveBeenCalled();
		expect(f.store.release).not.toHaveBeenCalled();
		expect(f.attempts()).toBe(0);
		deliver.mockResolvedValueOnce(undefined);
		expect(await dispatchOutbox({ workerId: "worker-1" }, { ...f, deliver })).toEqual({
			claimed: 1,
			delivered: 1,
		});
		expect(f.store.complete).toHaveBeenCalledExactlyOnceWith(
			"outbox-payment",
			"worker-1",
			"lease-21",
		);
	});

	it("spends a new delivery attempt only after an actual Workflow failure", async () => {
		const f = fixture();
		const deliver = vi
			.fn<(event: OutboxLease) => Promise<void>>()
			.mockRejectedValueOnce(new OutboxDeliveryPendingError())
			.mockRejectedValueOnce(new Error("WORKFLOW_FAILED"))
			.mockResolvedValueOnce(undefined);
		for (let cycle = 0; cycle < 3; cycle += 1)
			await dispatchOutbox({ workerId: "worker-1" }, { ...f, deliver });
		expect(deliver.mock.calls.map(([event]) => event.attempts)).toEqual([1, 1, 2]);
		expect(f.store.defer).toHaveBeenCalledTimes(1);
		expect(f.store.release).toHaveBeenCalledExactlyOnceWith({
			id: "outbox-payment",
			workerId: "worker-1",
			leaseToken: "lease-2",
			errorCode: "DELIVERY_FAILED",
			retryAt: new Date("2026-09-08T16:00:02.000Z"),
		});
		expect(f.store.complete).toHaveBeenCalledExactlyOnceWith(
			"outbox-payment",
			"worker-1",
			"lease-3",
		);
	});

	it("preserves the lease when an older store cannot defer pending completion", async () => {
		const f = fixture();
		const store: OutboxStore = {
			claimBatch: f.store.claimBatch,
			complete: f.store.complete,
			release: f.store.release,
		};
		await expect(
			dispatchOutbox(
				{ workerId: "worker-1" },
				{
					store,
					deliver: async () => {
						throw new OutboxDeliveryPendingError();
					},
				},
			),
		).rejects.toBeInstanceOf(OutboxDeliveryPendingError);
		expect(f.store.complete).not.toHaveBeenCalled();
		expect(f.store.release).not.toHaveBeenCalled();
	});
});
