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
	} as DurableSteps & {
		outputs: Map<string, unknown>;
		do: ReturnType<typeof vi.fn>;
		sleep: ReturnType<typeof vi.fn>;
	};
}

describe("durable job orchestration", () => {
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
