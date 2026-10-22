import type { Server } from "node:http";

import { signRequest } from "@repo/jobs/orchestration/auth";
import {
	OutputTransferClaimConflictError,
	SettlementTransactionConflictError,
	type TaskRequest,
	type TaskExecutionContext,
} from "@repo/jobs/orchestration/contracts";
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
async function request(
	url: string,
	taskId = "media-finalize-generation",
	waitForCapacityMs?: number,
) {
	const body = JSON.stringify({
		request: { taskId, payload: { jobId: "job", version: 0 } },
		context: { attempt: 1, maxAttempts: 5, runId: "run" },
		...(waitForCapacityMs === undefined ? {} : { waitForCapacityMs }),
	});
	return fetch(`${url}/internal/execute`, {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

async function signedEnvelope(url: string, value: unknown) {
	const body = JSON.stringify(value);
	return fetch(`${url}/internal/execute`, {
		method: "POST",
		body,
		headers: await signRequest(secret, "POST", "/internal/execute", body),
	});
}

const phaseOwner = { workflowId: "workflow_1", phaseKey: "phase-input_1", epoch: 3 };
const workflowContext = {
	attempt: 1,
	maxAttempts: 5,
	runId: phaseOwner.workflowId,
	workflowId: phaseOwner.workflowId,
	phaseOwner,
};

describe("private Node runtime", () => {
	it("passes signed Workflow identity and the exact phase fence through execution", async () => {
		const { url, execute } = await start();
		const task = { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } };
		const response = await signedEnvelope(url, { request: task, context: workflowContext });
		expect(response.status).toBe(200);
		expect(execute).toHaveBeenCalledExactlyOnceWith(task, workflowContext);
	});
	it("allows a Workflow to claim its first phase without a phase owner", async () => {
		const { url, execute } = await start();
		const { phaseOwner: _owner, ...context } = workflowContext;
		const response = await signedEnvelope(url, {
			request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			context,
		});
		expect(response.status).toBe(200);
		expect(execute.mock.calls[0]?.[1]).toEqual(context);
		expect(execute.mock.calls[0]?.[1]).not.toHaveProperty("phaseOwner");
	});
	it("keeps a legacy run ID diagnostic and never invents a Workflow owner", async () => {
		const { url, execute } = await start();
		const context = { attempt: 1, maxAttempts: 5, runId: "workflow_1" };
		expect(
			(
				await signedEnvelope(url, {
					request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
					context,
				})
			).status,
		).toBe(200);
		expect(execute.mock.calls[0]?.[1]).toEqual(context);
		expect(execute.mock.calls[0]?.[1]).not.toHaveProperty("workflowId");
	});
	it("passes the same signed Workflow context to provider polling", async () => {
		const poll = vi.fn(async (_input: { attemptId: string }, _context: TaskExecutionContext) => ({
			done: false,
			waitSeconds: 1,
			phaseOwner,
		}));
		const execute = vi.fn();
		const { url } = await start(execute, 4, poll);
		const context = {
			...workflowContext,
			maxAttempts: taskDefinition("media-poll-generation").maxAttempts,
		};
		const response = await signedEnvelope(url, {
			request: { taskId: "media-poll-generation", payload: { attemptId: "attempt" } },
			context,
		});
		expect(response.status).toBe(200);
		expect(poll).toHaveBeenCalledExactlyOnceWith({ attemptId: "attempt" }, context);
		expect(execute).not.toHaveBeenCalled();
		expect(await response.json()).toEqual({
			status: "ok",
			poll: { done: false, waitSeconds: 1, phaseOwner },
		});
	});
	it.each([
		["owner without explicit Workflow", { ...workflowContext, workflowId: undefined }],
		["Workflow disagrees with run", { ...workflowContext, workflowId: "different" }],
		[
			"owner belongs to another Workflow",
			{ ...workflowContext, phaseOwner: { ...phaseOwner, workflowId: "different" } },
		],
		[
			"invalid Workflow characters",
			{ ...workflowContext, runId: "workflow/1", workflowId: "workflow/1" },
		],
		[
			"oversized Workflow ID",
			{ ...workflowContext, runId: "w".repeat(129), workflowId: "w".repeat(129) },
		],
		["null Workflow ID", { ...workflowContext, workflowId: null }],
		["null owner", { ...workflowContext, phaseOwner: null }],
		["uninitialized epoch", { ...workflowContext, phaseOwner: { ...phaseOwner, epoch: 0 } }],
		["fractional epoch", { ...workflowContext, phaseOwner: { ...phaseOwner, epoch: 1.5 } }],
		[
			"unsafe epoch",
			{ ...workflowContext, phaseOwner: { ...phaseOwner, epoch: Number.MAX_SAFE_INTEGER + 1 } },
		],
		[
			"invalid phase identity",
			{ ...workflowContext, phaseOwner: { ...phaseOwner, phaseKey: "https://private" } },
		],
		[
			"unknown owner field",
			{ ...workflowContext, phaseOwner: { ...phaseOwner, leaseToken: "forged" } },
		],
		["unknown context field", { ...workflowContext, ownerOverride: true }],
		["blank legacy run", { attempt: 1, maxAttempts: 5, runId: " " }],
		["array context", []],
		["null context", null],
	])("rejects %s before capacity admission", async (_label, context) => {
		const { url, execute } = await start();
		const response = await signedEnvelope(url, {
			request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			context,
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ status: "invalid_task" });
		expect(execute).not.toHaveBeenCalled();
		expect(await (await fetch(`${url}/health`)).json()).toEqual({ active: 0 });
	});
	it("rejects unknown signed envelope fields instead of silently treating them as authority", async () => {
		const { url, execute } = await start();
		const response = await signedEnvelope(url, {
			request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			context: workflowContext,
			phaseOwner,
		});
		expect(response.status).toBe(400);
		expect(execute).not.toHaveBeenCalled();
	});
	it("authenticates Workflow identity before parsing or executing a tampered envelope", async () => {
		const { url, execute } = await start();
		const original = {
			request: { taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
			context: workflowContext,
		};
		const body = JSON.stringify(original);
		const response = await fetch(`${url}/internal/execute`, {
			method: "POST",
			body: JSON.stringify({
				...original,
				context: { ...workflowContext, phaseOwner: { ...phaseOwner, epoch: 4 } },
			}),
			headers: await signRequest(secret, "POST", "/internal/execute", body),
		});
		expect(response.status).toBe(401);
		expect(execute).not.toHaveBeenCalled();
	});
	it("keeps pre-claim recovery nominal, receipt-bound and compatible with legacy callers", async () => {
		const task = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0 },
			outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "token" },
		};
		const { url, execute } = await start();
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
			const response = await fetch(`${url}/internal/execute`, {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			});
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
		const { url, execute } = await start();
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
			const response = await fetch(`${url}/internal/execute`, {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			});
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
		"negotiates immediate %s results while preserving legacy waits",
		async (taskId, payload, legacyWaitSeconds) => {
			const result = {
				done: false,
				waitSeconds: 0,
				retryImmediately: true,
				outboxCommitted: false,
				continuation: { eventIds: [] },
				...(taskId === "media-verify-upload" ? { queryOnly: true } : {}),
			};
			const { url } = await start(
				vi.fn().mockResolvedValue(result),
				4,
				vi.fn().mockResolvedValue(result),
			);
			for (const supportsImmediatePolling of [undefined, false, "true", true]) {
				const body = JSON.stringify({
					request: { taskId, payload },
					context: { attempt: 1, maxAttempts: taskDefinition(taskId).maxAttempts, runId: "run" },
					supportsImmediatePolling,
				});
				const response = await fetch(`${url}/internal/execute`, {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				});
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
	it("wakes opted-in requests from release without a retry and reports real occupancy intervals", async () => {
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
		const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
		try {
			const { url } = await start(execute, 1);
			const first = request(url);
			await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
			const next = request(url, undefined, 1_000);
			expect((await request(url)).status).toBe(429);
			release();
			expect((await first).status).toBe(200);
			expect((await next).status).toBe(200);
			expect(execute).toHaveBeenCalledTimes(2);
			const spans = log.mock.calls
				.filter(([name]) => name === "job.executor")
				.map(([, event]) => event as { startedAt: number; completedAt: number; elapsedMs: number });
			expect(spans).toHaveLength(2);
			expect(spans[0]!.elapsedMs).toBe(spans[0]!.completedAt - spans[0]!.startedAt);
			expect(spans[1]!.startedAt).toBeGreaterThanOrEqual(spans[0]!.completedAt);
		} finally {
			release?.();
			log.mockRestore();
		}
	});
	it("preserves the actual wait marker on bounded capacity expiry", async () => {
		let release!: () => void;
		const execute = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const { url } = await start(execute, 1);
		const first = request(url);
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
		try {
			const response = await request(url, undefined, 1);
			expect(response.status).toBe(429);
			expect(await response.json()).toEqual({ status: "busy", capacityWaited: true });
			expect((await (await fetch(`${url}/health`)).json()).active).toBe(1);
		} finally {
			release();
			await first;
		}
	});
	it("preserves the same strict preparation and receipt protocol in hybrid execution", async () => {
		const receipt = { eventId: "event", workerId: "workflow", leaseToken: "lease" };
		const preparedEvent = {
			taskId: "media-verify-upload",
			payload: { assetId: "asset" },
			outboxReceipt: receipt,
		};
		const execute = vi.fn().mockResolvedValue({ preparedEvent, privateUrl: "secret" });
		const { url } = await start(execute);
		const call = async (request: TaskRequest) => {
			const body = JSON.stringify({
				request,
				context: {
					attempt: 1,
					maxAttempts: taskDefinition(request.taskId).maxAttempts,
					runId: "run",
				},
			});
			return fetch(`${url}/internal/execute`, {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/execute", body),
			});
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
		execute.mockResolvedValueOnce({ done: true, waitSeconds: 0 });
		expect((await call(preparedEvent)).status).toBe(502);
		execute.mockResolvedValueOnce({ preparedEvent: { ...preparedEvent, privateUrl: "secret" } });
		expect(
			(await call({ taskId: "media-prepare-event", payload: { eventId: "event" } })).status,
		).toBe(502);
		const calls = execute.mock.calls.length;
		expect(
			(await call({ taskId: "media-deliver-outbox", payload: {}, outboxReceipt: receipt })).status,
		).toBe(400);
		expect(execute).toHaveBeenCalledTimes(calls);
	});
	it("preserves and sanitizes bounded callback continuation batches in the hybrid receiver", async () => {
		const continuations = [
			{ eventIds: ["finalize", "finalize"], notBefore: 1_800_000_001_250, privateUrl: "secret" },
			{ eventIds: [], pollAttemptId: "attempt", phaseOwner, rawResponse: "secret" },
		];
		const execute = vi.fn().mockResolvedValue({ continuations, privateUrl: "secret" });
		const { url } = await start(execute);
		const task = { taskId: "media-deliver-outbox", payload: {} };
		const call = () =>
			signedEnvelope(url, {
				request: task,
				context: {
					attempt: 1,
					maxAttempts: taskDefinition(task.taskId).maxAttempts,
					runId: "run",
				},
			});
		expect(await (await call()).json()).toEqual({
			status: "ok",
			continuations: [
				{ eventIds: ["finalize"], notBefore: 1_800_000_001_250 },
				{ eventIds: [], pollAttemptId: "attempt", phaseOwner },
			],
		});
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
				expect(info.mock.calls.filter(([name]) => name === "media.task.started")).toHaveLength(1);
				expect(info).toHaveBeenCalledWith(
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
