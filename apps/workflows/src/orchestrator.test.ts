import { describe, expect, it, vi } from "vitest";

import { runTask, runPolling, runMaintenance, type DurableSteps } from "./orchestrator";

function fakeSteps() {
	const outputs = new Map<string, unknown>();
	return {
		outputs,
		do: vi.fn(async (name, _config, callback) => {
			if (!outputs.has(name)) outputs.set(name, await callback());
			return outputs.get(name);
		}),
		sleep: vi.fn(async () => undefined),
		sleepUntil: vi.fn(async () => undefined),
	} as DurableSteps & {
		outputs: Map<string, unknown>;
		do: ReturnType<typeof vi.fn>;
		sleep: ReturnType<typeof vi.fn>;
		sleepUntil: ReturnType<typeof vi.fn>;
	};
}

describe("durable job orchestration", () => {
	it("treats an explicit empty callback batch as completed without polling or scanning", async () => {
		const step = fakeSteps();
		const invoke = vi.fn().mockResolvedValue({ status: "ok", continuations: [] });
		await runTask({ taskId: "media-deliver-outbox", payload: {} }, "empty-batch", step, invoke);
		expect(invoke).toHaveBeenCalledOnce();
		expect(step.sleep).not.toHaveBeenCalled();
		expect(step.sleepUntil).not.toHaveBeenCalled();
	});

	it("leaves a foreign callback phase owner in charge without polling or following its dependent events", async () => {
		const step = fakeSteps();
		step.phaseOwnership = true;
		const invoke = vi.fn().mockResolvedValue({
			status: "ok",
			continuations: [
				{
					eventIds: ["owner-dependent-event"],
					pollAttemptId: "original-attempt",
					phaseOwner: { workflowId: "other-workflow", phaseKey: "phase", epoch: 3 },
				},
			],
		});
		await runTask(
			{ taskId: "media-deliver-outbox", payload: {} },
			"callback-workflow",
			step,
			invoke,
		);
		expect(invoke).toHaveBeenCalledOnce();
		expect(step.sleep).not.toHaveBeenCalled();
	});

	it("continues inline callback events after parent release through the existing receipt path without another scan", async () => {
		const step = fakeSteps();
		step.targetedEventDelivery = true;
		let maintenanceActive = false;
		const invoke = vi.fn(async (request) => {
			if (request.taskId === "media-deliver-outbox") {
				maintenanceActive = true;
				await Promise.resolve();
				maintenanceActive = false;
				return {
					status: "ok" as const,
					continuations: [
						{ eventIds: ["finalize-event", "finalize-event"] },
						{ eventIds: ["finalize-event"] },
					],
				};
			}
			expect(maintenanceActive).toBe(false);
			if (request.taskId === "media-prepare-event") {
				const id = request.payload.eventId;
				return {
					status: "ok" as const,
					continuation: { eventIds: [] },
					preparedEvent: {
						taskId:
							id === "finalize-event" ? "media-finalize-generation" : "media-settle-generation",
						payload: { jobId: "job", version: 0 },
						outboxReceipt: { eventId: id, workerId: "worker", leaseToken: `lease-${id}` },
					},
				};
			}
			return {
				status: "ok" as const,
				deliveryState: "completed" as const,
				continuation: {
					eventIds: request.taskId === "media-finalize-generation" ? ["settle-event"] : [],
				},
			};
		});
		const request = { taskId: "media-deliver-outbox", payload: {} };
		await runTask(request, "maintenance", step, invoke);
		expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
			"media-deliver-outbox",
			"media-prepare-event",
			"media-finalize-generation",
			"media-prepare-event",
			"media-settle-generation",
		]);
		await runTask(request, "maintenance", step, invoke);
		expect(invoke).toHaveBeenCalledTimes(5);
	});

	it("keeps all callback event identities across batches larger than 100 with at most four branches", async () => {
		const step = fakeSteps();
		const first = Array.from({ length: 100 }, (_, index) => `first-${index}`);
		const second = Array.from({ length: 100 }, (_, index) => `second-${index}`);
		let active = 0;
		let peak = 0;
		const delivered: string[] = [];
		const invoke = vi.fn(async (request) => {
			if (request.taskId === "media-deliver-outbox")
				return {
					status: "ok" as const,
					continuations: [
						{ eventIds: first, notBefore: 1_800_000_001_000 },
						{ eventIds: second, notBefore: 1_800_000_002_000 },
					],
				};
			expect(request.taskId).toBe("media-deliver-events");
			expect(request.payload.eventIds).toHaveLength(1);
			peak = Math.max(peak, ++active);
			await Promise.resolve();
			delivered.push(...request.payload.eventIds);
			active--;
			return { status: "ok" as const, continuation: { eventIds: [] } };
		});
		await runTask({ taskId: "media-deliver-outbox", payload: {} }, "many-callbacks", step, invoke);
		expect(delivered).toEqual([...first, ...second]);
		expect(peak).toBe(4);
		expect(step.sleepUntil.mock.calls.map(([, at]) => at)).toEqual([
			...Array(100).fill(1_800_000_001_000),
			...Array(100).fill(1_800_000_002_000),
		]);
	});

	it("lets ready callbacks progress while another polls and never treats lost ownership as completion", async () => {
		const step = fakeSteps();
		step.phaseOwnership = true;
		const phaseOwner = { workflowId: "callback-run", phaseKey: "phase", epoch: 3 };
		let releasePoll!: () => void;
		const pending = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		let ready!: () => void;
		const didDeliver = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const delivered: string[] = [];
		const invoke = vi.fn(async (request, context) => {
			if (request.taskId === "media-deliver-outbox")
				return {
					status: "ok" as const,
					continuations: [
						{ eventIds: ["blocked-event"], pollAttemptId: "accepted-attempt", phaseOwner },
						{ eventIds: ["ready-1", "ready-2", "ready-3", "ready-4", "ready-5"] },
					],
				};
			if (request.taskId === "media-poll-generation") {
				expect(request.payload.attemptId).toBe("accepted-attempt");
				expect(context.phaseOwner).toEqual(phaseOwner);
				await pending;
				return {
					status: "ok" as const,
					poll: {
						done: false,
						waitSeconds: 60,
						phaseOwnershipLost: true,
						phaseOwner,
						continuation: { eventIds: [] },
					},
				};
			}
			delivered.push(...request.payload.eventIds);
			if (delivered.length === 5) ready();
			return { status: "ok" as const, continuation: { eventIds: [] } };
		});
		const running = runTask(
			{ taskId: "media-deliver-outbox", payload: {} },
			"callback-run",
			step,
			invoke,
		);
		await didDeliver;
		expect(delivered).toEqual(["ready-1", "ready-2", "ready-3", "ready-4", "ready-5"]);
		releasePoll();
		await running;
		expect(delivered).not.toContain("blocked-event");
		expect(
			invoke.mock.calls.filter(([request]) => request.taskId === "media-poll-generation"),
		).toHaveLength(1);
	});

	it("waits until the committed continuation due time before delivering its exact events", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const step = fakeSteps();
			const stages: string[] = [];
			step.sleepUntil.mockImplementation(async () => {
				stages.push("wait");
			});
			const invoke = vi.fn(async (request) => {
				stages.push(request.taskId);
				if (request.taskId === "media-dispatch-image-kie-nano-banana-2")
					return {
						status: "ok" as const,
						continuation: { eventIds: ["queued-event"], notBefore: 1_800_000_002_500 },
					};
				return { status: "ok" as const };
			});
			const request = {
				taskId: "media-dispatch-image-kie-nano-banana-2",
				payload: { jobId: "job", version: 0 },
			};
			await runTask(request, "queued-run", step, invoke);
			expect(stages).toEqual([request.taskId, "wait", "media-deliver-events"]);
			expect(step.sleepUntil).toHaveBeenCalledExactlyOnceWith(
				`${request.taskId}-continue-wait`,
				1_800_000_002_500,
			);
			expect(step.sleep).not.toHaveBeenCalled();
			expect(invoke.mock.calls.map(([task]) => task)).toEqual([
				request,
				{ taskId: "media-deliver-events", payload: { eventIds: ["queued-event"] } },
			]);

			// Replaying cached steps preserves the same sleep identity and deadline,
			// and cannot invoke the already completed provider submission again.
			clock.mockReturnValue(1_800_000_100_000);
			await runTask(request, "queued-run", step, invoke);
			expect(invoke).toHaveBeenCalledTimes(2);
			expect(step.sleepUntil.mock.calls).toEqual([
				[`${request.taskId}-continue-wait`, 1_800_000_002_500],
			]);
		} finally {
			clock.mockRestore();
		}
	});
	it("delivers an overdue continuation immediately without a negative sleep", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_003_000);
		try {
			const step = fakeSteps();
			step.sleepUntil.mockRejectedValue(new Error("You can't sleep until a time in the past"));
			const invoke = vi
				.fn()
				.mockResolvedValue({ status: "ok" })
				.mockResolvedValueOnce({
					status: "ok",
					continuation: { eventIds: ["queued-event"], notBefore: 1_800_000_002_500 },
				});
			await runTask(
				{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
				"overdue-run",
				step,
				invoke,
			);
			expect(step.sleep).not.toHaveBeenCalled();
			expect(step.sleepUntil).not.toHaveBeenCalled();
			expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
				"media-dispatch-image-kie-nano-banana-2",
				"media-deliver-events",
			]);
		} finally {
			clock.mockRestore();
		}
	});
	it("retains successful submission and scheduled recovery if the durable continuation wait fails", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		try {
			const step = fakeSteps();
			step.sleepUntil.mockRejectedValue(new Error("WORKFLOW_SLEEP_UNAVAILABLE"));
			const invoke = vi
				.fn()
				.mockResolvedValue({ status: "ok" })
				.mockResolvedValueOnce({
					status: "ok",
					continuation: { eventIds: ["queued-event"], notBefore: 1_800_000_002_500 },
				});
			const result = await runTask(
				{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
				"failed-wait",
				step,
				invoke,
			);
			expect(result.status).toBe("ok");
			expect(invoke).toHaveBeenCalledOnce();
		} finally {
			clock.mockRestore();
		}
	});
	it("does not wait or scan global events for an empty continuation", async () => {
		const step = fakeSteps();
		const invoke = vi.fn().mockResolvedValue({
			status: "ok",
			continuation: { eventIds: [], notBefore: 1_800_000_002_500 },
		});
		await runTask(
			{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
			"empty-continuation",
			step,
			invoke,
		);
		expect(step.sleep).not.toHaveBeenCalled();
		expect(step.sleepUntil).not.toHaveBeenCalled();
		expect(invoke).toHaveBeenCalledOnce();
	});
	it("keeps the absolute due time after interruption between cached dispatch and starting its wait", async () => {
		let currentTime = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		try {
			const step = fakeSteps();
			step.sleepUntil
				.mockRejectedValueOnce(new Error("INTERRUPTED_BEFORE_WAIT"))
				.mockImplementation(async (_name, dueAt) => {
					currentTime = Math.max(currentTime, Number(dueAt));
				});
			step.sleep.mockImplementation(async (_name, duration) => {
				currentTime += Number.parseInt(duration, 10);
			});
			const invoke = vi
				.fn()
				.mockResolvedValue({ status: "ok" })
				.mockResolvedValueOnce({
					status: "ok",
					continuation: { eventIds: ["queued-event"], notBefore: 1_800_000_002_500 },
				});
			const request = {
				taskId: "media-dispatch-image-kie-nano-banana-2",
				payload: { jobId: "job", version: 0 },
			};
			await runTask(request, "interrupted-wait", step, invoke);
			expect(invoke).toHaveBeenCalledOnce();

			currentTime = 1_800_000_100_000;
			await runTask(request, "interrupted-wait", step, invoke);
			expect(currentTime).toBe(1_800_000_100_000);
			expect(step.sleepUntil.mock.calls).toEqual([
				[`${request.taskId}-continue-wait`, 1_800_000_002_500],
			]);
			expect(step.sleep).not.toHaveBeenCalled();
			expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
				request.taskId,
				"media-deliver-events",
			]);
		} finally {
			clock.mockRestore();
		}
	});
	it("recomputes the remaining absolute delay on replay for legacy steps without sleepUntil", async () => {
		let currentTime = 1_800_000_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		try {
			const step = fakeSteps();
			const legacyStep = { ...step, sleepUntil: undefined };
			step.sleep.mockRejectedValueOnce(new Error("INTERRUPTED_BEFORE_WAIT"));
			const invoke = vi
				.fn()
				.mockResolvedValue({ status: "ok" })
				.mockResolvedValueOnce({
					status: "ok",
					continuation: { eventIds: ["queued-event"], notBefore: 1_800_000_002_500 },
				});
			const request = {
				taskId: "media-dispatch-image-kie-nano-banana-2",
				payload: { jobId: "job", version: 0 },
			};
			await runTask(request, "legacy-interrupted-wait", legacyStep, invoke);
			expect(invoke).toHaveBeenCalledOnce();
			currentTime = 1_800_000_100_000;
			await runTask(request, "legacy-interrupted-wait", legacyStep, invoke);
			expect(step.sleep).toHaveBeenCalledExactlyOnceWith(
				`${request.taskId}-continue-wait`,
				"2500 milliseconds",
			);
			expect(invoke.mock.calls.map(([task]) => task.taskId)).toEqual([
				request.taskId,
				"media-deliver-events",
			]);
		} finally {
			clock.mockRestore();
		}
	});
	it("retains scheduled recovery without replaying finalization when targeted wake fails", async () => {
		const invoke = vi.fn(async (request) =>
			request.taskId === "media-finalize-generation"
				? { status: "ok" as const, outputReview: { waiting: true, eventIds: ["committed-event"] } }
				: { status: "failed" as const },
		);
		expect(
			await runTask(
				{ taskId: "media-finalize-generation", payload: {} },
				"failed-wake",
				fakeSteps(),
				invoke,
			),
		).toMatchObject({ status: "ok" });
		expect(
			invoke.mock.calls.filter(([r]) => r.taskId === "media-finalize-generation"),
		).toHaveLength(1);
		expect(invoke.mock.calls.some(([r]) => r.taskId === "media-deliver-outbox")).toBe(false);
	});
	it("retains ordinary delivery for a mixed technical failure after targeting pending output siblings", async () => {
		const invoke = vi.fn(async (request) =>
			request.taskId === "media-finalize-generation"
				? { status: "ok" as const, outputReview: { waiting: false, eventIds: ["committed-event"] } }
				: { status: "ok" as const },
		);
		await runTask(
			{ taskId: "media-finalize-generation", payload: {} },
			"mixed",
			fakeSteps(),
			invoke,
		);
		expect(invoke.mock.calls.map(([r]) => r.taskId)).toEqual([
			"media-finalize-generation",
			"media-deliver-output-review",
			"media-deliver-outbox",
		]);
	});
	it("hands a pending output to targeted delivery after heavy completion, without maintenance", async () => {
		let heavyActive = false;
		const invoke = vi.fn(async (request) => {
			if (request.taskId === "media-finalize-generation") {
				heavyActive = true;
				await Promise.resolve();
				heavyActive = false;
				return {
					status: "ok" as const,
					outputReview: { waiting: true, eventIds: ["actual-event"] },
				};
			}
			expect(heavyActive).toBe(false);
			if (request.taskId === "media-deliver-outbox") throw new Error("MAINTENANCE_OCCUPIED");
			return { status: "ok" } as const;
		});
		const step = fakeSteps();
		await runTask(
			{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			"handoff",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map(([request]) => request)).toEqual([
			{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			{ taskId: "media-deliver-output-review", payload: { eventId: "actual-event" } },
		]);
		expect(step.sleep).not.toHaveBeenCalled();
		await runTask(
			{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			"handoff",
			step,
			invoke,
		);
		expect(invoke).toHaveBeenCalledTimes(2);
	});
	it("keeps original event due time only on the first poll tick, including capacity waits", async () => {
		const step = fakeSteps();
		const invoke = vi
			.fn()
			.mockResolvedValueOnce({ status: "busy" })
			.mockResolvedValueOnce({
				status: "ok",
				poll: { done: false, waitSeconds: 5, outboxCommitted: false },
			})
			.mockResolvedValueOnce({
				status: "ok",
				poll: { done: true, waitSeconds: 0, outboxCommitted: false },
			});
		await runPolling(
			{
				taskId: "media-verify-upload",
				payload: { assetId: "asset-1" },
				trace: { outboxEventId: "event-1", dueAt: 1_800_000_000_000 },
			},
			"poll-trace",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map(([request]) => request.trace)).toEqual([
			{ outboxEventId: "event-1", dueAt: 1_800_000_000_000, pollTick: 0 },
			{ outboxEventId: "event-1", dueAt: 1_800_000_000_000, pollTick: 0 },
			{ outboxEventId: "event-1", pollTick: 1 },
		]);
		// Durable replay uses the same recorded steps and does not re-execute logs.
		await runPolling(
			{
				taskId: "media-verify-upload",
				payload: { assetId: "asset-1" },
				trace: { outboxEventId: "event-1", dueAt: 1_800_000_000_000 },
			},
			"poll-trace",
			step,
			invoke,
		);
		expect(invoke).toHaveBeenCalledTimes(3);
	});
	it.each(["media-verify-upload", "media-poll-generation"])(
		"does not scan Outbox after a duplicate %s with no committed event",
		async (taskId) => {
			const invoke = vi.fn().mockResolvedValue({
				status: "ok",
				poll: { done: true, waitSeconds: 0, outboxCommitted: false },
			});
			await runTask({ taskId, payload: {} }, "duplicate", fakeSteps(), invoke);
			expect(invoke).toHaveBeenCalledOnce();
		},
	);
	it.each([true, undefined])(
		"retains delivery after committed or legacy polling result %s",
		async (outboxCommitted) => {
			const invoke = vi
				.fn()
				.mockResolvedValue({ status: "ok" })
				.mockResolvedValueOnce({
					status: "ok",
					poll: {
						done: true,
						waitSeconds: 0,
						...(outboxCommitted === undefined ? {} : { outboxCommitted }),
					},
				});
			await runTask({ taskId: "media-verify-upload", payload: {} }, "changed", fakeSteps(), invoke);
			expect(invoke.mock.calls.map(([request]) => request.taskId)).toEqual([
				"media-verify-upload",
				"media-deliver-outbox",
			]);
		},
	);
	it.each([
		"media-finalize-generation",
		"media-process-provider-webhook",
		"media-dispatch-image-kie-nano-banana-2",
	])("delivers the next stage immediately after %s without waiting for cron", async (taskId) => {
		const invoke = vi.fn().mockResolvedValue({ status: "ok" });
		const step = fakeSteps();
		await runTask({ taskId, payload: {} }, "run", step, invoke);
		expect(invoke.mock.calls.map(([request]) => request.taskId)).toEqual([
			taskId,
			"media-deliver-outbox",
		]);
		await runTask({ taskId, payload: {} }, "run", step, invoke);
		expect(invoke).toHaveBeenCalledTimes(2);
	});

	it("keeps a completed generation successful if immediate delivery fails, for cron recovery", async () => {
		const invoke = vi.fn(
			async (request) =>
				({
					status: request.taskId === "media-deliver-outbox" ? "failed" : "ok",
				}) as const,
		);
		const result = await runTask(
			{ taskId: "media-finalize-generation", payload: {} },
			"run",
			fakeSteps(),
			invoke,
		);
		expect(result).toEqual({ status: "ok" });
		expect(
			invoke.mock.calls.filter(([request]) => request.taskId === "media-finalize-generation"),
		).toHaveLength(1);
		expect(invoke.mock.calls.some(([request]) => request.taskId === "media-deliver-outbox")).toBe(
			true,
		);
	});

	it("polls pending image verification durably then immediately resumes finalization", async () => {
		const step = fakeSteps();
		let checks = 0;
		const invoke = vi.fn(async (request) =>
			request.taskId === "media-verify-upload"
				? ({
						status: "ok",
						poll: ++checks === 1 ? { done: false, waitSeconds: 3 } : { done: true, waitSeconds: 0 },
					} as const)
				: ({ status: "ok" } as const),
		);
		await runPolling(
			{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
			"run",
			step,
			invoke,
		);
		expect(step.sleep).toHaveBeenCalledWith("poll-wait-0", "3 seconds");
		expect(invoke.mock.calls.map(([request]) => request.taskId)).toEqual([
			"media-verify-upload",
			"media-verify-upload",
			"media-deliver-outbox",
		]);
	});

	it("consumes a callback continuation from the final maintenance pass without requiring another scan", async () => {
		let scans = 0;
		const invoke = vi.fn(async (request) => {
			if (request.taskId === "media-deliver-outbox")
				return {
					status: "ok" as const,
					continuations: ++scans === 2 ? [{ eventIds: ["late-finalize"] }] : [],
				};
			return { status: "ok" as const, continuation: { eventIds: [] } };
		});
		await runMaintenance(Date.UTC(2026, 8, 19, 5, 45), "cron", fakeSteps(), invoke);
		expect(scans).toBe(2);
		expect(invoke.mock.calls.at(-1)?.[0]).toEqual({
			taskId: "media-deliver-events",
			payload: { eventIds: ["late-finalize"] },
		});
	});

	it("runs maintenance in order instead of competing for the single executor slot", async () => {
		let active = 0;
		let peak = 0;
		const invoke = vi.fn(async () => {
			peak = Math.max(peak, ++active);
			await Promise.resolve();
			active--;
			return { status: "ok" } as const;
		});
		await runMaintenance(Date.UTC(2026, 8, 19, 5, 45), "cron", fakeSteps(), invoke);
		expect(peak).toBe(1);
	});

	it("checks the persisted polling deadline again after capacity waits", async () => {
		let currentTime = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
		try {
			const step = fakeSteps();
			step.sleep.mockImplementation(async (_name, duration) => {
				currentTime += Number.parseInt(duration, 10) * 1000;
			});
			const admissions: number[] = [];
			const invoke = vi.fn(async () => {
				admissions.push(currentTime);
				currentTime += 20_000;
				return { status: "busy" } as const;
			});
			await runPolling(
				{ taskId: "media-poll-generation", payload: { attemptId: "a" } },
				"run",
				step,
				invoke,
			);
			expect(admissions.every((time) => time < 600_000)).toBe(true);
			expect(invoke).toHaveBeenCalledTimes(24);
		} finally {
			clock.mockRestore();
		}
	});
	it("does not spend provider submission attempts while capacity is busy", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue({ status: "ok" })
			.mockResolvedValueOnce({ status: "busy" })
			.mockResolvedValueOnce({ status: "ok" });
		const step = fakeSteps();
		await runTask(
			{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "j", version: 0 } },
			"run",
			step,
			invoke,
		);
		expect(
			invoke.mock.calls
				.filter(([request]) => request.taskId !== "media-deliver-outbox")
				.map((call) => call[1].attempt),
		).toEqual([1, 1]);
		expect(step.sleep).toHaveBeenCalledOnce();
	});

	it("retries a completed server capacity wait immediately without spending an execution attempt", async () => {
		const step = fakeSteps();
		const invoke = vi
			.fn()
			.mockResolvedValueOnce({ status: "busy", capacityWaited: true })
			.mockResolvedValue({ status: "ok", continuation: { eventIds: [] } });
		await runTask(
			{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
			"run",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map(([, context]) => context.attempt)).toEqual([1, 1]);
		expect(step.sleep).not.toHaveBeenCalled();
	});

	it("replays completed steps without repeating a side effect", async () => {
		const invoke = vi.fn().mockResolvedValue({ status: "ok" });
		const step = fakeSteps();
		const request = { taskId: "media-process-payment-event", payload: { paymentEventId: "event" } };
		await runTask(request, "run", step, invoke);
		await runTask(request, "run", step, invoke);
		expect(invoke).toHaveBeenCalledOnce();
	});

	it("passes the final payment attempt context accurately", async () => {
		const invoke = vi.fn().mockResolvedValue({ status: "failed" });
		await expect(
			runTask(
				{ taskId: "media-process-payment-event", payload: { paymentEventId: "e" } },
				"run",
				fakeSteps(),
				invoke,
			),
		).rejects.toThrow("TASK_FAILED");
		expect(invoke).toHaveBeenCalledTimes(8);
		expect(invoke.mock.calls.at(-1)?.[1]).toEqual({ attempt: 8, maxAttempts: 8, runId: "run" });
	});

	it("never retries an uncertain single-attempt provider submission", async () => {
		const invoke = vi.fn().mockRejectedValue(new Error("connection lost"));
		await expect(
			runTask(
				{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "j", version: 0 } },
				"run",
				fakeSteps(),
				invoke,
			),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledOnce();
	});

	it("persists polling decisions and sleeps durably before the next tick", async () => {
		const step = fakeSteps();
		const invoke = vi
			.fn()
			.mockResolvedValue({ status: "ok" })
			.mockResolvedValueOnce({ status: "ok", poll: { done: false, waitSeconds: 20 } })
			.mockResolvedValueOnce({ status: "ok", poll: { done: true, waitSeconds: 0 } });
		await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: "a" } },
			"run",
			step,
			invoke,
		);
		expect(step.sleep).toHaveBeenCalledWith("poll-wait-0", "20 seconds");
		expect(invoke).toHaveBeenCalledTimes(3);
		await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: "a" } },
			"run",
			step,
			invoke,
		);
		expect(invoke).toHaveBeenCalledTimes(3);
	});

	it("finishes other maintenance when one task fails, then reports the failure", async () => {
		const invoke = vi.fn(
			async (request) =>
				({ status: request.taskId === "media-recover-payment-events" ? "failed" : "ok" }) as const,
		);
		await expect(
			runMaintenance(Date.UTC(2026, 8, 8, 0, 1), "cron", fakeSteps(), invoke),
		).rejects.toThrow("MAINTENANCE_FAILED");
		expect(invoke.mock.calls.some(([request]) => request.taskId === "media-deliver-outbox")).toBe(
			true,
		);
		expect(
			invoke.mock.calls.some(([request]) => request.taskId === "media-recover-verifications"),
		).toBe(true);
	});
});
