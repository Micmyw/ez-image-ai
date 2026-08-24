import { beforeEach, describe, expect, it, vi } from "vitest";

const { continuationTask, reconcileSubscriptions, scheduledTask, tasks } = vi.hoisted(() => ({
	continuationTask: { config: null as unknown as { run: (payload: unknown) => Promise<unknown> } },
	reconcileSubscriptions: vi.fn(),
	scheduledTask: { config: null as unknown as { run: (payload: unknown) => Promise<unknown> } },
	tasks: { trigger: vi.fn() },
}));

vi.mock("@trigger.dev/sdk", () => ({
	schedules: {
		task: vi.fn((config) => {
			scheduledTask.config = config;
			return { id: config.id };
		}),
	},
	task: vi.fn((config) => {
		continuationTask.config = config;
		return { id: config.id };
	}),
	tasks,
}));

vi.mock("../src/handlers/reconcile-subscriptions", () => ({ reconcileSubscriptions }));

await import("./reconcile-subscriptions");

describe("Stripe reconciliation Trigger continuation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tasks.trigger.mockResolvedValue({ id: "run-1" });
	});

	it("uses the persisted continuation key as Trigger's global idempotency boundary", async () => {
		reconcileSubscriptions.mockImplementationOnce(async (input) => {
			await input.scheduleContinuation({
				sweepId: "sweep-1",
				continuationKey: "stripe-reconciliation:sweep-1:continuation:1",
				sequence: 1,
			});
			return { continuation: null };
		});

		await scheduledTask.config.run({ timestamp: new Date("2027-01-01T00:15:00.000Z") });

		expect(reconcileSubscriptions).toHaveBeenCalledWith(
			expect.objectContaining({ continuationSequence: 0, limit: 100 }),
		);
		expect(tasks.trigger).toHaveBeenCalledWith(
			"media-reconcile-subscriptions-continuation",
			{
				sweepId: "sweep-1",
				continuationKey: "stripe-reconciliation:sweep-1:continuation:1",
				sequence: 1,
			},
			{ idempotencyKey: "stripe-reconciliation:sweep-1:continuation:1" },
		);
	});

	it("resumes only the persisted sweep and sequence", async () => {
		const payload = {
			sweepId: "sweep-fixed",
			continuationKey: "stripe-reconciliation:sweep-fixed:continuation:7",
			sequence: 7,
		};
		reconcileSubscriptions.mockResolvedValueOnce({ continuation: null });

		await continuationTask.config.run(payload);

		expect(reconcileSubscriptions).toHaveBeenCalledWith(
			expect.objectContaining({
				continuationSequence: 7,
				expectedSweepId: "sweep-fixed",
				limit: 100,
			}),
		);
	});
});
