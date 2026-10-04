import { describe, expect, it, vi } from "vitest";

import { ensureVideoWorkflowStarted } from "./admission";
import type { VideoWorkflowBinding } from "./contracts";

function store() {
	return {
		load: vi.fn(async () => ({
			workflowInstanceId: "video-v1-job-1",
			startState: "PENDING" as const,
			executionEngine: "video-workflow-v1",
		})),
		recordAttempt: vi.fn(async () => undefined),
		recordStarted: vi.fn(async () => undefined),
		recordPending: vi.fn(async () => undefined),
	};
}
describe("video V1 durable direct start", () => {
	it("starts the stable Workflow instance immediately without global dispatch", async () => {
		const dependencies = store();
		const create = vi.fn(async () => ({
			status: async () => ({ status: "queued" }),
			sendEvent: async () => undefined,
		}));
		const binding: VideoWorkflowBinding = { create, get: vi.fn() };
		expect(await ensureVideoWorkflowStarted("job-1", binding, dependencies)).toBe("STARTED");
		expect(create).toHaveBeenCalledExactlyOnceWith({
			id: "video-v1-job-1",
			params: { jobId: "job-1", schemaVersion: 1 },
		});
		expect(dependencies.recordStarted).toHaveBeenCalledOnce();
	});
	it("recovers a successful create whose response was lost using the same ID", async () => {
		const dependencies = store();
		const binding = {
			create: vi.fn(async () => {
				throw new Error("response-lost");
			}),
			get: vi.fn(async () => ({
				status: async () => ({ status: "running" }),
				sendEvent: async () => undefined,
			})),
		} satisfies VideoWorkflowBinding;
		expect(await ensureVideoWorkflowStarted("job-1", binding, dependencies)).toBe("STARTED");
		expect(binding.get).toHaveBeenCalledExactlyOnceWith("video-v1-job-1");
		expect(binding.create).toHaveBeenCalledTimes(1);
		expect(dependencies.recordPending).not.toHaveBeenCalled();
	});
	it("leaves a failed start query as durable pending and never creates a replacement ID", async () => {
		const dependencies = store();
		const binding = {
			create: vi.fn(async () => {
				throw new Error("network");
			}),
			get: vi.fn(async () => {
				throw new Error("network");
			}),
		} satisfies VideoWorkflowBinding;
		expect(await ensureVideoWorkflowStarted("job-1", binding, dependencies)).toBe("PENDING");
		expect(dependencies.recordPending).toHaveBeenCalledExactlyOnceWith("job-1");
		expect(binding.create).toHaveBeenCalledTimes(1);
	});
	it("keeps the durable intent when the binding is absent", async () => {
		const dependencies = store();
		expect(await ensureVideoWorkflowStarted("job-1", undefined, dependencies)).toBe("PENDING");
		expect(dependencies.recordAttempt).not.toHaveBeenCalled();
	});
	it("never starts legacy jobs or tampered workflow identities", async () => {
		const dependencies = store();
		dependencies.load.mockResolvedValue({
			workflowInstanceId: "other",
			startState: "PENDING",
			executionEngine: "legacy",
		});
		await expect(ensureVideoWorkflowStarted("job-1", undefined, dependencies)).rejects.toThrow(
			"VIDEO_EXECUTION_NOT_FOUND",
		);
	});
});
