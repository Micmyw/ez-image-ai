import { signRequest } from "@repo/jobs/orchestration/auth";
import { OutboxDeliveryPendingError } from "@repo/jobs/orchestration/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowBindingDispatcher, handleDispatch, type WorkflowCreator } from "./dispatch";

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
	it("dispatches nested jobs through the binding and waits for durable completion on replay", async () => {
		const publicFetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("SELF_FETCH_BLOCKED"));
		try {
			const workflows = binding();
			const dispatch = createWorkflowBindingDispatcher({
				url: "https://jobs.example/internal/dispatch",
				secret,
				workflows,
			});
			const options = { idempotencyKey: "outbox:payment-1", requireCompletion: true };
			await expect(
				dispatch("media-process-payment-event", { paymentEventId: "payment-1" }, options),
			).rejects.toBeInstanceOf(OutboxDeliveryPendingError);
			workflows.get.mockResolvedValue({
				status: vi.fn().mockResolvedValue({ status: "complete" }),
				restart: workflows.restart,
			});
			await expect(
				dispatch("media-process-payment-event", { paymentEventId: "payment-1" }, options),
			).resolves.toBeUndefined();
			expect(workflows.createBatch.mock.calls[0]?.[0][0].id).toBe(
				workflows.createBatch.mock.calls[1]?.[0][0].id,
			);
			expect(workflows.createBatch.mock.calls[0]?.[0][0].params).toEqual({
				kind: "task",
				request: {
					taskId: "media-process-payment-event",
					payload: { paymentEventId: "payment-1" },
				},
			});
			expect(publicFetch).not.toHaveBeenCalled();
		} finally {
			publicFetch.mockRestore();
		}
	});
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
	it.each([
		["paypal", "errored"],
		["waffo", "terminated"],
	])(
		"resumes a signed %s payment reconciliation after %s without changing its identity",
		async (provider, status) => {
			const workflows = binding(status);
			const response = await handleDispatch(
				await signed("media-reconcile-provider-payments", { provider }),
				secret,
				workflows,
			);
			expect(response.status).toBe(202);
			expect(workflows.restart).toHaveBeenCalledOnce();
			const result = (await response.json()) as { id: string };
			expect(result).toMatchObject({ accepted: true, completed: false });
			expect(workflows.createBatch.mock.calls[0]?.[0][0]).toMatchObject({
				id: result.id,
				params: {
					kind: "task",
					request: { taskId: "media-reconcile-provider-payments", payload: { provider } },
				},
			});
			expect(workflows.get).toHaveBeenCalledExactlyOnceWith(result.id);
		},
	);
});
