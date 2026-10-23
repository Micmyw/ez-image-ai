import { signRequest } from "@repo/jobs/orchestration/auth";
import {
	OutputTransferClaimConflictError,
	SettlementTransactionConflictError,
	imagePhaseEventType,
} from "@repo/jobs/orchestration/contracts";
import { env, SELF, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { createWorkerExecutionHandler } from "./execution";
import { JobsWorkflow } from "./index";
import { handlePhaseWake } from "./wake";

// Steps that call the paid Node runtime are mocked; orchestration, checkpoint
// persistence, Workflow binding and durable waits run in real local workerd.
const jobs = (env as Cloudflare.Env).JOBS;
describe("local Workflows runtime", () => {
	it("diagnoses a missing real Workflow binding instance without creating a replacement", async () => {
		const phaseOwner = {
			workflowId: `missing-${crypto.randomUUID()}`,
			phaseKey: crypto.randomUUID(),
			epoch: 1,
		};
		const secret = "test-only-32-character-shared-secret";
		const body = JSON.stringify({
			taskId: "media-verify-upload",
			payload: { assetId: "missing-instance-asset" },
			idempotencyKey: "missing-instance-wake",
			phaseOwner,
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const request = new Request("https://jobs/internal/phase-wake", {
				method: "POST",
				body,
				headers: await signRequest(secret, "POST", "/internal/phase-wake", body),
			});
			const response = await handlePhaseWake(request, secret, jobs);
			expect(response.status).toBe(503);
			expect(warning).toHaveBeenCalledOnce();
			expect(JSON.parse(warning.mock.calls[0]![0] as string)).toMatchObject({
				stage: "get",
				reason: "INSTANCE_LOOKUP_FAILED",
				errorCode: "INSTANCE_NOT_FOUND",
				workflowId: phaseOwner.workflowId,
			});
			await expect(jobs.get(phaseOwner.workflowId)).rejects.toThrow("instance.not_found");
		} finally {
			warning.mockRestore();
		}
	});
	it.each([
		{ signal: "delivered", taskId: "media-verify-upload" },
		{ signal: "lost", taskId: "media-verify-upload" },
		{ signal: "delivered", taskId: "media-poll-generation" },
		{ signal: "lost", taskId: "media-poll-generation" },
	] as const)(
		"retains the original $taskId phase when signed signals are $signal",
		async ({ signal, taskId }) => {
			const id = `phase-ingress-${crypto.randomUUID()}`;
			const phaseOwner = { workflowId: id, phaseKey: crypto.randomUUID(), epoch: 7 };
			const payload =
				taskId === "media-verify-upload"
					? { assetId: "asset", queryOnly: true }
					: { attemptId: "attempt" };
			const inspection = await introspectWorkflowInstance(jobs, id);
			try {
				await inspection.modify(async (m) => {
					await m.mockStepResult(
						{ name: "poll-0-attempt-1-capacity-0" },
						{
							status: "ok",
							poll: {
								done: false,
								waitSeconds: signal === "lost" ? 1 : 60,
								queryOnly: true,
								phaseOwner,
								continuation: { eventIds: [] },
							},
						},
					);
					await m.mockStepResult(
						{ name: "poll-1-attempt-1-capacity-0" },
						{
							status: "ok",
							poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
						},
					);
				});
				const notBefore = Date.now() + 3_000;
				const instance = await jobs.create({
					id,
					params: {
						kind: "continuation",
						executionVersion: 2,
						...(signal === "delivered" ? { notBefore } : {}),
						request: { taskId, payload },
					},
				});
				if (signal === "delivered") {
					// Real signed ingress + binding. Old epochs and duplicate hints do not own another query.
					for (const epoch of [6, 7, 7]) {
						const owner = { ...phaseOwner, epoch };
						const body = JSON.stringify({
							taskId,
							payload,
							idempotencyKey: `phase-hint-${epoch}`,
							phaseOwner: owner,
						});
						const response = await SELF.fetch("https://jobs/internal/phase-wake", {
							method: "POST",
							body,
							headers: await signRequest(
								"test-only-32-character-shared-secret",
								"POST",
								"/internal/phase-wake",
								body,
							),
						});
						expect(response.status).toBe(202);
						expect(await response.json()).toMatchObject({ accepted: true, phaseOwner: owner });
					}
					expect(Date.now()).toBeLessThan(notBefore);
				}
				await inspection.waitForStatus("complete");
				const outputs = (
					(await instance.status()) as unknown as { __LOCAL_DEV_STEP_OUTPUTS: unknown[] }
				).__LOCAL_DEV_STEP_OUTPUTS;
				if (signal === "delivered") {
					expect(outputs).toContainEqual({ phaseKey: phaseOwner.phaseKey, epoch: 7 });
					expect(outputs).not.toContainEqual({ phaseKey: phaseOwner.phaseKey, epoch: 6 });
				}
				expect(
					outputs.filter(
						(value) => (value as { poll?: { done?: boolean } } | null)?.poll?.done === true,
					),
				).toHaveLength(1);
				expect(await inspection.getOutput()).toEqual({ completed: true });
			} finally {
				await inspection.dispose();
			}
		},
	);
	it("buffers a real version 2 phase signal before its durable wait begins", async () => {
		const id = `phase-early-${crypto.randomUUID()}`;
		const phaseOwner = { workflowId: id, phaseKey: crypto.randomUUID(), epoch: 7 };
		const type = imagePhaseEventType(phaseOwner);
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				await m.mockStepResult(
					{ name: "poll-0-attempt-1-capacity-0" },
					{
						status: "ok",
						poll: {
							done: false,
							waitSeconds: 60,
							queryOnly: true,
							phaseOwner,
							continuation: { eventIds: [] },
						},
					},
				);
				await m.mockStepResult(
					{ name: "poll-1-attempt-1-capacity-0" },
					{
						status: "ok",
						poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
					},
				);
			});
			// The real durable sleep guarantees sendEvent occurs before waitForEvent.
			const notBefore = Date.now() + 3_000;
			const instance = await jobs.create({
				id,
				params: {
					kind: "continuation",
					executionVersion: 2,
					notBefore,
					request: {
						taskId: "media-verify-upload",
						payload: { assetId: "asset", queryOnly: true },
					},
				},
			});
			await instance.sendEvent({ type, payload: { phaseOwner, marker: "early" } });
			expect(Date.now()).toBeLessThan(notBefore);
			await inspection.waitForStepResult({ name: "poll-1-attempt-1-capacity-0" });
			await inspection.waitForStatus("complete");
			// Local status retains the payload consumed by the actual WAIT_COMPLETE event.
			expect(
				((await instance.status()) as unknown as { __LOCAL_DEV_STEP_OUTPUTS: unknown[] })
					.__LOCAL_DEV_STEP_OUTPUTS,
			).toContainEqual({ phaseOwner, marker: "early" });
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
	it("keeps two real phase event types independent inside one fused Workflow", async () => {
		const id = `phase-parallel-${crypto.randomUUID()}`;
		const owners = [1, 2].map((epoch) => ({
			workflowId: id,
			phaseKey: crypto.randomUUID(),
			epoch,
		}));
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				for (const [index, phaseOwner] of owners.entries()) {
					const prefix = `media-deliver-events-event-${index}-0`;
					const eventId = `review-${index}`;
					await m.mockStepResult(
						{ name: `${prefix}-prepare-attempt-1-capacity-0` },
						{
							status: "ok",
							preparedEvent: null,
							executedEvent: {
								taskId: "media-verify-upload",
								payload: { assetId: `asset-${index}` },
								outboxReceipt: { eventId, workerId: id, leaseToken: `lease-${index}` },
							},
							deliveryState: "pending",
							poll: {
								done: false,
								waitSeconds: 60,
								queryOnly: true,
								phaseOwner,
								continuation: { eventIds: [] },
							},
						},
					);
					await m.mockStepResult(
						{ name: `${prefix}-verify-1-attempt-1-capacity-0` },
						{
							status: "ok",
							deliveryState: "completed",
							poll: { done: true, waitSeconds: 0, phaseOwner, continuation: { eventIds: [] } },
						},
					);
				}
			});
			const instance = await jobs.create({
				id,
				params: {
					kind: "task",
					executionVersion: 2,
					request: {
						taskId: "media-deliver-events",
						payload: { eventIds: ["review-0", "review-1"] },
					},
				},
			});
			await instance.sendEvent({
				type: imagePhaseEventType(owners[1]!),
				payload: { marker: "second" },
			});
			await inspection.waitForStepResult({
				name: "media-deliver-events-event-1-0-verify-1-attempt-1-capacity-0",
			});
			const waiting = (await instance.status()) as unknown as {
				status: string;
				__LOCAL_DEV_STEP_OUTPUTS: unknown[];
			};
			expect(waiting.status).not.toBe("complete");
			expect(waiting.__LOCAL_DEV_STEP_OUTPUTS).toContainEqual({ marker: "second" });
			expect(waiting.__LOCAL_DEV_STEP_OUTPUTS).not.toContainEqual(
				expect.objectContaining({
					poll: expect.objectContaining({ done: true, phaseOwner: owners[0] }),
				}),
			);
			await instance.sendEvent({
				type: imagePhaseEventType(owners[0]!),
				payload: { marker: "first" },
			});
			await inspection.waitForStatus("complete");
			expect(
				((await instance.status()) as unknown as { __LOCAL_DEV_STEP_OUTPUTS: unknown[] })
					.__LOCAL_DEV_STEP_OUTPUTS,
			).toContainEqual({ marker: "first" });
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
	it.each([
		[
			"media-finalize-generation",
			new OutputTransferClaimConflictError({ code: "40001" }),
			"OUTPUT_TRANSFER_CLAIM_CONFLICT",
			"BEFORE_TRANSFER_LEASE",
			5,
		],
		[
			"media-settle-generation",
			new SettlementTransactionConflictError({ code: "55P03" }),
			"SETTLEMENT_TRANSACTION_CONFLICT",
			"TRANSACTION_ROLLED_BACK",
			8,
		],
	] as const)(
		"serializes a nominal receipt-bound %s rollback retry in real workerd",
		async (taskId, error, reason, phase, maxAttempts) => {
			const secret = "test-only-32-character-shared-secret";
			const handler = createWorkerExecutionHandler({
				secret,
				execute: async () => {
					throw error;
				},
				poll: async () => ({ done: true, waitSeconds: 0 }),
			});
			const body = JSON.stringify({
				request: {
					taskId,
					payload: { jobId: "job", version: 0 },
					outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "lease" },
				},
				context: { attempt: 1, maxAttempts, runId: "run" },
				supportsDatabaseConflictRetry: true,
			});
			const response = await handler(
				new Request("https://executor/internal/execute", {
					method: "POST",
					body,
					headers: await signRequest(secret, "POST", "/internal/execute", body),
				}),
			);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				status: "retry",
				reason,
				phase,
			});
		},
	);
	it.each([
		["media-finalize-generation", "OUTPUT_TRANSFER_CLAIM_CONFLICT", "BEFORE_TRANSFER_LEASE"],
		["media-settle-generation", "SETTLEMENT_TRANSACTION_CONFLICT", "TRANSACTION_ROLLED_BACK"],
	] as const)(
		"persists %s rollback and completes the next bounded continuation attempt",
		async (taskId, reason, phase) => {
			const id = `claim-retry-${crypto.randomUUID()}`;
			const inspection = await introspectWorkflowInstance(jobs, id);
			try {
				await inspection.modify(async (m) => {
					await m.mockStepResult(
						{ name: `${taskId}-attempt-1-capacity-0` },
						{
							status: "retry",
							reason,
							phase,
						},
					);
					await m.mockStepResult(
						{ name: `${taskId}-attempt-2-capacity-0` },
						{ status: "ok", deliveryState: "completed", continuation: { eventIds: [] } },
					);
				});
				await jobs.create({
					id,
					params: {
						kind: "continuation",
						request: {
							taskId,
							payload: { jobId: "job", version: 0 },
							outboxReceipt: { eventId: "event", workerId: "worker", leaseToken: "lease" },
						},
					},
				});
				await inspection.waitForStatus("complete");
				expect(
					await inspection.waitForStepResult({
						name: `${taskId}-attempt-2-capacity-0`,
					}),
				).toMatchObject({ status: "ok", deliveryState: "completed" });
			} finally {
				await inspection.dispose();
			}
		},
	);
	it("durably retains an unclaimed future event and executes only its later receipt", async () => {
		const id = `future-event-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		const prefix = "media-deliver-events-event-0-0";
		const complete = { status: "ok", deliveryState: "completed", continuation: { eventIds: [] } };
		try {
			await inspection.modify(async (m) => {
				await m.mockStepResult(
					{ name: `${prefix}-prepare-attempt-1-capacity-0` },
					{
						status: "ok",
						preparedEvent: null,
						eventRetryAt: Date.now() + 1_000,
					},
				);
				await m.mockStepResult(
					{ name: `${prefix}-prepare-due-1-attempt-1-capacity-0` },
					{
						status: "ok",
						preparedEvent: {
							taskId: "media-settle-generation",
							payload: { jobId: "job", version: 0 },
							outboxReceipt: { eventId: "settle", workerId: id, leaseToken: "due-lease" },
						},
					},
				);
				await m.mockStepResult({ name: `${prefix}-execute-attempt-1-capacity-0` }, complete);
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request: { taskId: "media-deliver-events", payload: { eventIds: ["settle"] } },
				},
			});
			expect(
				await inspection.waitForStepResult({ name: `${prefix}-execute-attempt-1-capacity-0` }),
			).toEqual(complete);
			await inspection.waitForStatus("complete");
		} finally {
			await inspection.dispose();
		}
	});
	it.each([undefined, 2] as const)(
		"reprepares an unclaimed event whose durable due time already elapsed with version %s",
		async (executionVersion) => {
			const id = `elapsed-event-${crypto.randomUUID()}`;
			const inspection = await introspectWorkflowInstance(jobs, id);
			const prefix = "media-deliver-events-event-0-0";
			const complete = {
				status: "ok",
				deliveryState: "completed",
				continuation: { eventIds: [] },
			};
			try {
				await inspection.modify(async (m) => {
					await m.mockStepResult(
						{ name: `${prefix}-prepare-attempt-1-capacity-0` },
						{ status: "ok", preparedEvent: null, eventRetryAt: Date.now() - 1 },
					);
					await m.mockStepResult(
						{ name: `${prefix}-prepare-due-1-attempt-1-capacity-0` },
						{
							status: "ok",
							preparedEvent: {
								taskId: "media-settle-generation",
								payload: { jobId: "job", version: 0 },
								outboxReceipt: { eventId: "settle", workerId: id, leaseToken: "due-lease" },
							},
						},
					);
					await m.mockStepResult({ name: `${prefix}-execute-attempt-1-capacity-0` }, complete);
				});
				await jobs.create({
					id,
					params: {
						kind: "task",
						...(executionVersion ? { executionVersion } : {}),
						request: { taskId: "media-deliver-events", payload: { eventIds: ["settle"] } },
					},
				});
				expect(
					await inspection.waitForStepResult({ name: `${prefix}-execute-attempt-1-capacity-0` }),
				).toEqual(complete);
				await inspection.waitForStatus("complete");
			} finally {
				await inspection.dispose();
			}
		},
	);
	it("starts a persisted wake continuation whose not-before time already elapsed", async () => {
		const id = `elapsed-wake-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		const complete = {
			status: "ok",
			deliveryState: "completed",
			continuation: { eventIds: [] },
		};
		try {
			await inspection.modify(async (m) => {
				await m.mockStepResult({ name: "media-settle-generation-attempt-1-capacity-0" }, complete);
			});
			await jobs.create({
				id,
				params: {
					kind: "continuation",
					executionVersion: 2,
					notBefore: Date.now() - 1,
					request: {
						taskId: "media-settle-generation",
						payload: { jobId: "job", version: 0 },
						outboxReceipt: { eventId: "settle", workerId: id, leaseToken: "existing-lease" },
					},
				},
			});
			expect(
				await inspection.waitForStepResult({
					name: "media-settle-generation-attempt-1-capacity-0",
				}),
			).toEqual(complete);
			await inspection.waitForStatus("complete");
		} finally {
			await inspection.dispose();
		}
	});
	it.each([
		{ taskId: "media-poll-generation", payload: { attemptId: "original-attempt" } },
		{ taskId: "media-verify-upload", payload: { assetId: "original-asset" } },
	])("checkpoints an immediately due $taskId without a durable polling sleep", async (request) => {
		const id = `immediate-query-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				await m.mockStepResult(
					{ name: "poll-0-attempt-1-capacity-0" },
					{
						status: "ok",
						poll: {
							done: false,
							waitSeconds: 0,
							retryImmediately: true,
							...(request.taskId === "media-verify-upload" ? { queryOnly: true } : {}),
							continuation: { eventIds: [] },
						},
					},
				);
				await m.mockStepResult(
					{ name: "poll-1-attempt-1-capacity-0" },
					{
						status: "ok",
						poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
					},
				);
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request,
				},
			});
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
	it("runs independent output reviews through parallel durable steps", async () => {
		const id = `parallel-reviews-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		try {
			await inspection.modify(async (m) => {
				await m.disableSleeps();
				for (const index of [0, 1]) {
					const prefix = `media-deliver-events-event-${index}-0`;
					const eventId = `review-${index}`;
					await m.mockStepResult(
						{ name: `${prefix}-prepare-attempt-1-capacity-0` },
						{
							status: "ok",
							preparedEvent: {
								taskId: "media-verify-upload",
								payload: { assetId: `asset-${index}` },
								outboxReceipt: {
									eventId,
									workerId: `workflow:${id}`,
									leaseToken: `lease-${index}`,
								},
							},
							continuation: { eventIds: [] },
						},
					);
					await m.mockStepResult(
						{ name: `${prefix}-verify-0-attempt-1-capacity-0` },
						{
							status: "ok",
							deliveryState: "pending",
							poll: { done: false, waitSeconds: 3, continuation: { eventIds: [] } },
						},
					);
					await m.mockStepResult(
						{ name: `${prefix}-verify-1-attempt-1-capacity-0` },
						{
							status: "ok",
							deliveryState: "completed",
							poll: { done: true, waitSeconds: 0, continuation: { eventIds: [] } },
						},
					);
				}
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request: {
						taskId: "media-deliver-events",
						payload: { eventIds: ["review-0", "review-1"] },
					},
				},
			});
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
	it("continues prepared transfer, pending review and settlement inside the same persisted Workflow", async () => {
		const id = `targeted-${crypto.randomUUID()}`;
		const inspection = await introspectWorkflowInstance(jobs, id);
		const receipt = (eventId: string) => ({
			eventId,
			workerId: `workflow:${id}`,
			leaseToken: "lease",
		});
		const root = "media-deliver-events-event-0-0";
		const review = `${root}-execute-continue-event-0-0`;
		const settlement = `${review}-verify-1-continue-event-0-0`;
		try {
			await inspection.modify(async (m) => {
				await m.disableSleeps();
				await m.mockStepResult(
					{ name: `${root}-prepare-attempt-1-capacity-0` },
					{
						status: "ok",
						preparedEvent: {
							taskId: "media-finalize-generation",
							payload: { jobId: "job", version: 0 },
							outboxReceipt: receipt("finalize"),
						},
						continuation: { eventIds: [] },
					},
				);
				await m.mockStepResult(
					{ name: `${root}-execute-attempt-1-capacity-0` },
					{ status: "ok", deliveryState: "completed", continuation: { eventIds: ["review"] } },
				);
				await m.mockStepResult(
					{ name: `${review}-prepare-attempt-1-capacity-0` },
					{
						status: "ok",
						preparedEvent: {
							taskId: "media-verify-upload",
							payload: { assetId: "asset" },
							outboxReceipt: receipt("review"),
						},
						continuation: { eventIds: [] },
					},
				);
				await m.mockStepResult(
					{ name: `${review}-verify-0-attempt-1-capacity-0` },
					{
						status: "ok",
						deliveryState: "pending",
						poll: { done: false, waitSeconds: 3, continuation: { eventIds: [] } },
					},
				);
				await m.mockStepResult(
					{ name: `${review}-verify-1-attempt-1-capacity-0` },
					{
						status: "ok",
						deliveryState: "completed",
						poll: { done: true, waitSeconds: 0, continuation: { eventIds: ["settle"] } },
					},
				);
				await m.mockStepResult(
					{ name: `${settlement}-prepare-attempt-1-capacity-0` },
					{
						status: "ok",
						preparedEvent: {
							taskId: "media-settle-generation",
							payload: { jobId: "job", version: 0 },
							outboxReceipt: receipt("settle"),
						},
						continuation: { eventIds: [] },
					},
				);
				await m.mockStepResult(
					{ name: `${settlement}-execute-attempt-1-capacity-0` },
					{ status: "ok", deliveryState: "completed", continuation: { eventIds: [] } },
				);
			});
			await jobs.create({
				id,
				params: {
					kind: "task",
					request: { taskId: "media-deliver-events", payload: { eventIds: ["finalize"] } },
				},
			});
			await inspection.waitForStatus("complete");
			expect(await inspection.getOutput()).toEqual({ completed: true });
		} finally {
			await inspection.dispose();
		}
	});
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
				await m.mockStepResult(
					{ name: "media-dispatch-image-kie-nano-banana-2-next-stage-attempt-1-capacity-0" },
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
	it.each(["media-poll-generation", "media-verify-upload"])(
		"executes %s polling and next-stage delivery with persisted decisions",
		async (taskId) => {
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
					await m.mockStepResult(
						{ name: "poll-1-next-stage-attempt-1-capacity-0" },
						{ status: "ok" },
					);
				});
				await jobs.create({
					id,
					params: {
						kind: "task",
						request: {
							taskId,
							payload: taskId === "media-poll-generation" ? { attemptId: "a" } : { assetId: "a" },
						},
					},
				});
				await inspection.waitForStatus("complete");
				expect(await inspection.getOutput()).toEqual({ completed: true });
			} finally {
				await inspection.dispose();
			}
		},
	);
});
// Retain the explicit export for the integration pool's entrypoint discovery.
export { JobsWorkflow };
