import type { NormalizedResult, ProviderSubmission } from "@repo/ai";
import type { ImagePhaseOwner } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/client", () => ({ db: {} }));

import {
	ProviderEventPhaseHeldError,
	type DispatchStore,
	type ReconciliationLease,
} from "./contracts";
import { dispatchGeneration } from "./handlers/dispatch-generation";
import { reconcileGenerations } from "./handlers/reconcile-generations";
import {
	createDatabaseDispatchStore,
	createDatabaseProviderEventStore,
	createDatabaseReconciliationStore,
} from "./runtime";

const oldOwner: ImagePhaseOwner = { workflowId: "old-workflow", phaseKey: "phase-key", epoch: 1 };
const newOwner: ImagePhaseOwner = { workflowId: "new-workflow", phaseKey: "phase-key", epoch: 2 };
const submission: Extract<ProviderSubmission, { outcome: "accepted" }> = {
	outcome: "accepted",
	providerTaskId: "task",
	status: "SUCCEEDED",
	idempotency: { providerSupported: false, replayed: false },
	reconciliation: { submissionToken: "attempt" },
	snapshot: { providerTaskId: "task", status: "SUCCEEDED", raw: {} },
};
const result: NormalizedResult = {
	outputs: [
		{
			kind: "remote-url",
			url: "https://media.example.test/output.png",
			trust: "untrusted-transfer-candidate",
		},
	],
	progress: 100,
	providerCostMicros: 20_000,
	providerCharged: true,
	failure: null,
	retryable: false,
};

function fixture() {
	const phase = { owner: newOwner as ImagePhaseOwner | undefined };
	const attempt = {
		id: "attempt",
		jobId: "job",
		provider: "kie",
		providerTaskId: null as string | null,
		status: "SUBMISSION_UNCERTAIN",
		uncertainSubmission: true,
		providerCostMicros: 30_000n,
		responseSnapshot: { providerCharged: true } as Record<string, unknown>,
		errorSnapshot: {},
		job: {
			executionEngine: "legacy",
			productKey: "image-nano-banana-2-lite",
			status: "PROVIDER_PENDING",
		},
	};
	const event = {
		id: "event",
		provider: "kie",
		providerTaskId: "task",
		status: "RECEIVED",
		processingToken: null as string | null,
		processingLeasedUntil: null as Date | null,
	};
	const envelope = new Map<string, unknown>();
	const query = vi.fn(
		async (sql: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
			const statement = sql.join("?");
			if (statement.includes('AS "retryAfterMs"'))
				return [
					{
						retryAfterMs: Math.max(
							phase.owner ? 600_000 : 0,
							values[1] === true && event.processingLeasedUntil
								? event.processingLeasedUntil.getTime() - Date.now()
								: 0,
						),
					},
				];
			if (statement.includes('AS "current"')) {
				const [, , , phaseKey, workflowId, epoch] = values;
				return [
					{
						current:
							!!phase.owner &&
							phase.owner.phaseKey === phaseKey &&
							phase.owner.workflowId === workflowId &&
							phase.owner.epoch === epoch,
					},
				];
			}
			if (statement.includes('SELECT "phaseKey"')) return phase.owner ? [phase.owner] : [];
			if (statement.includes('AS "pending"'))
				return [
					{
						nextReconcileAt: null,
						reconcileLeasedUntil: null,
						pending: attempt.status === "RUNNING",
						...phase.owner,
					},
				];
			if (statement.includes('SELECT "reconcileLeasedUntil"')) return [];
			if (statement.includes('FROM "generation_attempt"')) return [attempt];
			throw new Error(`UNEXPECTED_PHASE_QUERY:${statement}`);
		},
	);
	const tx = {
		$queryRaw: query,
		$executeRaw: vi.fn(async () => 1),
		generationAttempt: {
			findUniqueOrThrow: vi.fn(async () => attempt),
			findUnique: vi.fn(async () => attempt),
			findFirst: vi.fn(async () => attempt),
			update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
				Object.assign(attempt, data),
			),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		generationJob: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
		generationAttemptTransferEnvelope: {
			upsert: vi.fn(async ({ create }: { create: { attemptId: string; payload: unknown } }) => {
				if (!envelope.has(create.attemptId)) envelope.set(create.attemptId, create.payload);
				return {};
			}),
		},
		providerWebhookEvent: {
			findFirst: vi.fn(async () => event),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
		outboxEvent: { upsert: vi.fn() },
	};
	const database = {
		...tx,
		$transaction: async (operation: (value: typeof tx) => Promise<unknown>) => operation(tx),
	};
	return {
		phase,
		attempt,
		event,
		envelope,
		tx,
		database,
		store: createDatabaseDispatchStore(database as never),
	};
}

describe("image phase ownership at runtime side-effect boundaries", () => {
	it("blocks a stale pre-send claim before any provider state change", async () => {
		const f = fixture();
		await expect(f.store.recordSubmissionStarted("attempt", oldOwner)).resolves.toBe(false);
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
	});

	it("reports ownership loss even when synchronous completion observes an existing terminal marker", async () => {
		const f = fixture();
		f.attempt.providerTaskId = "task";
		f.attempt.responseSnapshot = {
			providerTerminalEvidence: {
				version: 1,
				provider: "kie",
				source: "kie-record-info",
				attemptId: "attempt",
				providerTaskId: "task",
				status: "FAILED",
				verifiedAt: new Date().toISOString(),
			},
		};
		await expect(
			f.store.recordSynchronousCompletion("attempt", submission, result, oldOwner),
		).resolves.toEqual({ phaseOwnershipLost: true, phaseOwner: newOwner });
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("preserves one late synchronous completion without clearing uncertainty or replacing its evidence", async () => {
		const f = fixture();
		await expect(
			f.store.recordSynchronousCompletion("attempt", submission, result, oldOwner),
		).resolves.toEqual({ phaseOwnershipLost: true, phaseOwner: newOwner });
		expect(f.attempt).toMatchObject({
			providerTaskId: "task",
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
			providerCostMicros: 30_000n,
			responseSnapshot: {
				providerCharged: true,
				phaseCompletion: { providerTaskId: "task", providerCostMicros: 20_000 },
			},
		});
		const firstSnapshot = structuredClone(f.attempt.responseSnapshot);
		await f.store.recordSynchronousCompletion(
			"attempt",
			submission,
			{
				...result,
				progress: 1,
				providerCharged: false,
				providerCostMicros: 1,
				outputs: [
					{
						kind: "remote-url",
						url: "https://media.example.test/second.png",
						trust: "untrusted-transfer-candidate",
					},
				],
			},
			oldOwner,
		);
		expect(f.attempt.responseSnapshot).toEqual(firstSnapshot);
		expect(f.tx.generationAttemptTransferEnvelope.upsert).toHaveBeenCalledOnce();
		expect(f.tx.generationAttempt.update).toHaveBeenCalledOnce();
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
		expect(f.tx.outboxEvent.upsert).not.toHaveBeenCalled();
	});

	it("preserves late accepted identity from an old caller while leaving the active owner in charge", async () => {
		const f = fixture();
		await expect(
			f.store.recordSubmission("attempt", { ...submission, status: "RUNNING" }),
		).resolves.toEqual({ phaseOwnershipLost: true, phaseOwner: newOwner });
		expect(f.attempt).toMatchObject({
			providerTaskId: "task",
			status: "SUBMISSION_UNCERTAIN",
			uncertainSubmission: true,
		});
		expect(f.tx.generationJob.updateMany).not.toHaveBeenCalled();
	});

	it("does not mistake a terminal attempt observed by a stale owner for permission to continue", async () => {
		const f = fixture();
		f.attempt.status = "SUCCEEDED";
		await expect(
			createDatabaseReconciliationStore(f.database as never, {
				workflowId: oldOwner.workflowId,
				phaseOwner: oldOwner,
			}).getPollingState("attempt"),
		).resolves.toMatchObject({ phaseOwnershipLost: true, phaseOwner: newOwner });
	});

	it("requires a legacy accepted or uncertain attempt before registering a polling phase", async () => {
		const f = fixture();
		await expect(
			createDatabaseReconciliationStore(f.database as never, {
				workflowId: newOwner.workflowId,
			}).claimStale({ attemptId: "attempt", limit: 1, leaseSeconds: 300, now: new Date() }),
		).resolves.toEqual([]);
		const sql = String(f.tx.$queryRaw.mock.calls[0]?.[0]);
		expect(sql).toContain("\"executionEngine\" = 'legacy'");
		expect(sql).toContain('"providerTaskId" IS NOT NULL OR "uncertainSubmission" = true');
		expect(f.tx.$executeRaw).not.toHaveBeenCalled();
	});

	it("keeps callback delivery pending while another phase owner is active", async () => {
		const f = fixture();
		await expect(
			createDatabaseProviderEventStore(f.database as never).claimProviderEvent("event"),
		).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
		expect(f.tx.providerWebhookEvent.updateMany).not.toHaveBeenCalled();
	});

	it("keeps a previously claimed callback pending until its processing lease releases", async () => {
		const f = fixture();
		f.phase.owner = undefined;
		f.event.status = "PROCESSING";
		f.event.processingLeasedUntil = new Date(Date.now() + 60_000);
		await expect(
			createDatabaseProviderEventStore(f.database as never).claimProviderEvent("event"),
		).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
		expect(f.tx.providerWebhookEvent.updateMany).not.toHaveBeenCalled();
	});

	it("does not acknowledge a callback claim CAS race as a completed delivery", async () => {
		const f = fixture();
		f.phase.owner = undefined;
		f.tx.providerWebhookEvent.updateMany.mockResolvedValue({ count: 0 });
		await expect(
			createDatabaseProviderEventStore(f.database as never).claimProviderEvent("event"),
		).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
		expect(f.tx.providerWebhookEvent.update).not.toHaveBeenCalled();
	});

	it("does not ACK callback progress when a new phase owner appeared after claim", async () => {
		const f = fixture();
		await expect(
			createDatabaseProviderEventStore(f.database as never).recordProviderProgress(
				{
					eventId: "event",
					attemptId: "attempt",
					provider: "kie",
					snapshot: submission.snapshot!,
					receivedAt: new Date(),
					processingToken: "processing",
				},
				result,
			),
		).rejects.toBeInstanceOf(ProviderEventPhaseHeldError);
		expect(f.tx.generationAttempt.update).not.toHaveBeenCalled();
		expect(f.tx.providerWebhookEvent.updateMany).not.toHaveBeenCalled();
	});

	it("does not call a paid adapter after losing the pre-send fence", async () => {
		const submit = vi.fn();
		const store = {
			claimDispatch: vi.fn().mockResolvedValue({
				jobId: "job",
				attemptId: "attempt",
				provider: "kie",
				attemptNumber: 1,
				phaseOwner: oldOwner,
			}),
			recordSubmissionStarted: vi.fn().mockResolvedValue(false),
		} as unknown as DispatchStore;
		await expect(
			dispatchGeneration(
				{ jobId: "job", version: 1 },
				{ store, isGenerationEnabled: () => true, getProvider: () => ({ submit }) as never },
			),
		).resolves.toMatchObject({ phaseOwnershipLost: true });
		expect(submit).not.toHaveBeenCalled();
	});

	it("consumes a preserved authenticated completion without another provider request", async () => {
		const lease: ReconciliationLease = {
			jobId: "job",
			version: 1,
			attemptId: "attempt",
			provider: "kie",
			providerTaskId: "task",
			leaseToken: "lease",
			staleAgeMinutes: 1,
			repairCount: 0,
			phaseOwner: newOwner,
			completion: { snapshot: submission.snapshot!, result },
		};
		const getProvider = vi.fn(() => {
			throw new Error("NO_ADAPTER_NEEDED");
		});
		const recordReconciled = vi.fn().mockResolvedValue({ outboxCommitted: true });
		await expect(
			reconcileGenerations(
				{ attemptId: "attempt" },
				{
					getProvider,
					store: {
						claimStale: vi.fn().mockResolvedValue([lease]),
						recordReconciled,
						releaseReconciliationLease: vi.fn(),
						markUncertainForManualReconciliation: vi.fn(),
					},
				},
			),
		).resolves.toEqual({ claimed: 1, reconciled: 1, outboxCommitted: true });
		expect(getProvider).not.toHaveBeenCalled();
		expect(recordReconciled).toHaveBeenCalledWith(lease, submission.snapshot, result);
	});
});
