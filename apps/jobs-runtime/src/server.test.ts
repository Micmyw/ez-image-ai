import type { Server } from "node:http";

import { signRequest } from "@repo/jobs/orchestration/auth";
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
async function start(execute = vi.fn().mockResolvedValue(undefined), maxActive = 4) {
	const server = createRuntimeServer({ secret, execute, poll: vi.fn(), maxActive });
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
