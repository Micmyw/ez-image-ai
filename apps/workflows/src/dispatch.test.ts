import { signRequest } from "@repo/jobs/orchestration/auth";
import { describe, expect, it, vi } from "vitest";

import { handleDispatch, type WorkflowCreator } from "./dispatch";

const secret = "test-only-32-character-shared-secret";
async function signed(
	taskId = "media-finalize-generation",
	payload: Record<string, unknown> = { jobId: "j", version: 0 },
) {
	const body = JSON.stringify({ taskId, payload, idempotencyKey: "stable-delivery" });
	return new Request("https://jobs.example/internal/dispatch", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/dispatch", body),
	});
}
function binding(status = "queued") {
	const restart = vi.fn().mockResolvedValue(undefined);
	const workflow = { status: vi.fn().mockResolvedValue({ status }), restart };
	const createBatch = vi.fn().mockResolvedValue([]);
	return {
		createBatch,
		get: vi.fn().mockResolvedValue(workflow),
		restart,
	} satisfies WorkflowCreator & { restart: typeof restart };
}

describe("Workflow ingress", () => {
	it("rejects unauthenticated and arbitrary task dispatch", async () => {
		const workflows = binding();
		expect(
			(
				await handleDispatch(
					new Request("https://jobs.example/internal/dispatch", { method: "POST", body: "{}" }),
					secret,
					workflows,
				)
			).status,
		).toBe(401);
		expect(
			(
				await handleDispatch(
					await signed("arbitrary-fetch", { url: "http://internal/secret" }),
					secret,
					workflows,
				)
			).status,
		).toBe(400);
		expect(workflows.createBatch).not.toHaveBeenCalled();
	});
	it("returns acceptance only after persistence and uses the same ID on delivery replay", async () => {
		const workflows = binding();
		const first = await handleDispatch(await signed(), secret, workflows);
		const second = await handleDispatch(await signed(), secret, workflows);
		expect(first.status).toBe(202);
		expect(await first.json()).toEqual(await second.json());
		expect(workflows.createBatch.mock.calls[0]?.[0][0].id).toBe(
			workflows.createBatch.mock.calls[1]?.[0][0].id,
		);
		workflows.createBatch.mockRejectedValueOnce(new Error("service unavailable"));
		expect((await handleDispatch(await signed(), secret, workflows)).status).toBe(503);
	});
	it("never restarts failed generation submission but can resume recovery continuation", async () => {
		const workflows = binding("errored");
		expect(
			(
				await handleDispatch(
					await signed("media-dispatch-image-kie-nano-banana-2"),
					secret,
					workflows,
				)
			).status,
		).toBe(503);
		expect(workflows.restart).not.toHaveBeenCalled();
		expect(
			(
				await handleDispatch(
					await signed("media-poll-generation", { attemptId: "a" }),
					secret,
					workflows,
				)
			).status,
		).toBe(202);
		expect(workflows.restart).toHaveBeenCalledOnce();
	});
});
