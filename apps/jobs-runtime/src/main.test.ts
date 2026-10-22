import type { TaskExecutionContext } from "@repo/jobs/orchestration/contracts";
import { afterEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	execute: vi.fn(),
	poll: vi.fn(async () => ({ done: true, waitSeconds: 0, outboxCommitted: false })),
	disconnect: vi.fn(async () => undefined),
	listen: vi.fn(),
	close: vi.fn(),
	closeIdleConnections: vi.fn(),
	createServer: vi.fn(),
}));

vi.mock("@repo/database/client", () => ({ db: { $disconnect: runtime.disconnect } }));
vi.mock("@repo/jobs/orchestration/executor", () => ({ executeTask: runtime.execute }));
vi.mock("@repo/jobs/orchestration/polling", () => ({ executePollingTick: runtime.poll }));
vi.mock("./server", () => ({ createRuntimeServer: runtime.createServer }));

afterEach(() => vi.restoreAllMocks());

it("passes signed polling context as authority rather than as injected dependencies", async () => {
	runtime.createServer.mockReturnValue(runtime);
	// Observe bootstrap wiring without opening a listener or registering process handlers.
	vi.spyOn(process, "on").mockReturnValue(process);
	await import("./main");
	const options = runtime.createServer.mock.calls[0]![0] as {
		poll(input: { attemptId: string }, context: TaskExecutionContext): Promise<unknown>;
	};
	const input = { attemptId: "attempt" };
	const context: TaskExecutionContext = {
		attempt: 1,
		maxAttempts: 3,
		runId: "workflow",
		workflowId: "workflow",
		phaseOwner: { workflowId: "workflow", phaseKey: "phase", epoch: 1 },
	};
	expect(await options.poll(input, context)).toEqual({
		done: true,
		waitSeconds: 0,
		outboxCommitted: false,
	});
	expect(runtime.poll).toHaveBeenCalledExactlyOnceWith(input, undefined, context);
	expect(runtime.execute).not.toHaveBeenCalled();
});
