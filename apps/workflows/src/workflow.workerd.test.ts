import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { JobsWorkflow } from "./index";

// Steps that call the paid Node runtime are mocked; orchestration, checkpoint
// persistence, Workflow binding and durable waits run in real local workerd.
const jobs = (env as Cloudflare.Env).JOBS;
describe("local Workflows runtime", () => {
	it("checkpoints a busy slot, waits, and completes a single-attempt submission", async () => {
		const id = `busy-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				await m.disableSleeps();
				await m.mockStepResult(
					{ name: "media-dispatch-image-kie-nano-banana-2-attempt-1-capacity-0" },
					{ status: "busy" },
				);
				await m.mockStepResult(
					{ name: "media-dispatch-image-kie-nano-banana-2-attempt-1-capacity-1" },
					{ status: "ok" },
				);
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request: {
						taskId: "media-dispatch-image-kie-nano-banana-2",
						payload: { jobId: "j", version: 0 },
					},
				},
			});
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
	it("executes a bounded polling workflow with persisted decisions", async () => {
		const id = `poll-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				await m.disableSleeps();
				await m.mockStepResult(
					{ name: "poll-0-attempt-1-capacity-0" },
					{ status: "ok", poll: { done: false, waitSeconds: 20 } },
				);
				await m.mockStepResult(
					{ name: "poll-1-attempt-1-capacity-0" },
					{ status: "ok", poll: { done: true, waitSeconds: 0 } },
				);
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request: { taskId: "media-poll-generation", payload: { attemptId: "a" } },
				},
			});
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
});
// Retain the explicit export for the integration pool's entrypoint discovery.
export { JobsWorkflow };
