import { describe, expect, it, vi } from "vitest";

import {
	OutputTransferClaimConflictError,
	GenerationTransferRequiresHeavyError,
	SettlementTransactionConflictError,
} from "../contracts";
import type { TaskRequest } from "../orchestration/contracts";
import { parseEventDeliveryResult, parseTaskRequest } from "../orchestration/registry";
import {
	executeFusedTargetedEvent,
	executeTargetedEvent,
	prepareTargetedEvent,
} from "./targeted-event-delivery";

const receipt = { eventId: "event", workerId: "workflow:one", leaseToken: "lease" };
const executionMarker = "EXECUTION_IN_PROGRESS:00000000-0000-4000-8000-000000000000";
const executionReceipt = { ...receipt, executionMarker };
const dispatchTask = "media-dispatch-image-kie-nano-banana-2";
const request: TaskRequest = {
	taskId: dispatchTask,
	payload: { jobId: "job", version: 0 },
	outboxReceipt: receipt,
};
const event = {
	id: "event",
	eventType: "GENERATION_DISPATCH",
	aggregateType: "GENERATION_JOB",
	aggregateId: "job",
	payload: { version: 0 },
	attempts: 1,
	dedupeKey: "dispatch:job",
	leaseToken: "lease",
	leasedUntil: new Date(Date.now() + 90_000),
	availableAt: new Date(0),
	lastError: executionMarker,
};

function dependencies() {
	return {
		begin: vi.fn(async () => ({ state: "active" as const, event: event as never })),
		complete: vi.fn(async () => true),
		fail: vi.fn(async () => true),
		defer: vi.fn(async () => true),
		execute: vi.fn(async () => ({
			continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
		})),
		recover: vi.fn(async () => ({
			continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
		})),
	};
}

describe("fused event delivery", () => {
	function fused() {
		const execution = dependencies();
		return {
			execution,
			prepare: vi.fn(async () => ({ preparedEvent: request })),
			execute: vi.fn((child: TaskRequest) => executeTargetedEvent(child, execution)),
			recover: vi.fn(async () => ({
				eventRecoveryState: "completed" as const,
				continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
			})),
		};
	}
	it("claims and executes control work within one call while preserving completion receipts", async () => {
		const deps = fused();
		const result = await executeFusedTargetedEvent({ eventId: "event" }, deps);
		expect(result).toMatchObject({
			preparedEvent: null,
			executedEvent: request,
			deliveryState: "completed",
			continuation: { pollAttemptId: "accepted-attempt" },
		});
		expect(deps.execution.begin).toHaveBeenCalledOnce();
		expect(deps.execution.execute).toHaveBeenCalledOnce();
		expect(deps.execution.complete).toHaveBeenCalledOnce();
		expect(deps.prepare.mock.invocationCallOrder[0]).toBeLessThan(
			deps.execution.begin.mock.invocationCallOrder[0]!,
		);
	});
	it("does not repeat a paid handler when the same completed wrapper is delivered again", async () => {
		const deps = fused();
		await executeFusedTargetedEvent({ eventId: "event" }, deps);
		deps.execution.begin.mockResolvedValue({ state: "completed", event } as never);
		await executeFusedTargetedEvent({ eventId: "event" }, deps);
		expect(deps.execution.execute).toHaveBeenCalledOnce();
		expect(deps.execution.recover).toHaveBeenCalledOnce();
	});
	it("does not ACK or continue a dispatch that lost its durable phase", async () => {
		const deps = fused();
		deps.execution.execute.mockResolvedValue({
			phaseOwnershipLost: true,
			continuation: { eventIds: ["must-not-run"], pollAttemptId: "stale-attempt" },
		} as never);
		expect(await executeFusedTargetedEvent({ eventId: "event" }, deps)).toMatchObject({
			preparedEvent: null,
			executedEvent: request,
			deliveryState: "pending",
			continuation: { eventIds: [] },
		});
		expect(deps.execution.complete).not.toHaveBeenCalled();
		expect(deps.execution.defer).toHaveBeenCalledExactlyOnceWith(executionReceipt);
	});
	it("holds a repeated wrapper whose prior paid effect has an unknown outcome", async () => {
		const deps = fused();
		deps.execution.begin.mockResolvedValue({ state: "recovery-required", event } as never);
		await expect(executeFusedTargetedEvent({ eventId: "event" }, deps)).rejects.toThrow(
			"OUTBOX_RECOVERY_REQUIRED",
		);
		expect(deps.execution.execute).not.toHaveBeenCalled();
		expect(deps.execution.complete).not.toHaveBeenCalled();
	});
	it.each(["completed", "held", "missing"] as const)(
		"read-only recovery of %s never claims or executes",
		async (state) => {
			const deps = fused();
			deps.recover.mockResolvedValue({
				eventRecoveryState: state,
				continuation: { eventIds: [], pollAttemptId: "accepted-attempt" },
			} as never);
			expect(
				await executeFusedTargetedEvent({ eventId: "event", recoverOnly: true }, deps),
			).toMatchObject({ preparedEvent: null, eventRecoveryState: state });
			expect(deps.prepare).not.toHaveBeenCalled();
			expect(deps.execute).not.toHaveBeenCalled();
		},
	);
	it("returns transfer work for separate admission without beginning it on control", async () => {
		const deps = fused();
		const heavy = { ...request, taskId: "media-finalize-generation" };
		deps.prepare.mockResolvedValue({ preparedEvent: heavy });
		expect(await executeFusedTargetedEvent({ eventId: "event" }, deps)).toEqual({
			preparedEvent: heavy,
		});
		expect(deps.execute).not.toHaveBeenCalled();
	});
	it("hands a confirmed settlement rollback back with the same receipt", async () => {
		const deps = fused();
		const settlement = { ...request, taskId: "media-settle-generation" };
		deps.prepare.mockResolvedValue({ preparedEvent: settlement });
		deps.execution.begin.mockResolvedValue({
			state: "active",
			event: { ...event, eventType: "GENERATION_SETTLE" },
		} as never);
		deps.execution.execute.mockRejectedValue(new SettlementTransactionConflictError(null));
		expect(await executeFusedTargetedEvent({ eventId: "event" }, deps)).toEqual({
			preparedEvent: settlement,
		});
		expect(deps.execution.defer).toHaveBeenCalledOnce();
		expect(deps.execution.complete).not.toHaveBeenCalled();
	});
	it("retains a PENDING review receipt without ACK and returns its first poll result", async () => {
		const deps = fused();
		const review = { ...request, taskId: "media-verify-upload", payload: { assetId: "asset" } };
		deps.prepare.mockResolvedValue({ preparedEvent: review });
		deps.execution.begin.mockResolvedValue({
			state: "active",
			event: {
				...event,
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: "asset",
			},
		} as never);
		deps.execution.execute.mockResolvedValue({
			done: false,
			waitSeconds: 5,
			queryOnly: true,
			continuation: { eventIds: [] },
		} as never);
		const result = await executeFusedTargetedEvent({ eventId: "event" }, deps);
		expect(result).toMatchObject({
			executedEvent: review,
			deliveryState: "pending",
			poll: { done: false, waitSeconds: 5, queryOnly: true },
		});
		expect(deps.execution.complete).not.toHaveBeenCalled();
		expect(deps.execution.defer).toHaveBeenCalledOnce();
	});
});

describe("same Workflow event execution", () => {
	it("refuses a marked live receipt even when an older caller repeats execution", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({ state: "recovery-required", event } as never);
		await expect(executeTargetedEvent(request, deps)).rejects.toThrow("OUTBOX_RECOVERY_REQUIRED");
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.fail).not.toHaveBeenCalled();
	});
	it("leaves the atomic execution guard intact after a lost begin response without entering business execution", async () => {
		const deps = dependencies();
		const error = new Error("renewal response lost");
		deps.begin.mockRejectedValue(error);
		await expect(executeTargetedEvent(request, deps)).rejects.toBe(error);
		expect(deps.fail).not.toHaveBeenCalled();
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});
	it.each([new OutputTransferClaimConflictError(null), new GenerationTransferRequiresHeavyError()])(
		"preserves the finalization receipt for an explicit safe continuation without nested retry",
		async (error) => {
			const deps = dependencies();
			deps.begin.mockResolvedValue({
				state: "active",
				event: { ...event, eventType: "GENERATION_FINALIZE" },
			} as never);
			deps.execute.mockRejectedValue(error);
			await expect(
				executeTargetedEvent({ ...request, taskId: "media-finalize-generation" }, deps),
			).rejects.toBe(error);
			expect(deps.execute).toHaveBeenCalledOnce();
			expect(deps.fail).not.toHaveBeenCalled();
			expect(deps.complete).not.toHaveBeenCalled();
		},
	);
	it("preserves the original failure when writing the fenced recovery marker also fails", async () => {
		const deps = dependencies();
		const error = new Error("original unknown");
		deps.execute.mockRejectedValue(error);
		deps.fail.mockRejectedValue(new Error("database unavailable"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await expect(executeTargetedEvent(request, deps)).rejects.toBe(error);
			expect(warn).toHaveBeenCalledWith("outbox_recovery_marker_failed", {
				eventId: receipt.eventId,
			});
		} finally {
			warn.mockRestore();
		}
		expect(deps.complete).not.toHaveBeenCalled();
	});
	it("keeps the receipt retryable only after a nominal settlement transaction rollback", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({
			state: "active",
			event: { ...event, eventType: "GENERATION_SETTLE" },
		} as never);
		const error = new SettlementTransactionConflictError({ code: "55P03" });
		deps.execute.mockRejectedValue(error);
		await expect(
			executeTargetedEvent({ ...request, taskId: "media-settle-generation" }, deps),
		).rejects.toBe(error);
		expect(deps.execute).toHaveBeenCalledOnce();
		expect(deps.fail).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.defer).toHaveBeenCalledExactlyOnceWith(executionReceipt);
	});
	it.each([false, new Error("guard clear response lost")])(
		"does not emit a rollback retry when releasing its execution guard fails: %s",
		async (failure) => {
			const deps = dependencies();
			deps.begin.mockResolvedValue({
				state: "active",
				event: { ...event, eventType: "GENERATION_SETTLE" },
			} as never);
			const conflict = new SettlementTransactionConflictError({ code: "55P03" });
			deps.execute.mockRejectedValue(conflict);
			if (failure instanceof Error) deps.defer.mockRejectedValue(failure);
			else deps.defer.mockResolvedValue(failure);
			await expect(
				executeTargetedEvent({ ...request, taskId: "media-settle-generation" }, deps),
			).rejects.toMatchObject({ code: "OUTBOX_RECOVERY_REQUIRED" });
			expect(deps.fail).toHaveBeenCalledExactlyOnceWith(executionReceipt);
			expect(deps.complete).not.toHaveBeenCalled();
		},
	);
	it("treats a review result without an explicit done flag as unknown, not safe PENDING", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({
			state: "active",
			event: {
				...event,
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: "asset",
				payload: { assetId: "asset" },
			},
		} as never);
		await expect(
			executeTargetedEvent(
				{ taskId: "media-verify-upload", payload: { assetId: "asset" }, outboxReceipt: receipt },
				deps,
			),
		).rejects.toThrow("INVALID_OUTBOX_EXECUTION_RESULT");
		expect(deps.fail).toHaveBeenCalledExactlyOnceWith(executionReceipt);
		expect(deps.defer).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});
	it.each([
		["media-settle-generation", "GENERATION_SETTLE", new OutputTransferClaimConflictError(null)],
		[
			"media-finalize-generation",
			"GENERATION_FINALIZE",
			new SettlementTransactionConflictError(null),
		],
		["media-settle-generation", "GENERATION_SETTLE", { code: "P2034" }],
		[
			"media-settle-generation",
			"GENERATION_SETTLE",
			{ code: "SETTLEMENT_TRANSACTION_CONFLICT", phase: "TRANSACTION_ROLLED_BACK" },
		],
		[
			"media-settle-generation",
			"GENERATION_SETTLE",
			new Error("COMMIT response lost", { cause: { code: "ECONNRESET" } }),
		],
	] as const)(
		"holds unsafe %s failures instead of granting retry by code alone",
		async (taskId, eventType, error) => {
			const deps = dependencies();
			deps.begin.mockResolvedValue({ state: "active", event: { ...event, eventType } } as never);
			deps.execute.mockRejectedValue(error);
			await expect(executeTargetedEvent({ ...request, taskId }, deps)).rejects.toBe(error);
			expect(deps.execute).toHaveBeenCalledOnce();
			expect(deps.fail).toHaveBeenCalledExactlyOnceWith(executionReceipt);
			expect(deps.complete).not.toHaveBeenCalled();
		},
	);
	it("records an unknown failure against the current receipt without ACK, retry or raw error persistence", async () => {
		const deps = dependencies();
		const error = new Error("https://private-output.example/secret?token=credential");
		deps.execute.mockRejectedValue(error);
		await expect(executeTargetedEvent(request, deps)).rejects.toBe(error);
		expect(deps.fail).toHaveBeenCalledExactlyOnceWith(executionReceipt);
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.execute).toHaveBeenCalledOnce();
	});
	it("prepares one claimed event without creating a child Workflow", async () => {
		const prepare = vi.fn(async () => event);
		const resolve = vi.fn(async () => ({
			taskId: dispatchTask,
			provider: "kie" as const,
			providerModelId: "nano-banana-2",
		}));
		const complete = vi.fn(async () => true);
		const value = await prepareTargetedEvent(
			{ eventId: "event", workerId: receipt.workerId },
			{ prepare, resolve, complete },
		);
		expect(prepare).toHaveBeenCalledExactlyOnceWith({
			eventId: "event",
			workerId: receipt.workerId,
		});
		expect(value).toMatchObject({
			taskId: dispatchTask,
			payload: { jobId: "job", version: 0 },
			outboxReceipt: receipt,
		});
		expect(complete).not.toHaveBeenCalled();
	});
	it("does not acknowledge an unavailable lease and completes a resolved no-op", async () => {
		const deps = {
			prepare: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(event),
			resolve: vi.fn(async () => null),
			complete: vi.fn(async () => true),
		};
		expect(
			await prepareTargetedEvent({ eventId: "event", workerId: receipt.workerId }, deps),
		).toBeNull();
		expect(deps.complete).not.toHaveBeenCalled();
		expect(
			await prepareTargetedEvent({ eventId: "event", workerId: receipt.workerId }, deps),
		).toBeNull();
		expect(deps.complete).toHaveBeenCalledExactlyOnceWith(receipt);
	});
	it("ACKs durable acceptance before handing the accepted attempt back to long polling", async () => {
		const deps = dependencies();
		const order: string[] = [];
		deps.execute.mockImplementation(async () => {
			order.push("durable-acceptance");
			return { continuation: { eventIds: [], pollAttemptId: "accepted-attempt" } };
		});
		deps.complete.mockImplementation(async () => {
			order.push("ack");
			return true;
		});
		expect(await executeTargetedEvent(request, deps)).toMatchObject({
			deliveryState: "completed",
			continuation: { pollAttemptId: "accepted-attempt" },
		});
		order.push("poll-can-start");
		expect(order).toEqual(["durable-acceptance", "ack", "poll-can-start"]);
		expect(deps.execute).toHaveBeenCalledExactlyOnceWith({
			taskId: dispatchTask,
			payload: request.payload,
		});
	});
	it("recovers a lost response after PROCESSED without invoking the paid handler again", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({ state: "completed", event } as never);
		expect(await executeTargetedEvent(request, deps)).toMatchObject({
			deliveryState: "completed",
			continuation: { pollAttemptId: "accepted-attempt" },
		});
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
		expect(deps.recover).toHaveBeenCalledExactlyOnceWith(request);
	});
	it("never executes or ACKs an expired or reclaimed receipt", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({ state: "lost", event: null } as never);
		expect(await executeTargetedEvent(request, deps)).toMatchObject({
			deliveryState: "lost",
			continuation: { eventIds: [] },
		});
		expect(deps.execute).not.toHaveBeenCalled();
		expect(deps.complete).not.toHaveBeenCalled();
	});
	it("retains a PENDING review event and renews it again on the terminal poll", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({
			state: "active",
			event: {
				...event,
				aggregateType: "MEDIA_ASSET",
				aggregateId: "asset",
				eventType: "MEDIA_ASSET_VERIFY",
				payload: { assetId: "asset" },
			},
		} as never);
		deps.execute
			.mockResolvedValueOnce({
				done: false,
				waitSeconds: 5,
				continuation: { eventIds: [] },
			} as never)
			.mockResolvedValueOnce({
				done: true,
				waitSeconds: 0,
				continuation: { eventIds: ["finalize"] },
			} as never);
		const review = {
			taskId: "media-verify-upload",
			payload: { assetId: "asset" },
			outboxReceipt: receipt,
		};
		expect(await executeTargetedEvent(review, deps)).toMatchObject({
			done: false,
			deliveryState: "pending",
		});
		expect(deps.complete).not.toHaveBeenCalled();
		expect(await executeTargetedEvent(review, deps)).toMatchObject({
			done: true,
			deliveryState: "completed",
		});
		expect(deps.begin).toHaveBeenCalledTimes(2);
		expect(deps.complete).toHaveBeenCalledOnce();
	});
	it("covers the full 900 second transfer instead of using the prepare lease duration", async () => {
		const deps = dependencies();
		deps.begin.mockResolvedValue({
			state: "active",
			event: { ...event, eventType: "GENERATION_FINALIZE" },
		} as never);
		await executeTargetedEvent({ ...request, taskId: "media-finalize-generation" }, deps);
		expect(deps.begin).toHaveBeenCalledExactlyOnceWith({ ...receipt, timeoutSeconds: 900 });
	});
	it("does not ACK failures or a completion after another worker took the fence", async () => {
		const deps = dependencies();
		deps.execute.mockRejectedValueOnce(new Error("LOST_PROVIDER_RESPONSE"));
		await expect(executeTargetedEvent(request, deps)).rejects.toThrow("LOST_PROVIDER_RESPONSE");
		expect(deps.complete).not.toHaveBeenCalled();
		deps.complete.mockResolvedValue(false);
		expect(await executeTargetedEvent(request, deps)).toMatchObject({ deliveryState: "lost" });
	});
	it("rejects mismatched event targets before execution, including completed replays", async () => {
		for (const state of ["active", "completed"] as const) {
			const deps = dependencies();
			deps.begin.mockResolvedValue({ state, event } as never);
			await expect(
				executeTargetedEvent({ ...request, payload: { jobId: "other", version: 0 } }, deps),
			).rejects.toThrow("OUTBOX_RECEIPT_TASK_MISMATCH");
			expect(deps.execute).not.toHaveBeenCalled();
			expect(deps.recover).not.toHaveBeenCalled();
		}
	});
	it("requires explicit receipt-aware responses and rejects unrelated or unbounded tasks", () => {
		expect(() => parseEventDeliveryResult(request, { continuation: { eventIds: [] } })).toThrow();
		expect(() =>
			parseEventDeliveryResult(
				{ taskId: "media-prepare-event", payload: { eventId: "event" } },
				{},
			),
		).toThrow();
		for (const task of [
			{ taskId: "media-process-payment-event", payload: { paymentEventId: "payment" } },
			{ taskId: "media-deliver-outbox", payload: {} },
			{ taskId: dispatchTask, payload: { ...request.payload, arbitraryUrl: "https://private" } },
		])
			expect(() => parseTaskRequest({ ...task, outboxReceipt: receipt })).toThrow();
		expect(parseTaskRequest(request)).toEqual(request);
	});
});
