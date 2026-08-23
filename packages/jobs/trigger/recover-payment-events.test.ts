import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, recoverExpiredPaymentEvents, schedules } = vi.hoisted(() => ({
	db: {},
	recoverExpiredPaymentEvents: vi.fn(),
	schedules: { task: vi.fn((configuration: unknown) => configuration) },
}));

vi.mock("@trigger.dev/sdk", () => ({ schedules }));
vi.mock("@repo/database", () => ({ recoverExpiredPaymentEvents }));
vi.mock("@repo/database/client", () => ({ db }));

import { recoverPaymentEventsTask } from "./recover-payment-events";

type RecoverPaymentEventsTaskConfiguration = {
	run: () => Promise<{ recovered: number }>;
};

describe("recoverPaymentEventsTask", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("runs bounded payment-event recovery on its dedicated minute schedule", async () => {
		recoverExpiredPaymentEvents.mockResolvedValue({ recovered: 2 });
		const task = recoverPaymentEventsTask as unknown as RecoverPaymentEventsTaskConfiguration;

		await expect(task.run()).resolves.toEqual({ recovered: 2 });
		expect(recoverExpiredPaymentEvents).toHaveBeenCalledWith({ limit: 25 }, db);
		expect(recoverPaymentEventsTask).toMatchObject({
			id: "media-recover-payment-events",
			cron: "* * * * *",
			queue: { name: "media-payment-recovery", concurrencyLimit: 1 },
		});
	});

	it("propagates recovery failures for Trigger to retry independently", async () => {
		recoverExpiredPaymentEvents.mockRejectedValue(
			new Error("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE"),
		);
		const task = recoverPaymentEventsTask as unknown as RecoverPaymentEventsTaskConfiguration;

		await expect(task.run()).rejects.toThrow("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE");
	});
});
