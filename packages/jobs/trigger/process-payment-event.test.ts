import { beforeEach, describe, expect, it, vi } from "vitest";

const { processPaymentEvent, task } = vi.hoisted(() => ({
	processPaymentEvent: vi.fn(),
	task: vi.fn((configuration: unknown) => configuration),
}));

vi.mock("../src/handlers/process-payment-event", () => ({ processPaymentEvent }));
vi.mock("@trigger.dev/sdk", () => ({ task }));

import { processPaymentEventTask, runProcessPaymentEvent } from "./process-payment-event";

type PaymentEventTaskConfiguration = {
	run: (
		payload: { paymentEventId: string },
		context: {
			ctx: {
				attempt: { number: number };
				run: { id: string; maxAttempts?: number };
			};
		},
	) => Promise<unknown>;
};

describe("runProcessPaymentEvent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("forwards the real Trigger retry context to payment processing", async () => {
		const result = { outcome: "PROCESSED", grantsCreated: 1 };
		processPaymentEvent.mockResolvedValue(result);

		await expect(
			runProcessPaymentEvent(
				{ paymentEventId: "payment_event_1" },
				{ attempt: 3, maxAttempts: 5, triggerRunId: "trigger_run_1" },
			),
		).resolves.toBe(result);
		expect(processPaymentEvent).toHaveBeenCalledWith(
			{ paymentEventId: "payment_event_1" },
			{ attempt: 3, maxAttempts: 5, triggerRunId: "trigger_run_1" },
		);
	});

	it("uses the configured retry budget when Trigger omits maxAttempts", async () => {
		const result = { outcome: "PROCESSED", grantsCreated: 1 };
		processPaymentEvent.mockResolvedValue(result);
		const configuredTask = processPaymentEventTask as unknown as PaymentEventTaskConfiguration;

		await expect(
			configuredTask.run(
				{ paymentEventId: "payment_event_without_max_attempts" },
				{
					ctx: {
						attempt: { number: 6 },
						run: { id: "trigger_run_without_max_attempts" },
					},
				},
			),
		).resolves.toBe(result);
		expect(processPaymentEvent).toHaveBeenCalledWith(
			{ paymentEventId: "payment_event_without_max_attempts" },
			{
				attempt: 6,
				maxAttempts: 8,
				triggerRunId: "trigger_run_without_max_attempts",
			},
		);
	});

	it("propagates a final-attempt failure so Trigger can record the retry failure", async () => {
		processPaymentEvent.mockRejectedValue(new Error("DATABASE_TEMPORARILY_UNAVAILABLE"));

		await expect(
			runProcessPaymentEvent(
				{ paymentEventId: "payment_event_final" },
				{ attempt: 5, maxAttempts: 5, triggerRunId: "trigger_run_final" },
			),
		).rejects.toThrow("DATABASE_TEMPORARILY_UNAVAILABLE");
	});

	it("keeps retrying long enough to reclaim a lease after failure auditing is unavailable", () => {
		expect(processPaymentEventTask).toMatchObject({
			retry: {
				maxAttempts: 8,
				factor: 2,
				minTimeoutInMs: 1_000,
				maxTimeoutInMs: 30_000,
				randomize: false,
			},
		});
	});
});
