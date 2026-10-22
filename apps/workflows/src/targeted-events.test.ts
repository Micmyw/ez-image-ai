import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { workerExecutorLane } from "@repo/jobs/orchestration/worker-executors";
import { describe, expect, it, vi } from "vitest";

import {
	runTask,
	runContinuation,
	withTargetedEventDelivery,
	type DurableSteps,
	type InvokeTask,
} from "./orchestrator";

function steps() {
	const outputs = new Map<string, unknown>();
	const original = {
		async do<T>(name: string, _config: unknown, callback: () => Promise<T>): Promise<T> {
			if (!outputs.has(name)) outputs.set(name, await callback());
			return outputs.get(name) as T;
		},
		sleep: vi.fn<DurableSteps["sleep"]>(async () => undefined),
		sleepUntil: vi.fn(async () => undefined),
	};
	return { ...withTargetedEventDelivery(original), outputs, sleep: original.sleep };
}
const receipt = (eventId: string, leaseToken = "lease") => ({
	eventId,
	workerId: "workflow:run",
	leaseToken,
});
const delivery: TaskRequest = {
	taskId: "media-deliver-events",
	payload: { eventIds: ["dispatch"] },
};
const tasks: Record<string, TaskRequest> = {
	dispatch: {
		taskId: "media-dispatch-image-kie-nano-banana-2",
		payload: { jobId: "job", version: 0 },
		outboxReceipt: receipt("dispatch"),
	},
	finalize: {
		taskId: "media-finalize-generation",
		payload: { jobId: "job", version: 0 },
		outboxReceipt: receipt("finalize"),
	},
	review: {
		taskId: "media-verify-upload",
		payload: { assetId: "asset" },
		outboxReceipt: receipt("review"),
	},
	settle: {
		taskId: "media-settle-generation",
		payload: { jobId: "job", version: 0 },
		outboxReceipt: receipt("settle"),
	},
};

describe("same Workflow targeted continuation", () => {
	it.each([
		["finalize", "OUTPUT_TRANSFER_CLAIM_CONFLICT", "BEFORE_TRANSFER_LEASE", 5],
		["settle", "SETTLEMENT_TRANSACTION_CONFLICT", "TRANSACTION_ROLLED_BACK", 8],
	] as const)(
		"bounds %s conflicts to the existing task budget without sleeps",
		async (key, reason, phase, maxAttempts) => {
			const step = steps();
			const invoke = vi.fn<InvokeTask>().mockResolvedValue({
				status: "retry",
				reason,
				phase,
			} as never);
			await expect(runTask(tasks[key]!, "run", step, invoke)).rejects.toThrow("TASK_FAILED");
			expect(invoke.mock.calls.map(([, context]) => context.attempt)).toEqual(
				Array.from({ length: maxAttempts }, (_, index) => index + 1),
			);
			for (const [request] of invoke.mock.calls)
				expect(request).toMatchObject({
					taskId: tasks[key]!.taskId,
					outboxReceipt: tasks[key]!.outboxReceipt,
				});
			expect(step.sleep).not.toHaveBeenCalled();
		},
	);
	it.each([
		["finalize", "OUTPUT_TRANSFER_CLAIM_CONFLICT", "BEFORE_TRANSFER_LEASE"],
		["settle", "SETTLEMENT_TRANSACTION_CONFLICT", "TRANSACTION_ROLLED_BACK"],
	] as const)(
		"immediately retries a confirmed %s rollback and retains cached success",
		async (key, reason, phase) => {
			const step = steps();
			const invoke = vi
				.fn<InvokeTask>()
				.mockResolvedValueOnce({
					status: "retry",
					reason,
					phase,
				} as never)
				.mockResolvedValue({
					status: "ok",
					deliveryState: "completed",
					continuation: { eventIds: [] },
				});
			await runTask(tasks[key]!, "run", step, invoke);
			expect(invoke.mock.calls.map(([, context]) => context.attempt)).toEqual([1, 2]);
			expect(step.sleep).not.toHaveBeenCalled();
			await runTask(tasks[key]!, "run", step, invoke);
			expect(invoke).toHaveBeenCalledTimes(2);
		},
	);
	it.each([
		["finalize", "failure"],
		["finalize", "lost-response"],
		["settle", "failure"],
		["settle", "lost-response"],
	])(
		"does not automatically replay an uncertain %s receipt execution: %s",
		async (key, failure) => {
			const step = steps();
			const invoke = vi.fn<InvokeTask>();
			if (failure === "lost-response") invoke.mockRejectedValue(new Error("lost"));
			else invoke.mockResolvedValue({ status: "failed" });
			await expect(runTask(tasks[key]!, "run", step, invoke)).rejects.toThrow(
				"TASK_RECOVERY_REQUIRED",
			);
			expect(invoke).toHaveBeenCalledOnce();
			expect(step.sleep).not.toHaveBeenCalled();
		},
	);
	it("retains a future event until its exact due time and reprepares it without replaying paid work", async () => {
		let now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const step = steps();
		const dueAt = now + 811;
		step.sleepUntil = vi.fn(async (_name, due) => {
			now = Number(due);
		});
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({ status: "ok", preparedEvent: null, eventRetryAt: dueAt } as never)
			.mockResolvedValueOnce({ status: "ok", preparedEvent: tasks.review! })
			.mockResolvedValueOnce({
				status: "ok",
				deliveryState: "completed",
				poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
			});
		const request = { ...delivery, payload: { eventIds: ["review"] } };
		try {
			await runTask(request, "run", step, invoke);
			expect(now).toBe(dueAt);
			expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
				"media-prepare-event",
				"media-prepare-event",
				"media-verify-upload",
			]);
			await runTask(request, "run", step, invoke);
			expect(invoke).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
		}
	});
	it.each([0, 1, 811])(
		"reprepares the same event after a %i ms remainder even when its sleep call reaches the deadline",
		async (remainder) => {
			let now = 1_800_000_000_000;
			const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
			const dueAt = now + remainder;
			const step = steps();
			const originalStep = { ...step };
			step.do = async (name, config, callback) => {
				const result = await originalStep.do(name, config, callback);
				now += 10;
				return result;
			};
			step.sleepUntil = async (_name, until) => {
				now += 1_000;
				if (Number(until) < now) throw new Error("sleep until time in past");
				now = Number(until);
			};
			step.sleep.mockImplementation(async (_name, duration) => {
				now += 1_000 + Number.parseInt(duration, 10);
			});
			const invocations: Array<{ eventId: unknown; at: number }> = [];
			const invoke = vi.fn<InvokeTask>(async (request) => {
				invocations.push({ eventId: request.payload.eventId, at: now });
				return invocations.length === 1
					? { status: "ok", preparedEvent: null, eventRetryAt: dueAt }
					: { status: "ok", preparedEvent: null, eventRecoveryState: "missing" };
			});
			try {
				await runTask(delivery, "run", { ...step, fusedEventDelivery: true }, invoke);
				expect(invocations).toHaveLength(2);
				expect(invocations.map(({ eventId }) => eventId)).toEqual(["dispatch", "dispatch"]);
				expect(invocations[1]!.at).toBeGreaterThanOrEqual(dueAt);
				expect(
					invoke.mock.calls.every(([request]) => request.taskId === "media-execute-event"),
				).toBe(true);
			} finally {
				clock.mockRestore();
			}
		},
	);
	it("ends a terminal or missing event without inventing a retry", async () => {
		const step = steps();
		const sleepUntil = vi.fn(async () => undefined);
		step.sleepUntil = sleepUntil;
		const invoke = vi.fn<InvokeTask>().mockResolvedValue({ status: "ok", preparedEvent: null });
		await runTask(delivery, "run", step, invoke);
		expect(invoke).toHaveBeenCalledOnce();
		expect(sleepUntil).not.toHaveBeenCalled();
		expect(step.sleep).not.toHaveBeenCalled();
	});
	it("does not extend the durable preparation deadline when another owner keeps renewing its lease", async () => {
		let now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const step = steps();
		step.sleepUntil = vi.fn(async (_name, until) => {
			now = Number(until);
		});
		const invoke = vi.fn<InvokeTask>(async () => ({
			status: "ok",
			preparedEvent: null,
			eventRetryAt: now + 60_000,
		}));
		try {
			await expect(runTask(delivery, "run", step, invoke)).rejects.toThrow(
				"EVENT_PREPARE_DEADLINE_EXCEEDED",
			);
			expect(invoke).toHaveBeenCalledTimes(16);
			expect(now).toBe(1_800_000_960_000);
			expect(invoke.mock.calls.every(([task]) => task.taskId === "media-prepare-event")).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});
	it.each(["finalize", "review"])(
		"reclaims an expired %s receipt when a durable direct-wake handoff starts late",
		async (key) => {
			const request = tasks[key]!;
			const invoke = vi
				.fn<InvokeTask>()
				.mockResolvedValueOnce({
					status: "ok",
					deliveryState: "lost",
					poll: { done: true, waitSeconds: 0 },
					continuation: { eventIds: [] },
				})
				.mockResolvedValueOnce({
					status: "ok",
					preparedEvent: { ...request, outboxReceipt: receipt(key, "renewed") },
				})
				.mockResolvedValue({
					status: "ok",
					deliveryState: "completed",
					poll: { done: true, waitSeconds: 0 },
					continuation: { eventIds: [] },
				});
			await runContinuation(request, "wake-handoff", steps(), invoke);
			expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
				request.taskId,
				"media-prepare-event",
				request.taskId,
			]);
			expect(invoke.mock.calls[2]![0].outboxReceipt?.leaseToken).toBe("renewed");
		},
	);
	it("enables deferred first review only in the new adapter while legacy adapters keep their payload", async () => {
		const invoke = vi.fn<InvokeTask>().mockResolvedValue({
			status: "ok",
			deliveryState: "completed",
			continuation: { eventIds: [] },
		});
		await runTask(tasks.finalize!, "new", steps(), invoke);
		expect(invoke.mock.calls[0]![0].payload.deferOutputReview).toBe(true);
		await runTask(tasks.finalize!, "old", { ...steps(), deferOutputReview: undefined }, invoke);
		expect(invoke.mock.calls[1]![0].payload.deferOutputReview).toBeUndefined();
	});
	it("runs submission, poll, transfer, review and settlement without another Workflow dispatch", async () => {
		const step = steps();
		const trace: string[] = [];
		const contexts: string[] = [];
		const invoke = vi.fn<InvokeTask>(async (request, context) => {
			trace.push(`${workerExecutorLane(request)}:${request.taskId}`);
			contexts.push(context.runId);
			if (request.taskId === "media-prepare-event")
				return {
					status: "ok",
					preparedEvent: tasks[request.payload.eventId as string]!,
					continuation: { eventIds: [] },
				};
			if (request.taskId === tasks.dispatch!.taskId)
				return {
					status: "ok",
					deliveryState: "completed",
					continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
				};
			if (request.taskId === "media-poll-generation")
				return {
					status: "ok",
					poll: { done: true, waitSeconds: 0, continuation: { eventIds: ["finalize"] } },
				};
			if (request.taskId === "media-finalize-generation")
				return { status: "ok", deliveryState: "completed", continuation: { eventIds: ["review"] } };
			if (request.taskId === "media-verify-upload")
				return {
					status: "ok",
					deliveryState: "completed",
					poll: { done: true, waitSeconds: 0, continuation: { eventIds: ["settle"] } },
				};
			if (request.taskId === "media-settle-generation")
				return { status: "ok", deliveryState: "completed", continuation: { eventIds: [] } };
			throw new Error("Unexpected child Workflow dispatch");
		});
		await runTask(delivery, "original-workflow", step, invoke);
		expect(trace).toEqual([
			"control:media-prepare-event",
			"control:media-dispatch-image-kie-nano-banana-2",
			"control:media-poll-generation",
			"control:media-prepare-event",
			"heavy:media-finalize-generation",
			"control:media-prepare-event",
			"control:media-verify-upload",
			"control:media-prepare-event",
			"control:media-settle-generation",
		]);
		expect(new Set(contexts)).toEqual(new Set(["original-workflow"]));
		await runTask(delivery, "original-workflow", step, invoke);
		expect(invoke).toHaveBeenCalledTimes(9);
		expect(step.sleep).not.toHaveBeenCalled();
	});
	it("polls a pending review with the same receipt and cannot start its dependent stage early", async () => {
		const step = steps();
		let ticks = 0;
		const invoke = vi.fn<InvokeTask>(async (request) => {
			if (request.taskId === "media-prepare-event")
				return { status: "ok", preparedEvent: tasks.review!, continuation: { eventIds: [] } };
			expect(request.outboxReceipt).toEqual(receipt("review"));
			ticks++;
			return {
				status: "ok",
				deliveryState: ticks === 3 ? "completed" : "pending",
				poll: {
					done: ticks === 3,
					waitSeconds: ticks === 3 ? 0 : 3,
					continuation: { eventIds: [] },
				},
			};
		});
		await runTask({ ...delivery, payload: { eventIds: ["review"] } }, "run", step, invoke);
		expect(
			invoke.mock.calls.filter(([request]) => request.taskId === "media-prepare-event"),
		).toHaveLength(1);
		expect(ticks).toBe(3);
		expect(step.sleep.mock.calls.map((call) => call[1])).toEqual(["3 seconds", "3 seconds"]);
	});
	it("reprepares a stale receipt after capacity waiting instead of executing with expired ownership", async () => {
		const step = steps();
		let preparations = 0;
		const received: string[] = [];
		const invoke = vi.fn<InvokeTask>(async (request) => {
			if (request.taskId === "media-prepare-event") {
				preparations++;
				return {
					status: "ok",
					preparedEvent: {
						...tasks.dispatch!,
						outboxReceipt: receipt("dispatch", preparations === 1 ? "old" : "new"),
					},
					continuation: { eventIds: [] },
				};
			}
			const token = request.outboxReceipt!.leaseToken;
			received.push(token);
			if (received.length === 1) return { status: "busy" };
			return {
				status: "ok",
				deliveryState: token === "old" ? "lost" : "completed",
				continuation: { eventIds: [] },
			};
		});
		await runTask(delivery, "run", step, invoke);
		expect(preparations).toBe(2);
		expect(received).toEqual(["old", "old", "new"]);
		expect(step.sleep).toHaveBeenCalledOnce();
	});
	it("starts independent reviews together while a pending sibling is sleeping", async () => {
		const step = steps();
		const reviewed = new Map<string, number>();
		let wake!: () => void;
		const asleep = new Promise<void>((resolve) => {
			wake = resolve;
		});
		step.sleep.mockImplementation(() => asleep);
		const invoke = vi.fn<InvokeTask>(async (request) => {
			if (request.taskId === "media-prepare-event") {
				const id = request.payload.eventId as string;
				return {
					status: "ok",
					preparedEvent: { ...tasks.review!, payload: { assetId: id }, outboxReceipt: receipt(id) },
					continuation: { eventIds: [] },
				};
			}
			const id = request.payload.assetId as string;
			const tick = (reviewed.get(id) ?? 0) + 1;
			reviewed.set(id, tick);
			const done = id === "review-two" || tick > 1;
			return {
				status: "ok",
				deliveryState: done ? "completed" : "pending",
				poll: { done, waitSeconds: done ? 0 : 3, continuation: { eventIds: [] } },
			};
		});
		const running = runTask(
			{ ...delivery, payload: { eventIds: ["review-one", "review-two"] } },
			"run",
			step,
			invoke,
		);
		try {
			await vi.waitFor(() =>
				expect(reviewed).toEqual(
					new Map([
						["review-one", 1],
						["review-two", 1],
					]),
				),
			);
		} finally {
			wake();
			await running;
		}
		expect(reviewed).toEqual(
			new Map([
				["review-one", 2],
				["review-two", 1],
			]),
		);
	});
	it("bounds in-flight sibling receipts to four without preparing the whole batch", async () => {
		const step = steps();
		let active = 0;
		let maximum = 0;
		let preparations = 0;
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const invoke = vi.fn<InvokeTask>(async (request) => {
			if (request.taskId === "media-prepare-event") {
				preparations++;
				return {
					status: "ok",
					preparedEvent: {
						...tasks.settle!,
						outboxReceipt: receipt(request.payload.eventId as string),
					},
					continuation: { eventIds: [] },
				};
			}
			active++;
			maximum = Math.max(maximum, active);
			await gate;
			active--;
			return { status: "ok", deliveryState: "completed", continuation: { eventIds: [] } };
		});
		const running = runTask(
			{ ...delivery, payload: { eventIds: ["one", "two", "three", "four", "five"] } },
			"run",
			step,
			invoke,
		);
		try {
			await vi.waitFor(() => expect(active).toBe(4));
			expect(preparations).toBe(4);
		} finally {
			finish();
			await running;
		}
		expect(maximum).toBe(4);
		expect(preparations).toBe(5);
	});
	it("rejects an unaware prepare receiver, malformed target or missing receipt completion", async () => {
		await expect(
			runTask(delivery, "run", steps(), vi.fn().mockResolvedValue({ status: "ok" })),
		).rejects.toThrow("EVENT_RECEIVER_UPGRADE_REQUIRED");
		await expect(
			runTask(
				delivery,
				"run",
				steps(),
				vi.fn().mockResolvedValue({ status: "ok", preparedEvent: tasks.review }),
			),
		).rejects.toThrow("INVALID_PREPARED_EVENT");
		await expect(
			runTask(
				delivery,
				"run",
				steps(),
				vi
					.fn()
					.mockResolvedValueOnce({ status: "ok", preparedEvent: tasks.dispatch })
					.mockResolvedValue({ status: "ok", continuation: { eventIds: [] } }),
			),
		).rejects.toThrow();
	});
	it("keeps adapters without the new protocol on the existing delivery contract", async () => {
		const step: DurableSteps = { ...steps(), targetedEventDelivery: false };
		const invoke = vi.fn().mockResolvedValue({ status: "ok" });
		await runTask(delivery, "old-workflow", step, invoke);
		expect(invoke).toHaveBeenCalledExactlyOnceWith(delivery, {
			attempt: 1,
			maxAttempts: 3,
			runId: "old-workflow",
		});
	});
});
