import { signRequest } from "@repo/jobs/orchestration/auth";
import { describe, expect, it, vi } from "vitest";

import { createWorkerExecutionHandler, type WorkerExecutionOptions } from "./execution";

const secret = "test-only-32-character-shared-secret";

async function signed(
	taskId = "media-finalize-generation",
	context = { attempt: 1, maxAttempts: 5, runId: "run" },
) {
	const body = JSON.stringify({
		request: { taskId, payload: { jobId: "job", version: 0 } },
		context,
	});
	return new Request("https://executor/internal/execute", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

describe("Workers job admission", () => {
	it("reports saturation and elapsed execution without letting telemetry replay work", async () => {
		let finish!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const onEvent = vi.fn<NonNullable<WorkerExecutionOptions["onEvent"]>>(() => {
			throw new Error("telemetry unavailable");
		});
		const handler = createWorkerExecutionHandler({
			secret,
			execute,
			poll: vi.fn(),
			maxActive: 1,
			onEvent,
		});
		const first = handler(await signed());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		expect((await handler(await signed())).status).toBe(429);
		finish();
		expect((await first).status).toBe(200);
		expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
			expect.objectContaining({ phase: "busy", active: 1, maximum: 1 }),
			expect.objectContaining({
				phase: "completed",
				active: 0,
				outcome: "ok",
				elapsedMs: expect.any(Number),
			}),
		]);
		expect(execute).toHaveBeenCalledOnce();
	});
	it("returns only moderation polling control state and rejects malformed results", async () => {
		const execute = vi
			.fn()
			.mockResolvedValue({ done: false, waitSeconds: 3, providerSecret: "private" });
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		const body = JSON.stringify({
			request: { taskId: "media-verify-upload", payload: { assetId: "asset" } },
			context: { attempt: 1, maxAttempts: 8, runId: "run" },
		});
		const request = async () =>
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			});
		expect(await (await handler(await request())).json()).toEqual({
			status: "ok",
			poll: { done: false, waitSeconds: 3 },
		});
		execute.mockResolvedValueOnce({ done: false, waitSeconds: -1, providerSecret: "private" });
		expect(await (await handler(await request())).json()).toEqual({ status: "failed" });
	});

	it("authenticates and validates before creating runtime resources", async () => {
		const execute = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		expect(
			(
				await handler(
					new Request("https://executor/internal/execute", { method: "POST", body: "{}" }),
				)
			).status,
		).toBe(401);
		expect(
			(await handler(await signed(undefined, { attempt: 1, maxAttempts: 999, runId: "run" })))
				.status,
		).toBe(400);
		expect(execute).not.toHaveBeenCalled();
	});

	it("holds capacity until actual execution finishes, even after request cancellation", async () => {
		let finish!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn(), maxActive: 1 });
		const abort = new AbortController();
		const first = handler(new Request(await signed(), { signal: abort.signal }));
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		abort.abort();
		expect((await handler(await signed())).status).toBe(429);
		finish();
		expect((await first).status).toBe(200);
		execute.mockResolvedValueOnce(undefined);
		expect((await handler(await signed())).status).toBe(200);
	});

	it("enforces per-queue capacity and sanitizes handler results/errors", async () => {
		let finish!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<unknown>((resolve) => {
					finish = () => resolve({ providerSecret: "private" });
				}),
		);
		const handler = createWorkerExecutionHandler({
			secret,
			execute,
			poll: vi.fn(),
			maxActive: 4,
			env: { MEDIA_FINALIZATION_CONCURRENCY: "1" },
		});
		const first = handler(await signed());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		expect((await handler(await signed())).status).toBe(429);
		finish();
		expect(await (await first).json()).toEqual({ status: "ok" });
		execute.mockRejectedValueOnce(new Error("private provider secret"));
		const failed = await handler(await signed());
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({ status: "failed" });
	});
});
