import type { Server } from "node:http";

import { signRequest } from "@repo/jobs/orchestration/auth";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeServer } from "./server";

const secret = "test-only-32-character-shared-secret";
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
async function start(
	execute = vi.fn().mockResolvedValue(undefined),
	maxActive = 4,
	poll = vi.fn(),
) {
	const server = createRuntimeServer({ secret, execute, poll, maxActive });
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	return { url: `http://127.0.0.1:${address.port}`, execute };
}
async function request(url: string, taskId = "media-finalize-generation") {
	const body = JSON.stringify({
		request: { taskId, payload: { jobId: "job", version: 0 } },
		context: { attempt: 1, maxAttempts: 5, runId: "run" },
	});
	return fetch(`${url}/internal/execute`, {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

describe("private Node runtime", () => {
	it("uses the same bounded continuation contract for hybrid execution", async () => {
		const execute = vi.fn().mockResolvedValue({
			continuation: { eventIds: ["event"], pollAttemptId: "attempt", privateUrl: "hidden" },
		});
		const { url } = await start(execute);
		expect(await (await request(url)).json()).toEqual({
			status: "ok",
			continuation: { eventIds: ["event"], pollAttemptId: "attempt" },
		});
		execute.mockResolvedValueOnce({ continuation: { eventIds: ["https://private/token"] } });
		expect((await request(url)).status).toBe(502);
	});
	it("preserves the bounded output continuation across hybrid execution", async () => {
		const { url } = await start(
			vi.fn().mockResolvedValue({
				outcome: "WAITING_MODERATION",
				outputReviewEventIds: ["event"],
				privateUrl: "hidden",
			}),
		);
		expect(await (await request(url)).json()).toEqual({
			status: "ok",
			outputReview: { waiting: true, eventIds: ["event"] },
		});
	});
	it.each(["media-poll-generation", "media-verify-upload"])(
		"records admitted execution once for the hybrid %s path",
		async (taskId) => {
			const timestamp = new Date("2026-09-30T00:00:05Z").getTime();
			const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
			const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
			try {
				const result = { done: true, waitSeconds: 0, outboxCommitted: false };
				const execute = vi.fn().mockResolvedValue(result);
				const poll = vi.fn().mockResolvedValue(result);
				const { url } = await start(execute, 4, poll);
				const payload =
					taskId === "media-poll-generation" ? { attemptId: "attempt-1" } : { assetId: "asset-1" };
				const body = JSON.stringify({
					request: {
						taskId,
						payload,
						trace: { outboxEventId: "event-1", dueAt: timestamp - 2_500, pollTick: 0 },
					},
					context: {
						attempt: 1,
						maxAttempts: taskDefinition(taskId).maxAttempts,
						runId: "timed-run",
					},
				});
				const response = await fetch(`${url}/internal/execute`, {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				});
				expect(response.status).toBe(200);
				expect(info).toHaveBeenCalledExactlyOnceWith(
					"media.task.started",
					expect.objectContaining({
						taskId,
						...payload,
						outboxEventId: "event-1",
						startedAt: timestamp,
						dueToStartMs: 2_500,
						pollTick: 0,
					}),
				);
				expect(taskId === "media-poll-generation" ? poll : execute).toHaveBeenCalledOnce();
			} finally {
				info.mockRestore();
				clock.mockRestore();
			}
		},
	);
	it("returns only bounded moderation polling state for the hybrid workflow", async () => {
		const { url } = await start(
			vi.fn().mockResolvedValue({
				done: false,
				waitSeconds: 3,
				outboxCommitted: false,
				providerSecret: "private",
			}),
		);
		const body = JSON.stringify({
			request: { taskId: "media-verify-upload", payload: { assetId: "asset" } },
			context: { attempt: 1, maxAttempts: 8, runId: "run" },
		});
		const response = await fetch(`${url}/internal/execute`, {
			method: "POST",
			body,
			headers: await signRequest(secret, "POST", "/internal/execute", body),
		});
		expect(await response.json()).toEqual({
			status: "ok",
			poll: { done: false, waitSeconds: 3, outboxCommitted: false },
		});
	});

	it("requires authentication before executing a task", async () => {
		const { url, execute } = await start();
		expect((await fetch(`${url}/internal/execute`, { method: "POST", body: "{}" })).status).toBe(
			401,
		);
		expect(execute).not.toHaveBeenCalled();
	});
	it("reports busy without starting work and counts active work until it finishes", async () => {
		let finish!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const { url } = await start(execute, 1);
		const first = request(url);
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		expect(await (await fetch(`${url}/health`)).json()).toEqual({ active: 1 });
		expect((await request(url)).status).toBe(429);
		finish();
		expect((await first).status).toBe(200);
		expect(await (await fetch(`${url}/health`)).json()).toEqual({ active: 0 });
	});
	it("does not return provider results or error details", async () => {
		const { url, execute } = await start(
			vi.fn().mockResolvedValue({ providerSecret: "private-output" }),
		);
		const response = await request(url);
		expect(await response.json()).toEqual({ status: "ok" });
		execute.mockRejectedValueOnce(new Error("private provider credential"));
		const failed = await request(url);
		expect(failed.status).toBe(502);
		expect(await failed.text()).not.toContain("private");
	});
});
