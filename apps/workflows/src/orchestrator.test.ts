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
			.mockResolvedValueOnce({ status: "busy" })
			.mockResolvedValueOnce({ status: "ok" });
		const step = fakeSteps();
		await runTask(
			{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "j", version: 0 } },
			"run",
			step,
			invoke,
		);
		expect(invoke.mock.calls.map((call) => call[1].attempt)).toEqual([1, 1]);
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
			.mockResolvedValueOnce({ status: "ok", poll: { done: false, waitSeconds: 20 } })
			.mockResolvedValueOnce({ status: "ok", poll: { done: true, waitSeconds: 0 } });
		await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: "a" } },
			"run",
			step,
			invoke,
		);
		expect(step.sleep).toHaveBeenCalledWith("poll-wait-0", "20 seconds");
		expect(invoke).toHaveBeenCalledTimes(2);
		await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: "a" } },
			"run",
			step,
			invoke,
		);
		expect(invoke).toHaveBeenCalledTimes(2);
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
