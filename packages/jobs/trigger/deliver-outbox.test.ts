import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	databaseOutboxStore,
	db,
	deliverOutboxEvent,
	dispatchOutbox,
	recoverExpiredPaymentEvents,
	resolveDatabaseDispatchRoute,
	schedules,
	tasks,
} = vi.hoisted(() => ({
	databaseOutboxStore: {},
	db: {},
	deliverOutboxEvent: vi.fn(),
	dispatchOutbox: vi.fn(),
	recoverExpiredPaymentEvents: vi.fn(),
	resolveDatabaseDispatchRoute: vi.fn(),
	schedules: { task: vi.fn((configuration: unknown) => configuration) },
	tasks: { trigger: vi.fn(), triggerAndWait: vi.fn() },
}));

vi.mock("@trigger.dev/sdk", () => ({ schedules, tasks }));
vi.mock("@repo/database", () => ({ recoverExpiredPaymentEvents }));
vi.mock("@repo/database/client", () => ({ db }));
vi.mock("../src/handlers/deliver-outbox-event", () => ({ deliverOutboxEvent }));
vi.mock("../src/handlers/dispatch-outbox", () => ({ dispatchOutbox }));
vi.mock("../src/runtime", () => ({ databaseOutboxStore, resolveDatabaseDispatchRoute }));

import { deliverOutboxTask } from "./deliver-outbox";

type DeliverOutboxTaskConfiguration = {
	run: () => Promise<{ claimed: number; delivered: number }>;
};

describe("deliverOutboxTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches durable outbox work when payment recovery is unavailable", async () => {
		recoverExpiredPaymentEvents.mockRejectedValue(
			new Error("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE"),
		);
		dispatchOutbox.mockResolvedValue({ claimed: 3, delivered: 3 });
		const task = deliverOutboxTask as unknown as DeliverOutboxTaskConfiguration;

		await expect(task.run()).resolves.toEqual({ claimed: 3, delivered: 3 });
		expect(recoverExpiredPaymentEvents).not.toHaveBeenCalled();
		expect(dispatchOutbox).toHaveBeenCalledTimes(1);
	});
});
