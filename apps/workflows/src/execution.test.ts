import { signRequest } from "@repo/jobs/orchestration/auth";
import {
	OutputTransferClaimConflictError,
	SettlementTransactionConflictError,
	type TaskRequest,
} from "@repo/jobs/orchestration/contracts";
import { taskDefinition } from "@repo/jobs/orchestration/registry";
import { describe, expect, it, vi } from "vitest";

import { createWorkerExecutionHandler, type WorkerExecutionOptions } from "./execution";

const secret = "test-only-32-character-shared-secret";

async function signed(
	taskId = "media-finalize-generation",
	context = { attempt: 1, maxAttempts: 5, runId: "run" },
	waitForCapacityMs?: number,
) {
	const body = JSON.stringify({
		request: { taskId, payload: { jobId: "job", version: 0 } },
		context,
		...(waitForCapacityMs === undefined ? {} : { waitForCapacityMs }),
	});
	return new Request("https://executor/internal/execute", {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

describe("Workers job admission", () => {
	it("preserves a fused review receipt and its durable phase owner", async () => {
		const phaseOwner = { workflowId: "workflow", phaseKey: "phase", epoch: 2 };
		const request = { taskId: "media-execute-event", payload: { eventId: "event" } };
		const context = {
			attempt: 1,
			maxAttempts: 1,
			runId: "workflow",
			workflowId: "workflow",
			phaseOwner,
		};
		const result = {
			preparedEvent: null,
			executedEvent: {
				taskId: "media-verify-upload",
				payload: { assetId: "asset" },
				outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "lease" },
			},
			deliveryState: "pending",
			poll: {
				done: false,
				waitSeconds: 5,
				queryOnly: true,
				phaseOwner,
				continuation: { eventIds: [] },
			},
		};
		const execute = vi.fn().mockResolvedValue(result);
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		const body = JSON.stringify({ request, context });
		const response = await handler(
			new Request("https://executor/internal/execute", {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", ...result });
		expect(execute).toHaveBeenCalledExactlyOnceWith(request, context);
	});
	it("rejects unbound owners and unknown signed execution fields before execution", async () => {
		const phaseOwner = { workflowId: "workflow", phaseKey: "phase", epoch: 2 };
		const context = {
			attempt: 1,
			maxAttempts: 1,
			runId: "workflow",
			workflowId: "workflow",
			phaseOwner,
		};
		const value = {
			request: { taskId: "media-execute-event", payload: { eventId: "event" } },
			context,
		};
		const execute = vi.fn();
		const poll = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll });
		for (const invalid of [
			{ ...value, admin: true },
			{ ...value, context: { ...context, admin: true } },
			{ ...value, context: { ...context, workflowId: undefined } },
			{ ...value, context: { ...context, workflowId: "different" } },
			{ ...value, context: { ...context, phaseOwner: { ...phaseOwner, workflowId: "different" } } },
			{ ...value, context: { ...context, phaseOwner: { ...phaseOwner, epoch: 0 } } },
			{ ...value, context: { ...context, phaseOwner: { ...phaseOwner, signal: true } } },
		]) {
			const body = JSON.stringify(invalid);
			const response = await handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
			expect(response.status).toBe(400);
		}
		expect(execute).not.toHaveBeenCalled();
		expect(poll).not.toHaveBeenCalled();
	});
	it("offers pre-claim retries only for a nominal error, receipt and exact capability", async () => {
		const task = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const execute = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn(), maxActive: 1 });
		for (const [supportsDatabaseConflictRetry, request, error, expectedStatus] of [
			[true, task, new OutputTransferClaimConflictError(new Error("private cause")), 503],
			[undefined, task, new OutputTransferClaimConflictError(null), 502],
			["true", task, new OutputTransferClaimConflictError(null), 502],
			[
				true,
				{ ...task, outboxReceipt: undefined },
				new OutputTransferClaimConflictError(null),
				502,
			],
			[
				true,
				task,
				Object.assign(new Error("private URL"), {
					code: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
					phase: "BEFORE_TRANSFER_LEASE",
				}),
				502,
			],
			[
				true,
				{ ...task, taskId: "media-settle-generation" },
				new OutputTransferClaimConflictError(null),
				502,
			],
		] as const) {
			execute.mockRejectedValueOnce(error);
			const body = JSON.stringify({
				request,
				context: {
					attempt: 1,
					maxAttempts: taskDefinition(request.taskId).maxAttempts,
					runId: "run",
				},
				supportsDatabaseConflictRetry,
			});
			const response = await handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
			expect(response.status).toBe(expectedStatus);
			expect(await response.json()).toEqual(
				expectedStatus === 503
					? {
							status: "retry",
							reason: "OUTPUT_TRANSFER_CLAIM_CONFLICT",
							phase: "BEFORE_TRANSFER_LEASE",
						}
					: { status: "failed" },
			);
		}
		expect(execute).toHaveBeenCalledTimes(6);
	});
	it("limits settlement retries to confirmed transaction rollback and an opted-in receipt", async () => {
		const settlement = {
			taskId: "media-settle-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const execute = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		for (const [supportsDatabaseConflictRetry, request, error, expectedStatus] of [
			[true, settlement, new SettlementTransactionConflictError({ code: "55P03" }), 503],
			[undefined, settlement, new SettlementTransactionConflictError(null), 502],
			[false, settlement, new SettlementTransactionConflictError(null), 502],
			["true", settlement, new SettlementTransactionConflictError(null), 502],
			[
				true,
				{ ...settlement, outboxReceipt: undefined },
				new SettlementTransactionConflictError(null),
				502,
			],
			[
				true,
				{ ...settlement, taskId: "media-finalize-generation" },
				new SettlementTransactionConflictError(null),
				502,
			],
			[true, settlement, { code: "P2034" }, 502],
			[
				true,
				settlement,
				{ code: "SETTLEMENT_TRANSACTION_CONFLICT", phase: "TRANSACTION_ROLLED_BACK" },
				502,
			],
			[true, settlement, new Error("COMMIT response lost", { cause: { code: "ECONNRESET" } }), 502],
		] as const) {
			execute.mockRejectedValueOnce(error);
			const body = JSON.stringify({
				request,
				context: {
					attempt: 1,
					maxAttempts: taskDefinition(request.taskId).maxAttempts,
					runId: "run",
				},
				supportsDatabaseConflictRetry,
			});
			const response = await handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
			expect(response.status).toBe(expectedStatus);
			expect(await response.json()).toEqual(
				expectedStatus === 503
					? {
							status: "retry",
							reason: "SETTLEMENT_TRANSACTION_CONFLICT",
							phase: "TRANSACTION_ROLLED_BACK",
						}
					: { status: "failed" },
			);
		}
		expect(execute).toHaveBeenCalledTimes(9);
	});
	it.each([
		["media-poll-generation", { attemptId: "attempt" }, 5],
		["media-verify-upload", { assetId: "asset", queryOnly: true }, 1],
	] as const)(
		"keeps the immediate %s response compatible with old Workflow adapters",
		async (taskId, payload, legacyWaitSeconds) => {
			const result = {
				done: false,
				waitSeconds: 0,
				retryImmediately: true,
				outboxCommitted: false,
				continuation: { eventIds: [] },
				...(taskId === "media-verify-upload" ? { queryOnly: true } : {}),
			};
			const handler = createWorkerExecutionHandler({
				secret,
				execute: vi.fn().mockResolvedValue(result),
				poll: vi.fn().mockResolvedValue(result),
			});
			for (const supportsImmediatePolling of [undefined, false, "true", true]) {
				const body = JSON.stringify({
					request: { taskId, payload },
					context: { attempt: 1, maxAttempts: taskDefinition(taskId).maxAttempts, runId: "run" },
					supportsImmediatePolling,
				});
				const response = await handler(
					new Request("https://executor/internal/execute", {
						method: "POST",
						body,
						headers: await signRequest(secret, "POST", "/internal/execute", body),
					}),
				);
				expect(response.status).toBe(200);
				const { retryImmediately: _immediate, ...legacy } = result;
				expect(await response.json()).toEqual({
					status: "ok",
					poll:
						supportsImmediatePolling === true
							? result
							: { ...legacy, waitSeconds: legacyWaitSeconds },
				});
			}
		},
	);
	it("admits opted-in requests on release with no 429 or fixed retry gap", async () => {
		let release!: () => void;
		const execute = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValue(undefined);
		const onEvent = vi.fn();
		const handler = createWorkerExecutionHandler({
			secret,
			execute,
			poll: vi.fn(),
			maxActive: 1,
			onEvent,
		});
		const first = handler(await signed());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		const next = handler(await signed(undefined, undefined, 1_000));
		// Confirm the legacy path still observes the occupied slot.
		expect((await handler(await signed())).status).toBe(429);
		release();
		expect((await first).status).toBe(200);
		expect((await next).status).toBe(200);
		expect(execute).toHaveBeenCalledTimes(2);
		const completed = onEvent.mock.calls
			.map(([event]) => event)
			.filter((event) => event.phase === "completed");
		expect(completed).toHaveLength(2);
		for (const event of completed) {
			expect(event.elapsedMs).toBe(event.completedAt - event.startedAt);
			expect(event.capacityWaitMs).toBeGreaterThanOrEqual(0);
		}
		expect(completed[1].startedAt).toBeGreaterThanOrEqual(completed[0].completedAt);
	});
	it("identifies an expired capacity wait so the Workflow cannot add another five-second pause", async () => {
		let release!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn(), maxActive: 1 });
		const first = handler(await signed());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		try {
			const response = await handler(await signed(undefined, undefined, 1));
			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({ status: "busy", capacityWaited: true });
			expect(execute).toHaveBeenCalledOnce();
		} finally {
			release();
			await first;
		}
	});
	it("returns only the strict prepared task and requires explicit receipt-aware completion", async () => {
		const receipt = { eventId: "event", workerId: "workflow", leaseToken: "lease" };
		const preparedEvent = {
			taskId: "media-verify-upload",
			payload: { assetId: "asset" },
			outboxReceipt: receipt,
		};
		const execute = vi.fn().mockResolvedValue({ preparedEvent, privateUrl: "secret" });
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		const call = async (request: TaskRequest) => {
			const body = JSON.stringify({
				request,
				context: {
					attempt: 1,
					maxAttempts: taskDefinition(request.taskId).maxAttempts,
					runId: "run",
				},
			});
			return handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
		};
		expect(
			await (await call({ taskId: "media-prepare-event", payload: { eventId: "event" } })).json(),
		).toEqual({ status: "ok", preparedEvent });
		execute.mockResolvedValueOnce({
			preparedEvent: null,
			eventRetryAfterMs: 811,
			privateUrl: "secret",
		});
		expect(
			await (await call({ taskId: "media-prepare-event", payload: { eventId: "event" } })).json(),
		).toEqual({ status: "ok", preparedEvent: null, eventRetryAfterMs: 811 });
		execute.mockResolvedValueOnce({
			done: false,
			waitSeconds: 3,
			deliveryState: "pending",
			providerSecret: "secret",
			continuation: { eventIds: [] },
		});
		expect(await (await call(preparedEvent)).json()).toEqual({
			status: "ok",
			deliveryState: "pending",
			poll: { done: false, waitSeconds: 3, continuation: { eventIds: [] } },
		});
		expect(execute).toHaveBeenLastCalledWith(preparedEvent, expect.any(Object));
		for (const deliveryState of [undefined, ["completed"], "accepted"]) {
			execute.mockResolvedValueOnce({ done: true, waitSeconds: 0, deliveryState });
			expect((await call(preparedEvent)).status).toBe(502);
		}
		execute.mockResolvedValueOnce({
			preparedEvent: { ...preparedEvent, payload: { assetId: "asset", providerUrl: "secret" } },
		});
		expect(
			(await call({ taskId: "media-prepare-event", payload: { eventId: "event" } })).status,
		).toBe(502);
		const calls = execute.mock.calls.length;
		expect(
			(await call({ taskId: "media-deliver-outbox", payload: {}, outboxReceipt: receipt })).status,
		).toBe(400);
		expect(execute).toHaveBeenCalledTimes(calls);
	});
	it("sanitizes bounded callback continuation batches after releasing maintenance capacity", async () => {
		const phaseOwner = { workflowId: "workflow", phaseKey: "phase", epoch: 2 };
		const continuations = [
			{ eventIds: ["finalize", "finalize"], notBefore: 1_800_000_001_250, privateUrl: "secret" },
			{ eventIds: [], pollAttemptId: "original", phaseOwner, rawResponse: "secret" },
		];
		const execute = vi.fn().mockResolvedValue({ continuations, privateUrl: "secret" });
		const onEvent = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn(), onEvent });
		const request = { taskId: "media-deliver-outbox", payload: {} };
		const body = JSON.stringify({
			request,
			context: {
				attempt: 1,
				maxAttempts: taskDefinition(request.taskId).maxAttempts,
				runId: "run",
			},
		});
		const call = async () =>
			handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
		expect(await (await call()).json()).toEqual({
			status: "ok",
			continuations: [
				{ eventIds: ["finalize"], notBefore: 1_800_000_001_250 },
				{ eventIds: [], pollAttemptId: "original", phaseOwner },
			],
		});
		expect(onEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({ phase: "completed", active: 0 }),
		);
		for (const invalid of [
			null,
			{},
			Array(101).fill({ eventIds: [] }),
			[undefined],
			[{ eventIds: Array(101).fill("event") }],
			[{ eventIds: ["https://private/token"] }],
		]) {
			execute.mockResolvedValueOnce({ continuations: invalid });
			expect((await call()).status).toBe(502);
		}
	});

	it("forwards the continuation due time without private handler output", async () => {
		const notBefore = 1_800_000_001_250;
		const execute = vi.fn().mockResolvedValue({
			continuation: { eventIds: ["queued-event"], notBefore, privateUrl: "secret" },
		});
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		expect(await (await handler(await signed())).json()).toEqual({
			status: "ok",
			continuation: { eventIds: ["queued-event"], notBefore },
		});
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1800000001250", null])(
		"rejects an invalid continuation due time %s",
		async (notBefore) => {
			const execute = vi.fn().mockResolvedValue({
				continuation: { eventIds: ["queued-event"], notBefore },
			});
			const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
			expect((await handler(await signed())).status).toBe(502);
		},
	);
	it("sanitizes generic continuation and rejects malformed identities without leaking private output", async () => {
		const execute = vi.fn().mockResolvedValue({
			continuation: { eventIds: ["event", "event"], privateUrl: "secret" },
			privateUrl: "secret",
		});
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn() });
		expect(await (await handler(await signed())).json()).toEqual({
			status: "ok",
			continuation: { eventIds: ["event"] },
		});
		execute.mockResolvedValueOnce({
			continuation: { eventIds: [], pollAttemptId: "original", privateUrl: "secret" },
		});
		expect(await (await handler(await signed())).json()).toEqual({
			status: "ok",
			continuation: { eventIds: [], pollAttemptId: "original" },
		});
		for (const continuation of [
			{ eventIds: ["https://private/token"] },
			{ eventIds: Array(101).fill("event") },
			{ eventIds: [], pollAttemptId: {} },
		]) {
			execute.mockResolvedValueOnce({ continuation });
			expect((await handler(await signed())).status).toBe(502);
		}
	});
	it("returns only committed output review identities after releasing the heavy slot", async () => {
		const execute = vi.fn().mockResolvedValue({
			outcome: "WAITING_MODERATION",
			readyOutputs: 0,
			outputReviewEventIds: ["event-1"],
			providerTaskId: "secret-task",
			privateUrl: "secret-url",
		});
		const onEvent = vi.fn();
		const handler = createWorkerExecutionHandler({ secret, execute, poll: vi.fn(), onEvent });
		expect(await (await handler(await signed())).json()).toEqual({
			status: "ok",
			outputReview: { waiting: true, eventIds: ["event-1"] },
		});
		expect(onEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({ phase: "completed", active: 0, outcome: "ok" }),
		);
		execute.mockResolvedValueOnce({
			outcome: "WAITING_MODERATION",
			outputReviewEventIds: ["https://private/token"],
		});
		expect((await handler(await signed())).status).toBe(502);
	});
	it.each(["media-poll-generation", "media-verify-upload"])(
		"records the actual admitted start at the common boundary for %s",
		async (taskId) => {
			const timestamp = new Date("2026-09-30T00:00:05Z").getTime();
			const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
			const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
			try {
				const result = { done: true, waitSeconds: 0, outboxCommitted: false };
				const execute = vi.fn().mockResolvedValue(result);
				const poll = vi.fn().mockResolvedValue(result);
				const handler = createWorkerExecutionHandler({ secret, execute, poll });
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
				const response = await handler(
					new Request("https://executor/internal/execute", {
						method: "POST",
						body,
						headers: await signRequest(secret, "POST", "/internal/execute", body),
					}),
				);
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
				expect(taskId === "media-poll-generation" ? execute : poll).not.toHaveBeenCalled();
			} finally {
				info.mockRestore();
				clock.mockRestore();
			}
		},
	);
	it("preserves only the boolean committed Outbox signal across the private executor", async () => {
		const execute = vi.fn().mockResolvedValue({
			done: true,
			waitSeconds: 0,
			outboxCommitted: false,
			privateData: "hidden",
		});
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
			poll: { done: true, waitSeconds: 0, outboxCommitted: false },
		});
		execute.mockResolvedValueOnce({ done: true, waitSeconds: 0, outboxCommitted: "false" });
		expect(await (await handler(await request())).json()).toEqual({ status: "failed" });
	});
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
