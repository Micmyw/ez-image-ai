import { signRequest } from "@repo/jobs/orchestration/auth";
import type { TaskRequest } from "@repo/jobs/orchestration/contracts";
import { describe, expect, it, vi } from "vitest";

import type { InvokeTask } from "./orchestrator";
import { createWakeContinuationScheduler, handleWake, runDirectWake } from "./wake";

const secret = "test-only-32-character-shared-secret";
const root = { taskId: "media-verify-upload", payload: { assetId: "asset" } };
const receipt = (eventId: string) => ({ eventId, workerId: "worker", leaseToken: "lease" });
const done = {
	status: "ok" as const,
	poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
};
async function signed(value: unknown = { ...root, idempotencyKey: "callback:one" }) {
	const body = JSON.stringify(value);
	return new Request("https://jobs/internal/wake", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/wake", body),
	});
}

describe("authenticated callback direct wake", () => {
	it.each([
		["media-finalize-generation", "OUTPUT_TRANSFER_CLAIM_CONFLICT", "BEFORE_TRANSFER_LEASE"],
		["media-settle-generation", "SETTLEMENT_TRANSACTION_CONFLICT", "TRANSACTION_ROLLED_BACK"],
	] as const)(
		"hands a confirmed %s rollback to durable execution with the same receipt",
		async (taskId, reason, phase) => {
			const child = {
				taskId,
				payload: { jobId: "job", version: 0 },
				outboxReceipt: receipt("finalize"),
			};
			const invoke = vi
				.fn<InvokeTask>()
				.mockResolvedValueOnce({
					...done,
					poll: { ...done.poll, continuation: { eventIds: ["finalize"] } },
				})
				.mockResolvedValueOnce({ status: "ok", preparedEvent: child })
				.mockResolvedValueOnce({
					status: "retry",
					reason,
					phase,
				} as never);
			const resume = vi.fn().mockResolvedValue(undefined);
			await runDirectWake(root, "wake", invoke, resume);
			expect(invoke).toHaveBeenCalledTimes(3);
			expect(resume).toHaveBeenCalledExactlyOnceWith(child, "wake");
		},
	);
	it.each(["failure", "lost-response"])(
		"persists a failed prepare for fenced re-preparation: %s",
		async (failure) => {
			const invoke = vi.fn<InvokeTask>().mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["finalize"] } },
			});
			if (failure === "lost-response") invoke.mockRejectedValueOnce(new Error("lost"));
			else invoke.mockResolvedValueOnce({ status: "failed" });
			const resume = vi.fn().mockResolvedValue(undefined);
			await runDirectWake(root, "wake", invoke, resume);
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(resume).toHaveBeenCalledExactlyOnceWith(
				{ taskId: "media-deliver-events", payload: { eventIds: ["finalize"] } },
				"wake",
			);
		},
	);
	it("persists an event that is not yet due when prepare cannot claim it", async () => {
		const dueAt = Date.now() + 811;
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["review"] } },
			})
			.mockResolvedValueOnce({ status: "ok", preparedEvent: null, eventRetryAt: dueAt } as never);
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(resume).toHaveBeenCalledExactlyOnceWith(
			{ taskId: "media-deliver-events", payload: { eventIds: ["review"] } },
			"wake",
		);
	});
	it("retains a claimed read-only review continuation when its transport response is lost", async () => {
		const review = {
			taskId: "media-verify-upload",
			payload: { assetId: "output", queryOnly: true },
			outboxReceipt: receipt("review"),
		};
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["review"] } },
			})
			.mockResolvedValueOnce({ status: "ok", preparedEvent: review })
			.mockRejectedValueOnce(new Error("response lost"));
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(resume).toHaveBeenCalledExactlyOnceWith(review, "wake");
		expect(invoke).toHaveBeenCalledTimes(3);
	});
	it("does not hand off an uncertain first review submission as a read-only query", async () => {
		const review = {
			taskId: "media-verify-upload",
			payload: { assetId: "output" },
			outboxReceipt: receipt("review"),
		};
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["review"] } },
			})
			.mockResolvedValueOnce({ status: "ok", preparedEvent: review })
			.mockRejectedValueOnce(new Error("submission response lost"));
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(resume).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledTimes(3);
	});
	it.each(["errored", "terminated"])(
		"restarts only confirmed query continuations after %s, never a first review submit",
		async (status) => {
			const restart = vi.fn().mockResolvedValue(undefined);
			const createBatch = vi.fn().mockResolvedValue(undefined);
			const scheduler = createWakeContinuationScheduler({
				createBatch,
				get: async () => ({ status: async () => ({ status }), restart }),
			});
			const review = { ...root, outboxReceipt: receipt("review") };
			await expect(scheduler(review, "wake")).rejects.toThrow("WAKE_CONTINUATION_UNAVAILABLE");
			expect(restart).not.toHaveBeenCalled();
			await scheduler({ ...review, payload: { ...review.payload, queryOnly: true } }, "wake");
			expect(restart).toHaveBeenCalledOnce();
			await expect(scheduler(root, "wake")).rejects.toThrow("WAKE_CONTINUATION_RECEIPT_REQUIRED");
			expect(createBatch).toHaveBeenCalledTimes(2);
		},
	);
	it("can create the first durable review continuation with its claimed receipt", async () => {
		const restart = vi.fn();
		const createBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = createWakeContinuationScheduler({
			createBatch,
			get: async () => ({ status: async () => ({ status: "queued" }), restart }),
		});
		await scheduler({ ...root, outboxReceipt: receipt("review") }, "wake");
		expect(createBatch).toHaveBeenCalledOnce();
		expect(restart).not.toHaveBeenCalled();
	});
	it("persists same-attempt polling when the callback ACKs submission before the original Workflow sees it", async () => {
		const submit = {
			taskId: "media-dispatch-image-kie-nano-banana-2",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: receipt("submit"),
		};
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["submit"] } },
			})
			.mockResolvedValueOnce({ status: "ok", preparedEvent: submit })
			.mockResolvedValueOnce({
				status: "ok",
				deliveryState: "completed",
				continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
			});
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(resume).toHaveBeenCalledExactlyOnceWith(
			{ taskId: "media-poll-generation", payload: { attemptId: "accepted-attempt" } },
			"wake",
		);
		expect(invoke.mock.calls.filter(([task]) => task.taskId === submit.taskId)).toHaveLength(1);
	});
	it.each([true, false])(
		"hands pending output review to its due time with confirmed query privilege: %s",
		async (queryOnly) => {
			const now = 1_800_000_000_000;
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const review = {
				taskId: "media-verify-upload",
				payload: { assetId: "output" },
				outboxReceipt: receipt("review"),
			};
			const invoke = vi
				.fn<InvokeTask>()
				.mockResolvedValueOnce({
					...done,
					poll: { ...done.poll, continuation: { eventIds: ["review"] } },
				})
				.mockResolvedValueOnce({ status: "ok", preparedEvent: review })
				.mockResolvedValueOnce({
					status: "ok",
					deliveryState: "pending",
					poll: { done: false, waitSeconds: 3, queryOnly, continuation: { eventIds: [] } },
				});
			const resume = vi.fn().mockResolvedValue(undefined);
			try {
				await runDirectWake(root, "wake", invoke, resume);
				expect(resume).toHaveBeenCalledExactlyOnceWith(
					{ ...review, payload: { assetId: "output", ...(queryOnly ? { queryOnly: true } : {}) } },
					"wake",
					now + 3_000,
				);
				expect(invoke).toHaveBeenCalledTimes(3);
			} finally {
				clock.mockRestore();
			}
		},
	);
	it("keeps an explicitly due query in the direct path without scheduling a wait", async () => {
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				status: "ok",
				poll: { done: false, waitSeconds: 0, queryOnly: true, retryImmediately: true },
			})
			.mockResolvedValueOnce(done);
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
		expect(resume).not.toHaveBeenCalled();
	});
	it("persists the pending review due time while an earlier callback can still finish directly", async () => {
		const now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const createBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = createWakeContinuationScheduler({
			createBatch,
			get: async () => ({
				status: async () => ({ status: "queued" }),
				restart: async () => undefined,
			}),
		});
		const review = {
			...root,
			outboxReceipt: receipt("review"),
		};
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				status: "ok",
				deliveryState: "pending",
				poll: { done: false, waitSeconds: 1.25, queryOnly: true },
			})
			.mockResolvedValueOnce(done);
		try {
			await runDirectWake(review, "pending-wake", invoke, scheduler);
			expect(createBatch).toHaveBeenCalledOnce();
			expect(createBatch.mock.calls[0]![0][0].params).toEqual({
				kind: "continuation",
				request: { ...review, payload: { assetId: "asset", queryOnly: true } },
				notBefore: now + 1_250,
			});
			expect(invoke).toHaveBeenCalledOnce();
			clock.mockReturnValue(now + 100);
			await runDirectWake(root, "ready-callback", invoke, scheduler);
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(invoke.mock.calls[1]![0]).toEqual({
				...root,
				payload: { assetId: "asset", queryOnly: true },
			});
			expect(createBatch).toHaveBeenCalledOnce();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 61])(
		"rejects an invalid pending review delay before durable handoff: %s",
		async (waitSeconds) => {
			const invoke = vi.fn<InvokeTask>().mockResolvedValue({
				status: "ok",
				poll: { done: false, waitSeconds, queryOnly: true },
			});
			const resume = vi.fn().mockResolvedValue(undefined);
			await expect(runDirectWake(root, "wake", invoke, resume)).rejects.toThrow(
				"INVALID_POLL_WAIT",
			);
			expect(invoke).toHaveBeenCalledOnce();
			expect(resume).not.toHaveBeenCalled();
		},
	);
	it("hands off a claimed child when preparation consumes the fast-path time budget", async () => {
		let now = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const child = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: receipt("transfer"),
		};
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["transfer"] } },
			})
			.mockImplementationOnce(async () => {
				now += 25_001;
				return { status: "ok", preparedEvent: child };
			});
		const resume = vi.fn().mockResolvedValue(undefined);
		try {
			await runDirectWake(root, "wake", invoke, resume);
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(resume).toHaveBeenCalledExactlyOnceWith(child, "wake");
		} finally {
			clock.mockRestore();
		}
	});
	it("persists future events with their due time and no immediate probe", async () => {
		const notBefore = Date.now() + 10_000;
		const invoke = vi.fn<InvokeTask>().mockResolvedValue({
			...done,
			poll: { ...done.poll, continuation: { eventIds: ["later"], notBefore } },
		});
		const resume = vi.fn().mockResolvedValue(undefined);
		await runDirectWake(root, "wake", invoke, resume);
		expect(invoke).toHaveBeenCalledOnce();
		expect(resume).toHaveBeenCalledExactlyOnceWith(
			{ taskId: "media-deliver-events", payload: { eventIds: ["later"] } },
			"wake",
			notBefore,
		);
	});
	it("deduplicates durable accepted-attempt polling independently of the callback identity", async () => {
		const createBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = createWakeContinuationScheduler({
			createBatch,
			get: vi.fn().mockResolvedValue({
				status: async () => ({ status: "running" }),
				restart: async () => undefined,
			}),
		});
		const task = { taskId: "media-poll-generation", payload: { attemptId: "same-attempt" } };
		await scheduler(task, "callback-one");
		await scheduler(task, "callback-two");
		expect(createBatch.mock.calls[0]![0][0].id).toBe(createBatch.mock.calls[1]![0][0].id);
		expect(createBatch.mock.calls[0]![0][0].params).toEqual({
			kind: "continuation",
			request: task,
		});
		await expect(
			scheduler(
				{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
				"wake",
			),
		).rejects.toThrow("WAKE_CONTINUATION_RECEIPT_REQUIRED");
	});
	it("acknowledges without waiting for external work, preserving durable recovery as owner", async () => {
		let complete!: () => void;
		const invoke = vi.fn<InvokeTask>(
			() =>
				new Promise((resolve) => {
					complete = () => resolve(done);
				}),
		);
		const pending: Promise<void>[] = [];
		const response = await handleWake(
			await signed(),
			secret,
			invoke,
			(work) => pending.push(work),
			vi.fn(),
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			accepted: true,
			wake: true,
			id: expect.stringMatching(/^job-[a-f0-9]{64}$/),
		});
		expect(invoke).toHaveBeenCalledOnce();
		expect(pending).toHaveLength(1);
		complete();
		await Promise.all(pending);
	});
	it("authenticates before waking and rejects arbitrary/paid tasks and privileged reinspection", async () => {
		const invoke = vi.fn<InvokeTask>();
		const defer = vi.fn();
		expect(
			(
				await handleWake(
					new Request("https://jobs/internal/wake", { method: "POST", body: "{}" }),
					secret,
					invoke,
					defer,
					vi.fn(),
				)
			).status,
		).toBe(401);
		for (const value of [
			{
				taskId: "media-finalize-generation",
				payload: { jobId: "job", version: 0 },
				idempotencyKey: "one",
			},
			{
				...root,
				payload: { assetId: "asset", allowQuarantinedReverification: true },
				idempotencyKey: "one",
			},
			{ ...root, idempotencyKey: "one", outboxReceipt: receipt("event") },
		])
			expect((await handleWake(await signed(value), secret, invoke, defer, vi.fn())).status).toBe(
				400,
			);
		expect(invoke).not.toHaveBeenCalled();
		expect(defer).not.toHaveBeenCalled();
	});
	it("uses receipts to follow committed transfer, initial review and settlement without Workflow creation", async () => {
		const tasks: Record<string, TaskRequest> = {
			transfer: {
				taskId: "media-finalize-generation",
				payload: { jobId: "job", version: 0 },
				outboxReceipt: receipt("transfer"),
			},
			review: {
				taskId: "media-verify-upload",
				payload: { assetId: "output" },
				outboxReceipt: receipt("review"),
			},
			settle: {
				taskId: "media-settle-generation",
				payload: { jobId: "job", version: 0 },
				outboxReceipt: receipt("settle"),
			},
		};
		const invoke = vi.fn<InvokeTask>(async (task) => {
			if (task.taskId === "media-prepare-event")
				return { status: "ok", preparedEvent: tasks[task.payload.eventId as string]! };
			if (!task.outboxReceipt)
				return {
					...done,
					poll: { ...done.poll, continuation: { eventIds: ["transfer", "transfer"] } },
				};
			if (task.taskId === "media-finalize-generation") {
				expect(task.payload.deferOutputReview).toBe(true);
				return { status: "ok", deliveryState: "completed", continuation: { eventIds: ["review"] } };
			}
			if (task.taskId === "media-verify-upload")
				return {
					...done,
					deliveryState: "completed",
					poll: { ...done.poll, continuation: { eventIds: ["settle"] } },
				};
			return { status: "ok", deliveryState: "completed", continuation: { eventIds: [] } };
		});
		await runDirectWake(root, "wake", invoke, vi.fn().mockResolvedValue(undefined));
		expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
			"media-verify-upload",
			"media-prepare-event",
			"media-finalize-generation",
			"media-prepare-event",
			"media-verify-upload",
			"media-prepare-event",
			"media-settle-generation",
		]);
		expect(new Set(invoke.mock.calls.map(([, context]) => context.runId))).toEqual(
			new Set(["wake"]),
		);
	});
	it("deduplicates the same review wake and receipt when its remaining wait changes", async () => {
		const createBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = createWakeContinuationScheduler({
			createBatch,
			get: async () => ({
				status: async () => ({ status: "running" }),
				restart: async () => undefined,
			}),
		});
		const review = {
			...root,
			payload: { assetId: "asset", queryOnly: true },
			outboxReceipt: receipt("review"),
		};
		await scheduler(review, "same-wake", 1_800_000_003_000);
		await scheduler(review, "same-wake", 1_800_000_003_100);
		await scheduler(review, "same-wake");
		expect(createBatch.mock.calls[0]![0][0].id).toBe(createBatch.mock.calls[1]![0][0].id);
		expect(createBatch.mock.calls[0]![0][0].id).toBe(createBatch.mock.calls[2]![0][0].id);
		expect(createBatch.mock.calls.map(([entries]) => entries[0].params.notBefore)).toEqual([
			1_800_000_003_000,
			1_800_000_003_100,
			undefined,
		]);
	});
	it.each([
		{ status: "failed" as const },
		{ status: "busy" as const, capacityWaited: true },
		{
			status: "ok" as const,
			poll: {
				done: false,
				waitSeconds: 3,
				continuation: { eventIds: ["later"], notBefore: Date.now() + 60_000 },
			},
		},
		{ status: "ok" as const, continuation: { eventIds: [], pollAttemptId: "accepted" } },
	])("does not sleep, retry an uncertain result, or poll a pending provider", async (result) => {
		const invoke = vi.fn<InvokeTask>().mockResolvedValue(result);
		await runDirectWake(root, "wake", invoke, vi.fn().mockResolvedValue(undefined));
		expect(invoke).toHaveBeenCalledOnce();
	});
	it("never runs a prepared child with the wrong identity or without receiver acknowledgement", async () => {
		for (const preparedEvent of [
			undefined,
			{
				taskId: "media-verify-upload",
				payload: { assetId: "asset" },
				outboxReceipt: receipt("other"),
			},
		]) {
			const invoke = vi
				.fn<InvokeTask>()
				.mockResolvedValueOnce({
					...done,
					poll: { ...done.poll, continuation: { eventIds: ["event"] } },
				})
				.mockResolvedValueOnce({ status: "ok", preparedEvent });
			await expect(
				runDirectWake(root, "wake", invoke, vi.fn().mockResolvedValue(undefined)),
			).rejects.toThrow();
			expect(invoke).toHaveBeenCalledTimes(2);
		}
	});
	it("does not replay receipt-lost paid work and retains all future recovery intents", async () => {
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				...done,
				poll: { ...done.poll, continuation: { eventIds: ["submit"] } },
			})
			.mockResolvedValueOnce({
				status: "ok",
				preparedEvent: {
					taskId: "media-dispatch-image-kie-nano-banana-2",
					payload: { jobId: "job", version: 0 },
					outboxReceipt: receipt("submit"),
				},
			})
			.mockResolvedValueOnce({
				status: "ok",
				deliveryState: "lost",
				continuation: { eventIds: ["untrusted"] },
			});
		await runDirectWake(root, "wake", invoke, vi.fn().mockResolvedValue(undefined));
		expect(invoke).toHaveBeenCalledTimes(3);
	});
});
