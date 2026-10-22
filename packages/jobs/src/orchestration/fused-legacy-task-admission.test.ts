import type { PrismaClient } from "@repo/database/generated-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskExecutionContext, TaskRequest } from "./contracts";
import { parseTaskRequest, taskDefinition } from "./registry";

const mocks = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock("@repo/database", () => ({ beginWorkflowOutboxExecution: mocks.begin }));

import {
	consumeFusedLegacyTaskAdmission,
	createFusedLegacyTaskAdmission,
} from "./fused-legacy-task-admission";

function fixture(
	request: Pick<TaskRequest, "taskId" | "payload"> = {
		taskId: "media-dispatch-image-kie-nano-banana-2",
		payload: { jobId: "job", version: 0 },
	},
) {
	const database = {} as PrismaClient;
	const prepared = parseTaskRequest({
		...request,
		trace: { outboxEventId: "event", dueAt: 100 },
		outboxReceipt: { eventId: "event", workerId: "workflow:run", leaseToken: "lease" },
	});
	const { outboxReceipt, ...task } = prepared;
	const context: TaskExecutionContext = {
		runId: "run",
		workflowId: "workflow",
		attempt: 1,
		maxAttempts: taskDefinition(prepared.taskId).maxAttempts,
	};
	const input = {
		...outboxReceipt!,
		timeoutSeconds: taskDefinition(prepared.taskId).timeoutSeconds,
	};
	const assetReview = prepared.taskId === "media-verify-upload";
	const observation = {
		aggregateType: assetReview ? "MEDIA_ASSET" : "GENERATION_JOB",
		aggregateId: assetReview ? prepared.payload.assetId : prepared.payload.jobId,
		engine: "legacy",
	};
	const active = {
		state: "active",
		event: {
			id: "event",
			leaseOwner: "workflow:run",
			leaseToken: "lease",
			lastError: "EXECUTION_IN_PROGRESS:00000000-0000-4000-8000-000000000000",
			...observation,
		},
		engineObservation: observation,
	};
	mocks.begin.mockResolvedValue(active);
	const scope = createFusedLegacyTaskAdmission(database, prepared, context);
	return { database, prepared, task, context, input, active, scope };
}

beforeEach(() => vi.resetAllMocks());

describe("request-local fused legacy admission", () => {
	it.each([
		{ taskId: "media-dispatch-image-kie-nano-banana-2", payload: { jobId: "job", version: 0 } },
		{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
	])("reuses the guarded engine observation once for $taskId", async (request) => {
		const f = fixture(request);
		await f.scope.begin(f.input);
		expect(mocks.begin).toHaveBeenCalledExactlyOnceWith(
			{ ...f.input, observeExecutionEngine: true },
			f.database,
		);
		const proof = f.scope.proofFor(f.task);
		expect(proof).toBeDefined();
		expect(consumeFusedLegacyTaskAdmission(proof, f.task, f.context, f.database)).toBe(true);
		expect(consumeFusedLegacyTaskAdmission(proof, f.task, f.context, f.database)).toBe(false);
		expect(f.scope.proofFor(f.task)).toBeUndefined();
	});

	it.each([undefined, null, "video-workflow-v1", "unknown"])(
		"retains the outer read when the observed engine is %s",
		async (engine) => {
			const f = fixture();
			mocks.begin.mockResolvedValue({
				...f.active,
				engineObservation:
					engine === undefined ? undefined : { ...f.active.engineObservation, engine },
			});
			await f.scope.begin(f.input);
			expect(f.scope.proofFor(f.task)).toBeUndefined();
		},
	);

	it.each([
		{ taskId: "media-verify-upload", payload: { assetId: "asset", queryOnly: true } },
		{
			taskId: "media-verify-upload",
			payload: { assetId: "asset", allowQuarantinedReverification: true },
		},
		{
			taskId: "media-dispatch-image-gemini-gemini-2.5-flash-image",
			payload: { jobId: "job", version: 0 },
		},
		{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
		{ taskId: "media-settle-generation", payload: { jobId: "job", version: 0 } },
	])(
		"keeps query admission, heavy and unrelated tasks on their original path: $taskId",
		async (request) => {
			const f = fixture(request);
			await f.scope.begin(f.input);
			expect(mocks.begin).toHaveBeenCalledWith(
				{ ...f.input, observeExecutionEngine: false },
				f.database,
			);
			expect(f.scope.proofFor(f.task)).toBeUndefined();
		},
	);

	it.each(["completed", "lost", "recovery-required"])(
		"never grants proof for %s receipts",
		async (state) => {
			const f = fixture();
			mocks.begin.mockResolvedValue({ ...f.active, state });
			await f.scope.begin(f.input);
			expect(f.scope.proofFor(f.task)).toBeUndefined();
		},
	);

	it.each(["json", "spread", "structured-clone", "prototype"])(
		"rejects a %s copy of a proof",
		async (kind) => {
			const f = fixture();
			await f.scope.begin(f.input);
			const proof = f.scope.proofFor(f.task)!;
			const copy =
				kind === "json"
					? JSON.parse(JSON.stringify(proof))
					: kind === "spread"
						? { ...(proof as object) }
						: kind === "structured-clone"
							? structuredClone(proof)
							: Object.create(Object.getPrototypeOf(proof));
			expect(consumeFusedLegacyTaskAdmission(copy, f.task, f.context, f.database)).toBe(false);
			expect(consumeFusedLegacyTaskAdmission(proof, f.task, f.context, f.database)).toBe(true);
		},
	);

	it.each([
		"task-clone",
		"context-clone",
		"other-client",
		"payload",
		"trace",
		"runId",
		"workflowId",
		"phaseOwner",
		"eventId",
		"workerId",
		"leaseToken",
	])("rejects %s changes and burns the attempted proof", async (mutation) => {
		const f = fixture();
		await f.scope.begin(f.input);
		const proof = f.scope.proofFor(f.task)!;
		let task = f.task;
		let context = f.context;
		let database = f.database;
		if (mutation === "task-clone") task = structuredClone(task);
		else if (mutation === "context-clone") context = { ...context };
		else if (mutation === "other-client") database = {} as PrismaClient;
		else if (mutation === "payload") task.payload.version = 1;
		else if (mutation === "trace") task.trace!.dueAt = 200;
		else if (mutation === "runId") context.runId = "other";
		else if (mutation === "workflowId") context.workflowId = "other";
		else if (mutation === "phaseOwner")
			context.phaseOwner = { workflowId: "workflow", phaseKey: "old-input", epoch: 1 };
		else f.prepared.outboxReceipt![mutation as "eventId" | "workerId" | "leaseToken"] = "other";
		expect(consumeFusedLegacyTaskAdmission(proof, task, context, database)).toBe(false);
		expect(consumeFusedLegacyTaskAdmission(proof, f.task, f.context, f.database)).toBe(false);
	});

	it("does not move a grant to a different request or a mutated target", async () => {
		const first = fixture();
		const second = fixture();
		await first.scope.begin(first.input);
		await second.scope.begin(second.input);
		const proof = first.scope.proofFor(first.task);
		expect(
			consumeFusedLegacyTaskAdmission(proof, second.task, second.context, second.database),
		).toBe(false);
		second.task.payload.jobId = "different";
		expect(second.scope.proofFor(second.task)).toBeUndefined();
	});

	it("does not authorize another receipt, even if an adapter returns a legacy engine", async () => {
		const f = fixture();
		await f.scope.begin({ ...f.input, leaseToken: "different" });
		expect(mocks.begin).toHaveBeenCalledWith(
			{ ...f.input, leaseToken: "different", observeExecutionEngine: false },
			f.database,
		);
		expect(f.scope.proofFor(f.task)).toBeUndefined();
	});

	it("does not retry an unknown begin response", async () => {
		const f = fixture();
		const failure = new Error("COMMIT response lost");
		mocks.begin.mockRejectedValue(failure);
		await expect(f.scope.begin(f.input)).rejects.toBe(failure);
		expect(mocks.begin).toHaveBeenCalledOnce();
		expect(f.scope.proofFor(f.task)).toBeUndefined();
	});
});
