import { describe, expect, it, vi } from "vitest";

import {
	claimOutboxBatch,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	deferOutboxEvent,
} from "./outbox";
import type { MediaTransactionClient } from "./types";

describe("targeted Outbox claim transaction boundary", () => {
	it("does not retry an atomic claim whose database response is unknown", async () => {
		const failure = new Error("COMMIT response lost", { cause: { code: "ECONNRESET" } });
		const queryRaw = vi.fn().mockRejectedValue(failure);
		const transaction = vi.fn();
		const client = {
			$queryRaw: queryRaw,
			$transaction: transaction,
		} as unknown as MediaTransactionClient;
		await expect(
			claimOutboxBatch(
				{ eventIds: ["event"], workerId: "workflow", limit: 1, leaseSeconds: 90 },
				client,
			),
		).rejects.toBe(failure);
		expect(queryRaw).toHaveBeenCalledOnce();
		expect(transaction).not.toHaveBeenCalled();
	});
	it.each([undefined, "old-output-review"])(
		"retains the Serializable transaction for legacy selector %s",
		async (outputReviewEventId) => {
			const queryRaw = vi.fn().mockResolvedValue([]);
			const transaction = vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
				operation({ $queryRaw: queryRaw }),
			);
			const client = { $transaction: transaction } as unknown as MediaTransactionClient;
			expect(
				await claimOutboxBatch(
					{ workerId: "legacy", limit: 1, leaseSeconds: 90, outputReviewEventId },
					client,
				),
			).toEqual([]);
			expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
				isolationLevel: "Serializable",
				maxWait: 5_000,
				timeout: 20_000,
			});
			expect(queryRaw).toHaveBeenCalledOnce();
		},
	);
	it("does not convert an explicit empty target into a scan", async () => {
		const queryRaw = vi.fn();
		const transaction = vi.fn();
		const client = {
			$queryRaw: queryRaw,
			$transaction: transaction,
		} as unknown as MediaTransactionClient;
		await expect(
			claimOutboxBatch({ eventIds: [], workerId: "workflow", limit: 1, leaseSeconds: 90 }, client),
		).rejects.toThrow("Invalid continuation events");
		expect(queryRaw).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});
});

describe("pending Outbox delivery lease CAS", () => {
	it("defers the current unexpired lease atomically without consuming an attempt", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const client = { outboxEvent: { updateMany } } as unknown as MediaTransactionClient;
		const now = new Date("2026-09-08T16:00:00.000Z");
		const retryAt = new Date(now.getTime() + 30_000);
		expect(
			await deferOutboxEvent(
				{ id: "event-1", workerId: "worker-1", leaseToken: "lease-1", retryAt, now },
				client,
			),
		).toEqual({ applied: true });
		expect(updateMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				id: "event-1",
				status: "LEASED",
				leaseOwner: "worker-1",
				leaseToken: "lease-1",
				leasedUntil: { gt: now },
				attempts: { gt: 0 },
			},
			data: {
				status: "PENDING",
				availableAt: retryAt,
				attempts: { decrement: 1 },
				leaseOwner: null,
				leaseToken: null,
				leasedUntil: null,
			},
		});
	});

	it("reports an expired or reclaimed lease without a fallback mutation", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const client = { outboxEvent: { updateMany } } as unknown as MediaTransactionClient;
		expect(
			await deferOutboxEvent(
				{ id: "event-1", workerId: "worker-old", leaseToken: "lease-old", retryAt: new Date() },
				client,
			),
		).toEqual({ applied: false });
		expect(updateMany).toHaveBeenCalledTimes(1);
	});
});

describe("same Workflow Outbox receipts", () => {
	const now = new Date("2026-10-21T16:00:00.000Z");
	const receipt = { eventId: "event", workerId: "workflow", leaseToken: "fence" };
	const executionMarker = "EXECUTION_IN_PROGRESS:00000000-0000-4000-8000-000000000000";
	const executionReceipt = { ...receipt, executionMarker };
	it("adds the engine observation to the successful begin statement only when requested", async () => {
		const event = { id: "event", aggregateType: "MEDIA_ASSET", aggregateId: "asset" };
		const queryRaw = vi.fn().mockResolvedValue([{ ...event, observedExecutionEngine: "legacy" }]);
		const findFirst = vi.fn();
		const client = {
			$queryRaw: queryRaw,
			outboxEvent: { findFirst },
		} as unknown as MediaTransactionClient;
		expect(
			await beginWorkflowOutboxExecution(
				{ ...receipt, timeoutSeconds: 120, observeExecutionEngine: true },
				client,
			),
		).toEqual({
			state: "active",
			event,
			engineObservation: { aggregateType: "MEDIA_ASSET", aggregateId: "asset", engine: "legacy" },
		});
		expect(queryRaw).toHaveBeenCalledOnce();
		const fragments = queryRaw.mock.calls[0]!.slice(1)
			.filter((part) => part?.sql)
			.map((part) => part.sql)
			.join(" ");
		expect(fragments).toContain('asset."verificationEngine"');
		expect(fragments).toContain('job."executionEngine"');
		expect(findFirst).not.toHaveBeenCalled();
	});
	it("never turns an absent aggregate into a legacy engine observation", async () => {
		const event = { id: "event", aggregateType: "MEDIA_ASSET", aggregateId: "missing" };
		const queryRaw = vi.fn().mockResolvedValue([{ ...event, observedExecutionEngine: null }]);
		const client = { $queryRaw: queryRaw } as unknown as MediaTransactionClient;
		expect(
			await beginWorkflowOutboxExecution(
				{ ...receipt, timeoutSeconds: 120, observeExecutionEngine: true },
				client,
			),
		).toMatchObject({
			engineObservation: { aggregateId: "missing", engine: null },
		});
	});
	it("returns a held state for the same marked live receipt instead of renewing it", async () => {
		const event = { id: "event", status: "LEASED", lastError: "RECOVERY_REQUIRED" };
		const queryRaw = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([event]);
		const client = {
			$queryRaw: queryRaw,
			outboxEvent: { findFirst: vi.fn().mockResolvedValue(null) },
		} as unknown as MediaTransactionClient;
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 900, now }, client),
		).toEqual({ state: "recovery-required", event });
		expect(queryRaw.mock.calls[0]![0].join("?")).toContain(
			`split_part(event."lastError", ':', 1) NOT IN ('RECOVERY_REQUIRED', 'EXECUTION_IN_PROGRESS', 'RECOVERY_QUERY_IN_PROGRESS')`,
		);
	});
	it("releases only a live execution guard and preserves a query's pre-existing unknown hold", async () => {
		const executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const client = { $executeRaw: executeRaw } as unknown as MediaTransactionClient;
		expect(await deferWorkflowOutboxExecution({ ...executionReceipt, now }, client)).toBe(true);
		expect(await deferWorkflowOutboxExecution({ ...executionReceipt, now }, client)).toBe(false);
		const query = executeRaw.mock.calls[0]!;
		const sql = query[0].join("?");
		expect(sql).toContain(
			`CASE WHEN split_part(event."lastError", ':', 1) = 'RECOVERY_QUERY_IN_PROGRESS'`,
		);
		expect(sql).toContain(`THEN 'RECOVERY_REQUIRED' ELSE NULL END`);
		expect(sql).toContain(`event."lastError" = ?`);
		expect(query.slice(1).flatMap((value) => value?.values ?? [value])).toEqual([
			"event",
			"workflow",
			"fence",
			now,
			executionMarker,
		]);
	});
	it("records only a closed recovery marker while preserving the exact live receipt", async () => {
		const executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const client = { $executeRaw: executeRaw } as unknown as MediaTransactionClient;
		expect(await failWorkflowOutboxExecution({ ...executionReceipt, now }, client)).toBe(true);
		expect(await failWorkflowOutboxExecution({ ...executionReceipt, now }, client)).toBe(false);
		const query = executeRaw.mock.calls[0]!;
		const sql = query[0].join("?");
		expect(sql).toContain(`SET "lastError" = 'RECOVERY_REQUIRED'`);
		expect(sql).toContain(`event."status" = 'LEASED'`);
		expect(sql).toContain(`event."leasedUntil" > ?`);
		expect(query.slice(1).flatMap((value) => value?.values ?? [value])).toEqual([
			"event",
			"workflow",
			"fence",
			now,
			executionMarker,
		]);
		expect(executeRaw).toHaveBeenCalledTimes(2);
	});
	it("renews a 900 second finalization in one conditional statement with deadline grace", async () => {
		const event = { id: "event" };
		const queryRaw = vi.fn().mockResolvedValue([event]);
		const findFirst = vi.fn();
		const client = {
			$queryRaw: queryRaw,
			outboxEvent: { findFirst },
		} as unknown as MediaTransactionClient;
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 900, now }, client),
		).toEqual({ state: "active", event });
		expect(queryRaw).toHaveBeenCalledOnce();
		const query = queryRaw.mock.calls[0]!;
		expect(query[0].join("?")).toContain('event."leasedUntil" > ?');
		expect(query[0].join("?")).toContain(
			"THEN 'RECOVERY_QUERY_IN_PROGRESS:' ELSE 'EXECUTION_IN_PROGRESS:' END) || gen_random_uuid()::text",
		);
		expect(query.slice(1).flatMap((value) => value?.values ?? [value])).toEqual([
			now,
			930,
			"event",
			"workflow",
			"fence",
			now,
			false,
		]);
		expect(findFirst).not.toHaveBeenCalled();
	});
	it("only resolves a lost fence as completed when durable PROCESSED evidence exists", async () => {
		const queryRaw = vi.fn().mockResolvedValue([]);
		const findFirst = vi
			.fn()
			.mockResolvedValueOnce({ id: "event", status: "PROCESSED" })
			.mockResolvedValueOnce(null);
		const client = {
			$queryRaw: queryRaw,
			outboxEvent: { findFirst },
		} as unknown as MediaTransactionClient;
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 120, now }, client),
		).toMatchObject({ state: "completed" });
		expect(
			await beginWorkflowOutboxExecution({ ...receipt, timeoutSeconds: 120, now }, client),
		).toEqual({ state: "lost", event: null });
		expect(findFirst).toHaveBeenCalledWith({ where: { id: "event", status: "PROCESSED" } });
	});
	it("ACKs only the exact unexpired receipt and never falls back to an unfenced update", async () => {
		const executeRaw = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const client = { $executeRaw: executeRaw } as unknown as MediaTransactionClient;
		expect(await completeWorkflowOutboxExecution({ ...receipt, now }, client)).toBe(true);
		expect(await completeWorkflowOutboxExecution({ ...receipt, now }, client)).toBe(false);
		expect(executeRaw).toHaveBeenCalledTimes(2);
		const query = executeRaw.mock.calls[0]!;
		expect(query[0].join("?")).toContain('event."leasedUntil" > ?');
		expect(query.slice(1).flatMap((value) => value?.values ?? [value])).toEqual([
			now,
			"event",
			"workflow",
			"fence",
			now,
			null,
			null,
		]);
	});
	it.each([0, -1, 901, 1.5, Infinity])(
		"rejects an invalid execution timeout %s before database access",
		async (timeoutSeconds) => {
			const queryRaw = vi.fn();
			const client = { $queryRaw: queryRaw } as unknown as MediaTransactionClient;
			await expect(
				beginWorkflowOutboxExecution({ ...receipt, now, timeoutSeconds }, client),
			).rejects.toThrow("INVALID_OUTBOX_EXECUTION_TIMEOUT");
			expect(queryRaw).not.toHaveBeenCalled();
		},
	);
});
