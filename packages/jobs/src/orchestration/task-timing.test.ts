import { afterEach, describe, expect, it, vi } from "vitest";

import { logTaskStarted } from "./task-timing";

const context = { attempt: 1, maxAttempts: 8, runId: "run-1" };
const request = {
	taskId: "media-poll-generation",
	payload: {
		attemptId: "attempt-1",
		prompt: "never-log",
		sourceUrl: "https://private/?token=never-log",
	},
	trace: { requestId: "request-1", outboxEventId: "event-1", dueAt: 1_000, pollTick: 0 },
};

afterEach(() => vi.restoreAllMocks());

describe("task execution timing", () => {
	it("records the first admitted event start using bounded identity fields only", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		logTaskStarted(request, context, 3_500);
		expect(info).toHaveBeenCalledExactlyOnceWith("media.task.started", {
			taskId: "media-poll-generation",
			runId: "run-1",
			executionAttempt: 1,
			attemptId: "attempt-1",
			requestId: "request-1",
			outboxEventId: "event-1",
			dueAt: 1_000,
			pollTick: 0,
			startedAt: 3_500,
			dueToStartMs: 2_500,
			pollDueToStartMs: null,
		});
		expect(JSON.stringify(info.mock.calls)).not.toContain("never-log");
	});

	it.each([
		{ pollTick: 1, attempt: 1 },
		{ pollTick: 0, attempt: 2 },
	])(
		"does not count planned poll waits or retry work as first delivery delay: %o",
		({ pollTick, attempt }) => {
			const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
			logTaskStarted(
				{ ...request, trace: { ...request.trace, pollTick } },
				{ ...context, attempt },
				10_000,
			);
			expect(info).toHaveBeenCalledExactlyOnceWith(
				"media.task.started",
				expect.objectContaining({
					executionAttempt: attempt,
					pollTick,
					dueToStartMs: null,
					pollDueToStartMs: null,
				}),
			);
		},
	);

	it("does not fail execution when logging is unavailable", () => {
		vi.spyOn(console, "info").mockImplementation(() => {
			throw new Error("unavailable");
		});
		expect(() => logTaskStarted(request, context, 3_500)).not.toThrow();
	});
});
