import {
	imagePhaseEventType,
	type ImagePhaseOwner,
	type TaskRequest,
} from "@repo/jobs/orchestration/contracts";
import { describe, expect, it, vi } from "vitest";

import {
	runPolling,
	runTask,
	withTargetedEventDelivery,
	type DurableSteps,
	type InvokeTask,
} from "./orchestrator";

const owner: ImagePhaseOwner = { workflowId: "workflow", phaseKey: "review-phase", epoch: 1 };
const review: TaskRequest = {
	taskId: "media-verify-upload",
	payload: { assetId: "asset" },
	outboxReceipt: {
		eventId: "review",
		workerId: "workflow:workflow:event:review",
		leaseToken: "lease",
	},
};
const pending = {
	status: "ok" as const,
	deliveryState: "pending" as const,
	poll: {
		done: false,
		waitSeconds: 5,
		queryOnly: true,
		phaseOwner: owner,
		continuation: { eventIds: [] },
	},
};
const complete = {
	status: "ok" as const,
	deliveryState: "completed" as const,
	poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
};

function steps(version: 1 | 2 = 2) {
	const cache = new Map<string, unknown>();
	const sleep = vi.fn(async () => {});
	const waitForEvent = vi.fn(
		async (_name: string, _options: { type: string; timeout: string }) => ({}),
	);
	const raw: DurableSteps = {
		async do(name, _config, operation) {
			if (!cache.has(name)) cache.set(name, await operation());
			return cache.get(name) as never;
		},
		sleep,
		waitForEvent,
	};
	return { ...withTargetedEventDelivery(raw, version === 2 ? 2 : undefined), sleep, waitForEvent };
}

describe("versioned fused control stages", () => {
	it("uses the fused first review result, then waits for its owner signal before query-only polling", async () => {
		const step = steps();
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({ ...pending, preparedEvent: null, executedEvent: review })
			.mockResolvedValueOnce(complete);
		await runTask(
			{ taskId: "media-deliver-events", payload: { eventIds: ["review"] } },
			"workflow",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map(([request]) => request.taskId)).toEqual([
			"media-execute-event",
			"media-verify-upload",
		]);
		expect(invoke.mock.calls[1]).toMatchObject([
			{ payload: { queryOnly: true } },
			{ workflowId: "workflow", phaseOwner: owner },
		]);
		expect(step.waitForEvent).toHaveBeenCalledWith(expect.any(String), {
			type: imagePhaseEventType(owner),
			timeout: "5 seconds",
		});
		expect(step.sleep).not.toHaveBeenCalled();
	});
	it("retains cached fusion completion when a Workflow resumes", async () => {
		const step = steps();
		const invoke = vi.fn<InvokeTask>().mockResolvedValue({
			status: "ok",
			preparedEvent: null,
			eventRecoveryState: "completed",
			continuation: { eventIds: [] },
		});
		const task = { taskId: "media-deliver-events", payload: { eventIds: ["review"] } };
		await runTask(task, "workflow", step, invoke);
		await runTask(task, "workflow", step, invoke);
		expect(invoke).toHaveBeenCalledOnce();
	});
	it("reclaims the event if a receipt expires after the fused first review tick", async () => {
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({ ...pending, preparedEvent: null, executedEvent: review })
			.mockResolvedValueOnce({ ...complete, deliveryState: "lost" })
			.mockResolvedValueOnce({
				status: "ok",
				preparedEvent: null,
				eventRecoveryState: "completed",
				continuation: { eventIds: [] },
			});
		await runTask(
			{ taskId: "media-deliver-events", payload: { eventIds: ["review"] } },
			"workflow",
			steps(),
			invoke,
		);
		expect(invoke.mock.calls.map(([request]) => request.taskId)).toEqual([
			"media-execute-event",
			"media-verify-upload",
			"media-execute-event",
		]);
		expect(invoke.mock.calls[2]?.[0].payload).toEqual({ eventId: "review" });
	});
	it("recovers a lost paid wrapper response read-only and follows its committed continuation", async () => {
		const step = steps();
		const invoke = vi
			.fn<InvokeTask>()
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValueOnce({
				status: "ok",
				preparedEvent: null,
				eventRecoveryState: "completed",
				continuation: { eventIds: [], pollAttemptId: "accepted", phaseOwner: owner },
			})
			.mockResolvedValueOnce({
				status: "ok",
				poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
			});
		await runTask(
			{ taskId: "media-deliver-events", payload: { eventIds: ["submit"] } },
			"workflow",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map(([request]) => request.payload)).toEqual([
			{ eventId: "submit" },
			{ eventId: "submit", recoverOnly: true },
			{ attemptId: "accepted" },
		]);
		expect(invoke.mock.calls[2]?.[1]).toMatchObject({ workflowId: "workflow", phaseOwner: owner });
	});
	it("does not replay an unknown paid effect when read-only recovery observes a held event", async () => {
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({ status: "failed" })
			.mockResolvedValueOnce({ status: "ok", preparedEvent: null, eventRecoveryState: "held" });
		await expect(
			runTask(
				{ taskId: "media-deliver-events", payload: { eventIds: ["submit"] } },
				"workflow",
				steps(),
				invoke,
			),
		).rejects.toThrow("TASK_RECOVERY_REQUIRED");
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(invoke.mock.calls[1]?.[0].payload.recoverOnly).toBe(true);
	});
	it("keeps historical Workflow params on the prepare protocol", async () => {
		const step = steps(1);
		const invoke = vi.fn<InvokeTask>().mockResolvedValue({ status: "ok", preparedEvent: null });
		await runTask(
			{ taskId: "media-deliver-events", payload: { eventIds: ["old"] } },
			"workflow",
			step,
			invoke,
		);
		expect(invoke.mock.calls[0]?.[0].taskId).toBe("media-prepare-event");
		expect(invoke.mock.calls[0]?.[1].workflowId).toBeUndefined();
	});
});

describe("one durable phase waiter", () => {
	it("checks the persisted deadline after a signal without adding a separate budget step", async () => {
		let currentTime = 1_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		try {
			const step = steps();
			const doStep = vi.spyOn(step, "do");
			step.waitForEvent.mockImplementation(async () => {
				currentTime += 600_000;
				return {};
			});
			const invoke = vi.fn<InvokeTask>();
			expect(
				await runPolling(review, "workflow", step, invoke, "deadline", { initialResult: pending }),
			).toEqual({ status: "expired" });
			expect(invoke).not.toHaveBeenCalled();
			expect(doStep.mock.calls.some(([name]) => name.includes("-budget-"))).toBe(false);
		} finally {
			clock.mockRestore();
		}
	});
	it("recovers a missing signal through the durable timeout without another Workflow", async () => {
		const step = steps();
		step.waitForEvent.mockRejectedValueOnce(
			Object.assign(new Error("deadline"), { name: "WorkflowTimeoutError" }),
		);
		const invoke = vi.fn<InvokeTask>().mockResolvedValue(complete);
		await runPolling(review, "workflow", step, invoke, "review", { initialResult: pending });
		expect(invoke).toHaveBeenCalledOnce();
		expect(step.sleep).not.toHaveBeenCalled();
	});
	it("uses distinct event types for parallel assets and epochs, including signals already queued before wait", async () => {
		const step = steps();
		const owners = [owner, { ...owner, phaseKey: "second-asset" }, { ...owner, epoch: 2 }];
		const queued = new Set(owners.map(imagePhaseEventType));
		step.waitForEvent.mockImplementation(async (_name, options) => {
			expect(queued.delete(options.type)).toBe(true);
			return {};
		});
		const invoke = vi.fn<InvokeTask>().mockResolvedValue(complete);
		await Promise.all(
			owners.map((phaseOwner, index) =>
				runPolling(review, "workflow", step, invoke, `phase-${index}`, {
					initialResult: { ...pending, poll: { ...pending.poll, phaseOwner } },
				}),
			),
		);
		expect(queued.size).toBe(0);
		expect(invoke).toHaveBeenCalledTimes(3);
	});
	it("stops a stale owner's polling when the database reports another owner", async () => {
		const step = steps();
		const invoke = vi.fn<InvokeTask>();
		const result = {
			...pending,
			poll: { ...pending.poll, phaseOwner: { ...owner, workflowId: "new-owner", epoch: 2 } },
		};
		expect(
			await runPolling(review, "workflow", step, invoke, "old", { initialResult: result }),
		).toEqual(result);
		expect(invoke).not.toHaveBeenCalled();
		expect(step.waitForEvent).not.toHaveBeenCalled();
	});
	it("does not mistake a broken event runtime for a durable timeout", async () => {
		const step = steps();
		step.waitForEvent.mockRejectedValueOnce(new Error("invalid event type"));
		await expect(
			runPolling(review, "workflow", step, vi.fn(), "review", { initialResult: pending }),
		).rejects.toThrow("invalid event type");
	});
	it("stops an expired epoch without treating it as terminal completion", async () => {
		const step = steps();
		const invoke = vi.fn<InvokeTask>();
		const lost = { ...pending, poll: { ...pending.poll, phaseOwnershipLost: true } };
		expect(
			await runPolling(review, "workflow", step, invoke, "expired", { initialResult: lost }),
		).toEqual(lost);
		expect(invoke).not.toHaveBeenCalled();
		expect(step.waitForEvent).not.toHaveBeenCalled();
	});
});
