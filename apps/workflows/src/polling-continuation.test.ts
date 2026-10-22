import type { GenerationPollingStore } from "@repo/jobs";
import { parsePollingTickResult } from "@repo/jobs/orchestration/contracts";
import { executePollingTick } from "@repo/jobs/orchestration/polling";
import { describe, expect, it, vi } from "vitest";

import { createWorkerExecutionHandler } from "./execution";
import { createExecutorInvoker } from "./invoke";
import { runPolling, type DurableSteps, type InvokeTask } from "./orchestrator";
import { runDirectWake } from "./wake";

function fixture() {
	const now = new Date();
	let reads = 0;
	const store: GenerationPollingStore = {
		getPollingState: async () => (reads >= 3 ? null : { pollAt: now, leasedUntil: null }),
		claimStale: async () => [
			{
				jobId: "job",
				version: 1,
				attemptId: "attempt",
				provider: "kie",
				providerTaskId: "remote",
				leaseToken: "lease",
				staleAgeMinutes: 1,
				repairCount: 0,
			},
		],
		recordReconciled: async () => {
			reads++;
			return { outboxCommitted: false };
		},
		releaseReconciliationLease: vi.fn(),
		markUncertainForManualReconciliation: vi.fn(),
	};
	const provider = {
		provider: "kie" as const,
		submit: vi.fn(),
		retrieve: vi.fn(async () => ({
			providerTaskId: "remote",
			status: "RUNNING" as const,
			raw: {},
		})),
		normalizeResult: async () => ({
			outputs: [],
			progress: null,
			providerCostMicros: null,
			failure: null,
			retryable: false,
			providerCharged: false,
		}),
	};
	const secret = "test-only-32-character-shared-secret";
	const handler = createWorkerExecutionHandler({
		secret,
		execute: vi.fn(),
		poll: () =>
			executePollingTick(
				{ attemptId: "attempt" },
				{
					store,
					getProvider: () => provider,
					now: () => now,
				},
			),
	});
	const invoke = vi.fn<InvokeTask>(createExecutorInvoker(secret, () => ({ fetch: handler })));
	return { provider, invoke };
}

describe("persisted immediate query through runtime and continuation consumers", () => {
	it("propagates bounded runtime rechecks through the Workflow without a one/five-second sleep", async () => {
		const f = fixture();
		const sleep = vi.fn();
		const step: DurableSteps = {
			do: async (_name, _options, callback) => callback(),
			sleep,
		};
		await runPolling(
			{ taskId: "media-poll-generation", payload: { attemptId: "attempt" } },
			"run",
			step,
			f.invoke,
		);
		expect(f.invoke).toHaveBeenCalledTimes(2);
		expect(f.provider.retrieve).toHaveBeenCalledTimes(3);
		expect(f.provider.submit).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
	});
	it("continues the same callback query directly while its finite wake budget remains", async () => {
		const f = fixture();
		const resume = vi.fn();
		await runDirectWake(
			{ taskId: "media-poll-generation", payload: { attemptId: "attempt" } },
			"wake",
			f.invoke,
			resume,
		);
		expect(f.invoke).toHaveBeenCalledTimes(2);
		expect(f.provider.retrieve).toHaveBeenCalledTimes(3);
		expect(resume).not.toHaveBeenCalled();
	});
	it("turns a successfully bound pending review into query-only work before immediate continuation", async () => {
		const secret = "test-only-32-character-shared-secret";
		const execute = vi
			.fn()
			.mockResolvedValueOnce({
				done: false,
				waitSeconds: 0,
				retryImmediately: true,
				queryOnly: true,
			})
			.mockResolvedValueOnce({ done: true, waitSeconds: 0, continuation: { eventIds: [] } });
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		const sleep = vi.fn();
		await runPolling(
			{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
			"run",
			{ do: async (_name, _options, callback) => callback(), sleep },
			createExecutorInvoker(secret, () => ({ fetch: handler })),
		);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[0]![0].payload).toEqual({ assetId: "asset" });
		expect(execute.mock.calls[1]![0].payload).toEqual({ assetId: "asset", queryOnly: true });
		expect(sleep).not.toHaveBeenCalled();
	});
	it("immediately consumes a second committed review wake with only query calls", async () => {
		const invoke = vi
			.fn<InvokeTask>()
			.mockResolvedValueOnce({
				status: "ok",
				poll: { done: false, waitSeconds: 0, retryImmediately: true, queryOnly: true },
			})
			.mockResolvedValueOnce({ status: "ok", poll: { done: true, waitSeconds: 0 } });
		const resume = vi.fn();
		await runDirectWake(
			{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
			"wake",
			invoke,
			resume,
		);
		expect(invoke).toHaveBeenCalledTimes(2);
		for (const [task] of invoke.mock.calls) expect(task.payload.queryOnly).toBe(true);
		expect(resume).not.toHaveBeenCalled();
	});
	it("retains durable recovery when immediate callback work exhausts its finite call budget", async () => {
		const invoke = vi.fn<InvokeTask>(async () => ({
			status: "ok",
			poll: { done: false, waitSeconds: 0, retryImmediately: true },
		}));
		const resume = vi.fn();
		const task = { taskId: "media-poll-generation", payload: { attemptId: "attempt" } };
		await runDirectWake(task, "wake", invoke, resume);
		expect(invoke).toHaveBeenCalledTimes(128);
		expect(resume).toHaveBeenCalledExactlyOnceWith(task, "wake");
	});
	it.each([
		{ done: false, waitSeconds: 0 },
		{ done: false, waitSeconds: 0, retryImmediately: "true" },
		{ done: false, waitSeconds: 3, retryImmediately: true },
		{ done: true, waitSeconds: 0, retryImmediately: true },
	])("rejects an invalid immediate query marker: $retryImmediately", (poll) => {
		expect(() => parsePollingTickResult(poll)).toThrow("INVALID_POLL_RESULT");
	});
	it("never treats a first verification submission as an immediate generation query", async () => {
		const sleep = vi.fn();
		await expect(
			runPolling(
				{ taskId: "media-verify-upload", payload: { assetId: "asset" } },
				"run",
				{
					do: async (_name, _options, callback) => callback(),
					sleep,
				},
				async () => ({
					status: "ok",
					poll: { done: false, waitSeconds: 0, retryImmediately: true },
				}),
			),
		).rejects.toThrow("INVALID_IMMEDIATE_POLL");
		expect(sleep).not.toHaveBeenCalled();
	});
});
