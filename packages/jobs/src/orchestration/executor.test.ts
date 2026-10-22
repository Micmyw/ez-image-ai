import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
} from "@repo/ai/media/moderation/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	OutboxDeliveryPendingError,
	ProviderEventPhaseHeldError,
	type DispatchStore,
	type OutboxLease,
	type OutboxStore,
} from "../contracts";

const mocks = vi.hoisted(() => {
	const outboxStore = {
		claimBatch: vi.fn<OutboxStore["claimBatch"]>(),
		complete: vi.fn<OutboxStore["complete"]>(),
		defer: vi.fn<NonNullable<OutboxStore["defer"]>>(),
		release: vi.fn<OutboxStore["release"]>(),
	};
	const dispatchStore = {
		claimDispatch: vi.fn<DispatchStore["claimDispatch"]>(),
		recordSubmissionStarted: vi.fn(),
		recordSubmission: vi.fn(),
		recordSynchronousCompletion: vi.fn(),
		recordUncertainSubmission: vi.fn(),
		recordProviderAdapterUnavailable: vi.fn(),
		recordRejectedSubmission: vi.fn(),
	};
	const adapter = { provider: "kie", submit: vi.fn(), retrieve: vi.fn(), normalizeResult: vi.fn() };
	const registry = { keys: () => ["kie"] };
	const reconciliationStore = {
		claimStale: vi.fn(),
		recordReconciled: vi.fn(),
		releaseReconciliationLease: vi.fn(),
		markUncertainForManualReconciliation: vi.fn(),
	};
	const finalizationStore = { listCandidates: vi.fn(), recoverCandidate: vi.fn() };
	return {
		outboxStore,
		dispatchStore,
		adapter,
		dispatch: vi.fn(),
		cleanup: vi.fn(),
		copyAccountInput: vi.fn(),
		cleanupAccountInputCopyOrphan: vi.fn(),
		recoverAccountInputCopyTasks: vi.fn(),
		cancel: vi.fn(),
		admit: vi.fn(),
		payment: vi.fn(),
		providerEvent: vi.fn(),
		subscriptions: vi.fn(),
		verify: vi.fn(),
		finalize: vi.fn(),
		expireGuest: vi.fn(),
		monitorGuest: vi.fn(),
		findAssets: vi.fn(),
		findAsset: vi.fn(),
		continuation: vi.fn(async () => ({ eventIds: [] as string[] })),
		findJob: vi.fn(),
		findAttempt: vi.fn(),
		findProviderEvent: vi.fn(),
		resolveDispatchRoute: vi.fn(),
		prepareEvent: vi.fn(),
		beginEvent: vi.fn(),
		completeEvent: vi.fn(),
		failEvent: vi.fn(),
		deferEvent: vi.fn(),
		readEvent: vi.fn(),
		reconciliationStore,
		finalizationStore,
		finalizationRecovery: vi.fn(() => finalizationStore),
		recoverPayments: vi.fn(),
		runtime: {
			createDatabaseAccountInputCopyDependencies: vi.fn(() => ({ marker: "copy" })),
			createDatabaseAccountInputCopyOrphanDependencies: vi.fn(() => ({ marker: "orphan" })),
			createDatabaseAccountInputCopyRecoveryDependencies: vi.fn(() => ({ marker: "recovery" })),
			createProviderRegistry: vi.fn(() => registry),
			createDatabaseDispatchStore: vi.fn(() => dispatchStore),
			getRegisteredProvider: vi.fn(() => adapter),
			createReconciliationProviderRegistry: vi.fn(() => registry),
			getAnyRegisteredProvider: vi.fn(() => adapter),
			databaseOutboxStore: outboxStore,
			databaseStorageCleanupDependencies: {},
			databaseGuestAdmissionDependencies: {},
			databaseProviderCancellationStore: {},
			databaseVerifyUploadDependencies: {},
			databaseGuestMediaExpiryDependencies: {},
			databaseProviderEventStore: {},
			databaseSettlementStore: {},
			databaseReconciliationStore: reconciliationStore,
			createFinalizationDependencies: vi.fn(() => ({})),
		},
	};
});

vi.mock("../runtime", () => ({
	...mocks.runtime,
	resolveDatabaseDispatchRoute: mocks.resolveDispatchRoute,
}));
vi.mock("./client", () => ({ dispatchJob: mocks.dispatch }));
vi.mock("@repo/database/client", () => ({
	db: {
		mediaAsset: { findMany: mocks.findAssets, findUnique: mocks.findAsset },
		generationJob: { findUnique: mocks.findJob },
		generationAttempt: { findUnique: mocks.findAttempt, findFirst: mocks.findAttempt },
		providerWebhookEvent: { findUnique: mocks.findProviderEvent },
	},
}));
vi.mock("@repo/database", async () => ({
	MEDIA_VERIFICATION_OBSERVATION_SELECT: (
		await import("../../../database/prisma/queries/media/continuations")
	).MEDIA_VERIFICATION_OBSERVATION_SELECT,
	expireGenerationDrafts: vi.fn(),
	expirePendingMediaUploadSessions: vi.fn(),
	recoverExpiredPaymentEvents: mocks.recoverPayments,
	monitorGuestOperationalSafety: mocks.monitorGuest,
	getAssetGenerationContinuation: mocks.continuation,
	getFinalizationContinuation: mocks.continuation,
	getSubmittedGenerationContinuation: mocks.continuation,
	getProviderEventContinuation: mocks.continuation,
	getInitialGenerationEventIds: vi.fn(async () => []),
	deleteExpiredImagePhaseOwners: vi.fn(async () => 0),
	prepareWorkflowOutboxDelivery: mocks.prepareEvent,
	beginWorkflowOutboxExecution: mocks.beginEvent,
	completeWorkflowOutboxExecution: mocks.completeEvent,
	failWorkflowOutboxExecution: mocks.failEvent,
	deferWorkflowOutboxExecution: mocks.deferEvent,
	readWorkflowOutboxEvent: mocks.readEvent,
}));
vi.mock("../handlers/process-payment-event", () => ({ processPaymentEvent: mocks.payment }));
vi.mock("../handlers/process-provider-event", () => ({
	processProviderEvent: mocks.providerEvent,
}));
vi.mock("../handlers/reconcile-subscriptions", () => ({
	reconcileSubscriptions: mocks.subscriptions,
}));
vi.mock("../handlers/cleanup-storage-object", () => ({
	deleteStorageObject: mocks.cleanup,
	abortMultipartObject: mocks.cleanup,
	abortPromotionMultipart: mocks.cleanup,
	cleanupUploadPromotion: mocks.cleanup,
}));
vi.mock("../handlers/account-input-copy", () => ({
	copyAccountInput: mocks.copyAccountInput,
	cleanupAccountInputCopyOrphan: mocks.cleanupAccountInputCopyOrphan,
	recoverAccountInputCopyTasks: mocks.recoverAccountInputCopyTasks,
}));
vi.mock("../handlers/cancel-generation", () => ({ cancelProviderGeneration: mocks.cancel }));
vi.mock("../handlers/admit-guest-generation", () => ({ admitGuestGeneration: mocks.admit }));
vi.mock("../handlers/verify-upload", () => ({ verifyUpload: mocks.verify }));
vi.mock("../handlers/finalize-media", () => ({ finalizeMedia: mocks.finalize }));
vi.mock("../handlers/expire-guest-media", () => ({ expireGuestMedia: mocks.expireGuest }));
vi.mock("../handlers/finalization-recovery-store", () => ({
	createDatabaseFinalizingGenerationRecoveryStore: mocks.finalizationRecovery,
}));
vi.mock("../handlers/grant-billing-periods", () => ({ grantBillingPeriods: vi.fn() }));

import { executeTask } from "./executor";
import { assertWorkerInlineTask } from "./worker-executors";

const context = { attempt: 2, maxAttempts: 8, runId: "workflow-1" };

it("executes registered account-copy, orphan and recovery tasks with their production stores", async () => {
	await executeTask(
		{ taskId: "media-copy-account-input", payload: { promotionId: "copy" } },
		context,
	);
	expect(mocks.copyAccountInput).toHaveBeenCalledWith({ promotionId: "copy" }, { marker: "copy" });
	await executeTask(
		{ taskId: "media-cleanup-account-input-copy", payload: { promotionId: "copy" } },
		context,
	);
	expect(mocks.cleanupAccountInputCopyOrphan).toHaveBeenCalledWith(
		{ promotionId: "copy" },
		{ marker: "orphan" },
	);
	await executeTask(
		{ taskId: "media-recover-account-input-copies", payload: { timestamp: 1000 } },
		context,
	);
	expect(mocks.recoverAccountInputCopyTasks).toHaveBeenCalledWith(
		{ timestamp: 1000 },
		{ marker: "recovery" },
	);
});
const event = (overrides: Partial<OutboxLease> = {}): OutboxLease => ({
	id: "outbox-1",
	eventType: "MEDIA_OBJECT_DELETE",
	aggregateId: "asset-1",
	payload: { objectKey: "private/object" },
	leaseToken: "lease-1",
	attempts: 1,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.continuation.mockReset().mockResolvedValue({ eventIds: [] });
	mocks.dispatch.mockResolvedValue(undefined);
	mocks.cleanup.mockResolvedValue(undefined);
	mocks.cancel.mockResolvedValue(undefined);
	mocks.admit.mockResolvedValue(undefined);
	mocks.providerEvent.mockReset().mockResolvedValue({ outcome: "PROCESSED" });
	mocks.outboxStore.claimBatch.mockResolvedValue([]);
	mocks.outboxStore.complete.mockResolvedValue(undefined);
	mocks.outboxStore.defer.mockResolvedValue(undefined);
	mocks.outboxStore.release.mockResolvedValue(undefined);
	mocks.dispatchStore.claimDispatch.mockResolvedValue(null);
	mocks.dispatchStore.recordSubmission.mockReset();
	mocks.dispatchStore.recordSynchronousCompletion.mockReset();
	mocks.findAsset.mockResolvedValue(null);
	mocks.findJob.mockResolvedValue(null);
	mocks.findAttempt.mockResolvedValue(null);
	mocks.findProviderEvent.mockResolvedValue(null);
	mocks.finalize.mockResolvedValue({ outcome: "SKIPPED", readyOutputs: 0 });
	mocks.prepareEvent.mockReset();
	mocks.beginEvent.mockReset();
	mocks.completeEvent.mockReset().mockResolvedValue(true);
	mocks.failEvent.mockReset().mockResolvedValue(true);
	mocks.deferEvent.mockReset().mockResolvedValue(true);
	mocks.readEvent.mockReset();
});

describe("fused control ownership admission", () => {
	const dispatchTask = "media-dispatch-image-kie-nano-banana-2";
	function prepare(assetReview = false, engine: string | null | undefined = "legacy") {
		const row = {
			id: "event",
			eventType: assetReview ? "MEDIA_ASSET_VERIFY" : "GENERATION_DISPATCH",
			aggregateType: assetReview ? "MEDIA_ASSET" : "GENERATION_JOB",
			aggregateId: assetReview ? "asset" : "job",
			payload: assetReview ? { assetId: "asset" } : { jobId: "job", version: 0 },
			attempts: 1,
			dedupeKey: "fused:event",
			leaseOwner: "workflow:workflow-1:event:event",
			leaseToken: "lease",
			leasedUntil: new Date(Date.now() + 90_000),
			availableAt: new Date(0),
			lastError: "EXECUTION_IN_PROGRESS:00000000-0000-4000-8000-000000000000",
		};
		mocks.prepareEvent.mockResolvedValue({ event: row });
		mocks.beginEvent.mockResolvedValue({
			state: "active",
			event: row,
			...(engine === undefined
				? {}
				: {
						engineObservation: {
							aggregateType: row.aggregateType,
							aggregateId: row.aggregateId,
							engine,
						},
					}),
		});
		mocks.resolveDispatchRoute.mockResolvedValue({
			taskId: dispatchTask,
			provider: "kie",
			providerModelId: "nano-banana-2",
		});
		if (assetReview)
			mocks.verify.mockResolvedValueOnce({
				verificationCommit: { assetId: "asset", generation: 1, eventIds: [] },
			});
		return row;
	}

	it.each([false, true])(
		"removes only the redundant engine read for assetReview=%s",
		async (assetReview) => {
			prepare(assetReview);
			const result = await executeTask(
				{ taskId: "media-execute-event", payload: { eventId: "event" } },
				{
					...context,
					workflowId: "workflow-1",
					phaseOwner: { workflowId: "workflow-1", phaseKey: "old-input", epoch: 1 },
				},
			);
			expect(result).toMatchObject({ preparedEvent: null, deliveryState: "completed" });
			expect(mocks.beginEvent).toHaveBeenCalledWith(
				expect.objectContaining({ observeExecutionEngine: true }),
				expect.any(Object),
			);
			expect(mocks.findJob).not.toHaveBeenCalled();
			expect(mocks.findAsset).not.toHaveBeenCalled();
			if (assetReview) {
				expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(
					{ assetId: "asset" },
					mocks.runtime.databaseVerifyUploadDependencies,
					undefined,
					expect.objectContaining({ workflowId: "workflow-1" }),
				);
				expect(mocks.verify.mock.calls[0]![3]).not.toHaveProperty("phaseOwner");
			} else {
				expect(mocks.dispatchStore.claimDispatch).toHaveBeenCalledOnce();
				expect(mocks.runtime.createDatabaseDispatchStore).toHaveBeenCalledWith(
					expect.any(Object),
					expect.objectContaining({ workflowId: "workflow-1", phaseOwner: undefined }),
				);
			}
			expect(mocks.completeEvent).toHaveBeenCalledOnce();
		},
	);

	it.each([null, "video-workflow-v1"])(
		"keeps the outer ownership read for engine %s",
		async (engine) => {
			prepare(false, engine);
			mocks.findJob.mockResolvedValue({ executionEngine: engine ?? "legacy" });
			await executeTask({ taskId: "media-execute-event", payload: { eventId: "event" } }, context);
			expect(mocks.findJob).toHaveBeenCalledExactlyOnceWith({
				where: { id: "job" },
				select: { executionEngine: true },
			});
			if (engine) expect(mocks.dispatchStore.claimDispatch).not.toHaveBeenCalled();
		},
	);

	it("keeps non-fused receipt callers on the original ownership gate", async () => {
		prepare();
		await executeTask(
			{
				taskId: dispatchTask,
				payload: { jobId: "job", version: 0 },
				outboxReceipt: {
					eventId: "event",
					workerId: "workflow:workflow-1:event:event",
					leaseToken: "lease",
				},
			},
			context,
		);
		expect(mocks.beginEvent.mock.calls[0]![0]).not.toHaveProperty("observeExecutionEngine");
		expect(mocks.findJob).toHaveBeenCalledOnce();
	});

	it.each(["completed", "lost", "recovery-required"])(
		"never enters a business handler for a %s fused receipt",
		async (state) => {
			const row = prepare();
			mocks.beginEvent.mockResolvedValue({ state, event: state === "lost" ? null : row });
			const result = executeTask(
				{ taskId: "media-execute-event", payload: { eventId: "event" } },
				context,
			);
			if (state === "recovery-required")
				await expect(result).rejects.toThrow("OUTBOX_RECOVERY_REQUIRED");
			else await expect(result).resolves.toBeDefined();
			expect(mocks.dispatchStore.claimDispatch).not.toHaveBeenCalled();
			expect(mocks.findJob).not.toHaveBeenCalled();
		},
	);
});

describe("Node task executor", () => {
	it("continues the committed finalization retry at its real due time without an event scan", async () => {
		const retryEvent = { id: "committed-transfer-retry", availableAt: 1_800_000_120_000 };
		mocks.finalize.mockResolvedValueOnce({
			outcome: "RETRY_SCHEDULED",
			readyOutputs: 0,
			retryEvent,
			outputReviewEventIds: ["committed-output-review"],
		});
		await expect(
			executeTask(
				{ taskId: "media-finalize-generation", payload: { jobId: "job", version: 0 } },
				context,
			),
		).resolves.toMatchObject({
			outcome: "RETRY_SCHEDULED",
			continuation: {
				eventIds: [retryEvent.id, "committed-output-review"],
				notBefore: retryEvent.availableAt,
			},
		});
		expect(mocks.continuation).not.toHaveBeenCalled();
	});

	it("returns the committed canonical settlement event on the output review completion response", async () => {
		const { getAssetGenerationContinuation } =
			await vi.importActual<typeof import("@repo/database")>("@repo/database");
		const findEvents = vi.fn(
			async (query: { where: { AND: Array<{ dedupeKey?: { in: string[] } }> } }) =>
				query.where.AND[0]?.dedupeKey?.in.includes("generation-settle:job-1")
					? [{ id: "committed-settlement-event" }]
					: [],
		);
		mocks.continuation.mockImplementationOnce(() =>
			getAssetGenerationContinuation("output", {
				mediaAsset: { findUnique: async () => ({ kind: "OUTPUT", verificationGeneration: 1 }) },
				generationJobAsset: { findMany: async () => [{ jobId: "job-1" }] },
				outboxEvent: { findMany: findEvents },
			} as never),
		);
		mocks.verify.mockResolvedValueOnce({ outboxCommitted: true });
		mocks.findAsset.mockResolvedValue({
			verificationEngine: "legacy",
			status: "READY",
			deletedAt: null,
		});
		expect(
			await executeTask({ taskId: "media-verify-upload", payload: { assetId: "output" } }, context),
		).toEqual({
			done: true,
			waitSeconds: 0,
			outboxCommitted: true,
			continuation: { eventIds: ["committed-settlement-event"] },
		});
		expect(findEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					AND: [
						expect.objectContaining({
							aggregateType: "GENERATION_JOB",
							eventType: { in: ["GENERATION_FINALIZE_RETRY", "GENERATION_SETTLE"] },
						}),
						{ status: { in: ["PENDING", "LEASED"] } },
					],
				},
			}),
		);
	});
	it("enables streaming-only dependencies only through the private executor configuration", async () => {
		const task = {
			taskId: "media-finalize-generation",
			payload: { jobId: "job", version: 0, deferOutputReview: true },
		};
		await executeTask(task, context, { streamingTransfersOnly: true });
		expect(mocks.runtime.createFinalizationDependencies).toHaveBeenLastCalledWith(
			expect.anything(),
			{ deferOutputReview: true, streamingTransfersOnly: true },
		);
		await executeTask(task, context);
		expect(mocks.runtime.createFinalizationDependencies).toHaveBeenLastCalledWith(
			expect.anything(),
			{ deferOutputReview: true },
		);
		expect(mocks.finalize).toHaveBeenCalledTimes(2);
	});
	it("preserves original output due time in recovery diagnostics after delivery was deferred", async () => {
		mocks.outboxStore.claimBatch.mockResolvedValue([
			event({
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateId: "asset-1",
				payload: { assetId: "asset-1", originalDueAt: 1000 },
				availableAt: new Date(31000),
			}),
		]);
		await executeTask(
			{ taskId: "media-deliver-output-review", payload: { eventId: "outbox-1" } },
			context,
		);
		expect(mocks.dispatch).toHaveBeenCalledWith(
			"media-verify-upload",
			{ assetId: "asset-1" },
			expect.objectContaining({ trace: { outboxEventId: "outbox-1", dueAt: 1000 } }),
		);
	});
	it("delivers exactly the committed output event with the same completion identity as scanning", async () => {
		const review = event({
			eventType: "MEDIA_ASSET_VERIFY",
			aggregateId: "output",
			payload: { assetId: "output" },
			availableAt: new Date(1000),
		});
		mocks.outboxStore.claimBatch.mockResolvedValue([review]);
		mocks.dispatch.mockRejectedValue(new OutboxDeliveryPendingError());
		await executeTask(
			{ taskId: "media-deliver-output-review", payload: { eventId: review.id } },
			context,
		);
		expect(mocks.outboxStore.claimBatch).toHaveBeenLastCalledWith({
			workerId: `workflow:${context.runId}`,
			limit: 1,
			leaseSeconds: 90,
			outputReviewEventId: review.id,
		});
		expect(mocks.outboxStore.complete).not.toHaveBeenCalled();
		expect(mocks.outboxStore.defer).toHaveBeenCalledOnce();
		await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context);
		expect(mocks.dispatch.mock.calls[0]).toEqual(mocks.dispatch.mock.calls[1]);
		expect(mocks.dispatch.mock.calls[0]).toEqual([
			"media-verify-upload",
			{ assetId: "output" },
			{
				idempotencyKey: "outbox:outbox-1:attempt:1:media-verify-upload",
				requireCompletion: true,
				trace: { outboxEventId: "outbox-1", dueAt: 1000 },
			},
		]);
	});
	it.each([
		"media-cancel-generation",
		"media-finalize-generation",
		"media-settle-generation",
		STATIC_DISPATCH_ROUTE_MANIFEST[0]!.taskId,
	])("refuses video ownership before any side effect through %s", async (taskId) => {
		mocks.findJob.mockResolvedValue({ executionEngine: "video-workflow-v1" });
		await expect(
			executeTask({ taskId, payload: { jobId: "video-1", version: 0 } }, context),
		).resolves.toMatchObject({ outcome: "NOT_MANAGED", executionEngine: "video-workflow-v1" });
		expect(mocks.runtime.createProviderRegistry).not.toHaveBeenCalled();
		expect(mocks.runtime.createFinalizationDependencies).not.toHaveBeenCalled();
		expect(mocks.dispatchStore.claimDispatch).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
	it.each(["media-verify-upload", "media-delete-object"])(
		"refuses video assets through %s",
		async (taskId) => {
			mocks.findAsset.mockResolvedValue({ verificationEngine: "video-workflow-v1" });
			await expect(
				executeTask(
					{
						taskId,
						payload: {
							assetId: "video-asset",
							...(taskId === "media-delete-object" ? { objectKey: "private/video" } : {}),
						},
					},
					context,
				),
			).resolves.toMatchObject({ outcome: "NOT_MANAGED" });
			expect(mocks.verify).not.toHaveBeenCalled();
			expect(mocks.cleanup).not.toHaveBeenCalled();
		},
	);
	it("does not send a foreign attempt to legacy polling or a callback provider registry", async () => {
		mocks.findAttempt.mockResolvedValue({ job: { executionEngine: "video-workflow-v1" } });
		mocks.findProviderEvent.mockResolvedValue({ provider: "kie", providerTaskId: "task-1" });
		for (const request of [
			{ taskId: "media-poll-generation", payload: { attemptId: "attempt-1" } },
			{ taskId: "media-process-provider-webhook", payload: { providerWebhookEventId: "event-1" } },
		]) {
			await expect(executeTask(request, context)).resolves.toMatchObject({
				outcome: "NOT_MANAGED",
			});
		}
		expect(mocks.runtime.createProviderRegistry).not.toHaveBeenCalled();
		expect(mocks.reconciliationStore.claimStale).not.toHaveBeenCalled();
	});
	it.each([
		{ provider: "kie-video-v1", providerEventId: "callback" },
		{ provider: "kie", providerEventId: "video-v1:callback" },
	])("refuses the video callback namespace even before attempt matching: %j", async (identity) => {
		mocks.findProviderEvent.mockResolvedValue({ ...identity, providerTaskId: null });
		await expect(
			executeTask(
				{
					taskId: "media-process-provider-webhook",
					payload: { providerWebhookEventId: "video-event" },
				},
				context,
			),
		).resolves.toMatchObject({ outcome: "NOT_MANAGED" });
		expect(mocks.runtime.createProviderRegistry).not.toHaveBeenCalled();
	});
	it("fails closed for an unknown future engine", async () => {
		mocks.findJob.mockResolvedValue({ executionEngine: "video-workflow-v2" });
		await expect(
			executeTask(
				{
					taskId: "media-settle-generation",
					payload: { jobId: "future-job", version: 0 },
				},
				context,
			),
		).resolves.toMatchObject({ outcome: "NOT_MANAGED", executionEngine: "video-workflow-v2" });
	});
	it("does not dispatch a stale legacy Outbox event for a video job", async () => {
		mocks.findJob.mockResolvedValue({ executionEngine: "video-workflow-v1" });
		mocks.outboxStore.claimBatch.mockResolvedValue([
			event({
				eventType: "GENERATION_SETTLE",
				aggregateId: "video-1",
				payload: { version: 0 },
			}),
		]);
		await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
	it.each([true, false])(
		"returns the committed Outbox signal %s rather than inferring it from READY",
		async (outboxCommitted) => {
			mocks.verify.mockResolvedValueOnce({ outboxCommitted });
			mocks.findAsset.mockResolvedValueOnce({ status: "READY", deletedAt: null });
			expect(
				await executeTask(
					{ taskId: "media-verify-upload", payload: { assetId: "output" } },
					context,
				),
			).toEqual({ done: true, waitSeconds: 0, outboxCommitted, continuation: { eventIds: [] } });
		},
	);
	it("checks execution ownership without duplicating the execution boundary start log", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = new Date("2026-09-29T00:00:05Z");
		try {
			await executeTask(
				{
					taskId: "media-verify-upload",
					payload: { assetId: "asset-1" },
					trace: { outboxEventId: "event-1", dueAt: now.getTime() - 2_500, requestId: "request-1" },
				},
				context,
				{ now: () => now },
			);
			expect(info).not.toHaveBeenCalled();
			expect(mocks.findAsset).toHaveBeenCalledTimes(2);
			expect(mocks.findAsset).toHaveBeenNthCalledWith(1, {
				where: { id: "asset-1" },
				select: { verificationEngine: true },
			});
		} finally {
			info.mockRestore();
		}
	});
	it("records a single start for inline Outbox children that bypass the HTTP boundary", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const now = new Date("2026-09-30T00:00:05Z");
		mocks.outboxStore.claimBatch.mockResolvedValue([
			event({ availableAt: new Date(now.getTime() - 2_500) }),
		]);
		try {
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				now: () => now,
				assertInlineTask: assertWorkerInlineTask,
			});
			expect(info).toHaveBeenCalledExactlyOnceWith(
				"media.task.started",
				expect.objectContaining({
					taskId: "media-delete-object",
					assetId: "asset-1",
					outboxEventId: "outbox-1",
					startedAt: now.getTime(),
					dueToStartMs: 2_500,
				}),
			);
			expect(JSON.stringify(info.mock.calls)).not.toContain("private/object");
		} finally {
			info.mockRestore();
		}
	});
	it.each(["READY", "QUARANTINED"])(
		"uses an authoritative %s commit without rereading its asset or continuation",
		async (status) => {
			mocks.findAsset.mockResolvedValue({ verificationEngine: "legacy" });
			mocks.verify.mockResolvedValueOnce({
				outboxCommitted: true,
				verificationCommit: {
					assetId: "output",
					generation: 1,
					status,
					eventIds: ["committed-event"],
				},
			});
			expect(
				await executeTask(
					{ taskId: "media-verify-upload", payload: { assetId: "output" } },
					context,
				),
			).toEqual({
				done: true,
				waitSeconds: 0,
				outboxCommitted: true,
				continuation: { eventIds: ["committed-event"] },
			});
			// The existing execution-engine admission read stays in place.
			expect(mocks.findAsset).toHaveBeenCalledExactlyOnceWith({
				where: { id: "output" },
				select: { verificationEngine: true },
			});
			expect(mocks.continuation).not.toHaveBeenCalled();
		},
	);

	it.each(["READY", "QUARANTINED", "VERIFICATION_FAILED", "DELETED"])(
		"uses a validated query-only %s observation without another authority read",
		async (status) => {
			mocks.findAsset.mockResolvedValue({ verificationEngine: "legacy" });
			mocks.verify.mockResolvedValueOnce({
				outboxCommitted: false,
				verificationObservation: { assetId: "output", generation: 3, status, eventIds: [] },
			});
			expect(
				await executeTask(
					{ taskId: "media-verify-upload", payload: { assetId: "output", queryOnly: true } },
					context,
				),
			).toEqual({
				done: true,
				waitSeconds: 0,
				outboxCommitted: false,
				continuation: { eventIds: [] },
			});
			expect(mocks.findAsset).toHaveBeenCalledOnce();
			expect(mocks.continuation).not.toHaveBeenCalled();
		},
	);

	it("does not accept a terminal observation as a new paid verification receipt", async () => {
		mocks.findAsset.mockResolvedValue({ verificationEngine: "legacy" });
		mocks.verify.mockResolvedValueOnce({
			outboxCommitted: false,
			verificationObservation: { assetId: "output", generation: 3, status: "READY", eventIds: [] },
		});
		await expect(
			executeTask({ taskId: "media-verify-upload", payload: { assetId: "output" } }, context),
		).rejects.toThrow("INVALID_VERIFICATION_TERMINAL_OBSERVATION");
	});

	it("passes only the existing admission query's DB projection to a query-only verification", async () => {
		const asset = { id: "output", verificationEngine: "legacy", status: "VERIFYING" };
		mocks.findAsset.mockResolvedValue(asset);
		mocks.verify.mockResolvedValueOnce({
			outboxCommitted: false,
			verificationObservation: { assetId: "output", generation: 1, status: "READY", eventIds: [] },
		});
		await executeTask(
			{ taskId: "media-verify-upload", payload: { assetId: "output", queryOnly: true } },
			context,
		);
		expect(mocks.findAsset).toHaveBeenCalledOnce();
		expect(mocks.findAsset).toHaveBeenCalledWith({
			where: { id: "output" },
			select: expect.objectContaining({
				verificationEngine: true,
				verificationGeneration: true,
				updatedAt: true,
				verificationSubmissionUncertain: true,
			}),
		});
		expect(mocks.findAsset.mock.calls[0]![0].select).not.toHaveProperty("objectKey");
		expect(mocks.verify).toHaveBeenCalledWith(
			{ assetId: "output", queryOnly: true },
			mocks.runtime.databaseVerifyUploadDependencies,
			{ asset },
		);
	});

	it("rejects a caller-supplied admission observation before any database or verification access", async () => {
		await expect(
			executeTask(
				{
					taskId: "media-verify-upload",
					payload: {
						assetId: "output",
						queryOnly: true,
						admission: { asset: { status: "READY", verificationEngine: "legacy" } },
					},
				},
				context,
			),
		).rejects.toThrow();
		expect(mocks.findAsset).not.toHaveBeenCalled();
		expect(mocks.verify).not.toHaveBeenCalled();
	});

	it("returns the persisted moderation due time for durable polling instead of waiting for cron", async () => {
		const now = new Date("2026-09-19T06:00:00Z");
		mocks.findAsset.mockResolvedValue({
			status: "VERIFYING",
			deletedAt: null,
			verificationNextAttemptAt: new Date(now.getTime() + 3_000),
			verificationLeasedUntil: null,
		});
		expect(
			await executeTask(
				{ taskId: "media-verify-upload", payload: { assetId: "output" } },
				context,
				{ now: () => now },
			),
		).toEqual({ done: false, waitSeconds: 3, continuation: { eventIds: [] } });
		mocks.findAsset.mockResolvedValue({ status: "READY", deletedAt: null });
		expect(
			await executeTask({ taskId: "media-verify-upload", payload: { assetId: "output" } }, context),
		).toEqual({ done: true, waitSeconds: 0, continuation: { eventIds: [] } });
	});
	it("immediately continues a committed bound image query when a callback became due during retrieval", async () => {
		const now = new Date("2026-10-22T00:00:00Z");
		mocks.verify.mockResolvedValueOnce({ outboxCommitted: false, queryOnly: true });
		mocks.findAsset.mockResolvedValue({
			status: "VERIFYING",
			deletedAt: null,
			verificationNextAttemptAt: now,
			verificationLeasedUntil: null,
			verificationProviderTaskId: "bound-review",
			verificationSubmissionUncertain: false,
		});
		expect(
			await executeTask(
				{ taskId: "media-verify-upload", payload: { assetId: "output", queryOnly: true } },
				context,
				{ now: () => now },
			),
		).toEqual({
			done: false,
			waitSeconds: 0,
			retryImmediately: true,
			queryOnly: true,
			outboxCommitted: false,
			continuation: { eventIds: [] },
		});
	});
	it.each([
		["unclaimed work", { outboxCommitted: false }, {}, 1],
		[
			"missing task",
			{ outboxCommitted: false, queryOnly: true },
			{ verificationProviderTaskId: null },
			1,
		],
		[
			"uncertain task",
			{ outboxCommitted: false, queryOnly: true },
			{ verificationSubmissionUncertain: true },
			1,
		],
		[
			"active lease",
			{ outboxCommitted: false, queryOnly: true },
			{ verificationLeasedUntil: new Date("2026-10-22T00:01:00Z") },
			60,
		],
		[
			"future due",
			{ outboxCommitted: false, queryOnly: true },
			{ verificationNextAttemptAt: new Date("2026-10-22T00:00:03Z") },
			3,
		],
		[
			"missing due",
			{ outboxCommitted: false, queryOnly: true },
			{ verificationNextAttemptAt: null },
			5,
		],
	] as const)("does not immediately retry %s", async (_label, progress, asset, waitSeconds) => {
		const now = new Date("2026-10-22T00:00:00Z");
		mocks.verify.mockResolvedValueOnce(progress);
		mocks.findAsset.mockResolvedValue({
			status: "VERIFYING",
			deletedAt: null,
			verificationNextAttemptAt: now,
			verificationLeasedUntil: null,
			verificationProviderTaskId: "bound-review",
			verificationSubmissionUncertain: false,
			...asset,
		});
		const result = await executeTask(
			{ taskId: "media-verify-upload", payload: { assetId: "output", queryOnly: true } },
			context,
			{ now: () => now },
		);
		expect(result).toMatchObject({ done: false, waitSeconds });
		expect(result).not.toHaveProperty("retryImmediately");
	});

	it("keeps payment recovery failures independent from durable Outbox delivery", async () => {
		mocks.recoverPayments.mockRejectedValueOnce(
			new Error("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE"),
		);
		expect(await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context)).toEqual({
			claimed: 0,
			delivered: 0,
		});
		expect(mocks.recoverPayments).not.toHaveBeenCalled();
		await expect(
			executeTask({ taskId: "media-recover-payment-events", payload: {} }, context),
		).rejects.toThrow("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE");
		mocks.recoverPayments.mockResolvedValueOnce({ recovered: 2 });
		expect(
			await executeTask({ taskId: "media-recover-payment-events", payload: {} }, context),
		).toEqual({ recovered: 2 });
		expect(mocks.recoverPayments).toHaveBeenCalledWith({ limit: 25 }, expect.anything());
	});

	it("recovers bounded stale finalizations through the canonical durable store", async () => {
		mocks.finalizationStore.listCandidates.mockResolvedValue([
			{ jobId: "job-1" },
			{ jobId: "job-2" },
		]);
		mocks.finalizationStore.recoverCandidate
			.mockResolvedValueOnce("RECOVERED")
			.mockResolvedValueOnce("SKIPPED");
		expect(
			await executeTask({ taskId: "media-recover-finalizing-generations", payload: {} }, context),
		).toEqual({ scanned: 2, recovered: 1, skipped: 1, exhausted: 0, failed: 0 });
		expect(mocks.finalizationRecovery).toHaveBeenCalledWith(expect.anything());
		expect(mocks.finalizationStore.listCandidates).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 25 }),
		);
		expect(mocks.finalizationStore.recoverCandidate).toHaveBeenCalledTimes(2);
	});

	it("freezes a due attempt when its recovery adapter is unavailable instead of resubmitting", async () => {
		const lease = {
			jobId: "job-1",
			version: 1,
			attemptId: "attempt-1",
			provider: "replicate",
			providerTaskId: "remote-1",
			leaseToken: "lease-1",
			staleAgeMinutes: 30,
			repairCount: 1,
		};
		mocks.reconciliationStore.claimStale.mockResolvedValue([lease]);
		mocks.runtime.getAnyRegisteredProvider.mockImplementationOnce(() => {
			throw new Error("PROVIDER_NOT_REGISTERED");
		});
		const environment = {
			NODE_ENV: "production",
			MEDIA_ENABLED_PROVIDERS: "",
			MEDIA_RECOVERY_PROVIDERS: "replicate",
			REPLICATE_API_TOKEN: "",
		};
		expect(
			await executeTask({ taskId: "media-reconcile-generations", payload: {} }, context, {
				environment,
			}),
		).toEqual({ claimed: 1, reconciled: 0, outboxCommitted: false });
		expect(mocks.runtime.createReconciliationProviderRegistry).toHaveBeenCalledWith(environment);
		expect(mocks.reconciliationStore.markUncertainForManualReconciliation).toHaveBeenCalledWith(
			lease,
			"PROVIDER_RECOVERY_UNAVAILABLE",
		);
		expect(mocks.reconciliationStore.releaseReconciliationLease).not.toHaveBeenCalled();
		expect(mocks.reconciliationStore.recordReconciled).not.toHaveBeenCalled();
		expect(mocks.adapter.submit).not.toHaveBeenCalled();
	});

	it("starts scheduled subscription reconciliation at sequence zero", async () => {
		await executeTask({ taskId: "media-reconcile-subscriptions", payload: {} }, context);
		expect(mocks.subscriptions).toHaveBeenCalledWith({
			limit: 100,
			continuationSequence: 0,
			scheduleContinuation: expect.any(Function),
			scheduleProviderReconciliation: expect.any(Function),
		});
		await mocks.subscriptions.mock.calls[0]![0].scheduleProviderReconciliation(
			"paypal",
			"persisted-provider-cursor",
		);
		expect(mocks.dispatch).toHaveBeenCalledWith(
			"media-reconcile-provider-payments",
			{ provider: "paypal" },
			{ idempotencyKey: "persisted-provider-cursor" },
		);
	});

	it("rejects unregistered work and invalid attempt context before touching domain handlers", async () => {
		await expect(executeTask({ taskId: "unknown", payload: {} }, context)).rejects.toThrow();
		await expect(
			executeTask(
				{ taskId: "media-process-payment-event", payload: { paymentEventId: "payment-1" } },
				{ ...context, attempt: 0 },
			),
		).rejects.toThrow();
		expect(mocks.payment).not.toHaveBeenCalled();
	});

	it("preserves historical and text-image dispatch identities and lets the DB authorize submission", async () => {
		expect(STATIC_DISPATCH_ROUTE_MANIFEST.map((route) => route.taskId).sort()).toEqual(
			[
				"media-dispatch-image-replicate-black-forest-labs_flux-schnell",
				"media-dispatch-image-fal-fal-ai_flux-schnell",
				"media-dispatch-image-gemini-gemini-2.5-flash-image",
				"media-dispatch-image-openrouter-sourceful_riverflow-v2.5-fast",
				"media-dispatch-image-openrouter-sourceful_riverflow-v2.5-pro",
				"media-dispatch-image-kie-nano-banana-2-lite",
				"media-dispatch-image-kie-google_nano-banana-edit",
				"media-dispatch-image-kie-nano-banana-2",
				"media-dispatch-image-kie-nano-banana-pro",
				"media-dispatch-image-kie-gpt-image_1.5-image-to-image",
				"media-dispatch-image-kie-gpt-image-2-image-to-image",
				"media-dispatch-image-kie-gpt-image-2-5-flare-image-to-image",
				"media-dispatch-image-kie-gpt-image-2-5-sunburst-image-to-image",
				"media-dispatch-image-kie-bytedance_seedream-v4-edit",
				"media-dispatch-image-kie-seedream_4.5-edit",
				"media-dispatch-image-kie-seedream_5-lite-image-to-image",
				"media-dispatch-image-kie-seedream_5-pro-image-to-image",
				"media-dispatch-video-fal-fal-ai_fast-video",
				"media-dispatch-video-kie-veo3",
				"media-dispatch-image-kie-google_nano-banana",
				"media-dispatch-image-kie-gpt-image_1.5-text-to-image",
				"media-dispatch-image-kie-gpt-image-2-text-to-image",
				"media-dispatch-image-kie-gpt-image-2-5-flare-text-to-image",
				"media-dispatch-image-kie-gpt-image-2-5-sunburst-text-to-image",
				"media-dispatch-image-kie-bytedance_seedream-v4-text-to-image",
				"media-dispatch-image-kie-seedream_4.5-text-to-image",
				"media-dispatch-image-kie-seedream_5-lite-text-to-image",
				"media-dispatch-image-kie-seedream_5-pro-text-to-image",
			].sort(),
		);
		for (const route of STATIC_DISPATCH_ROUTE_MANIFEST) {
			expect(
				await executeTask(
					{ taskId: route.taskId, payload: { jobId: "job-1", version: 0 } },
					context,
				),
			).toEqual({ outcome: "SKIPPED", continuation: { eventIds: [] } });
			expect(mocks.dispatchStore.claimDispatch).toHaveBeenLastCalledWith({
				jobId: "job-1",
				version: 0,
				provider: route.provider,
				providerModelId: route.providerModelId,
			});
		}
		const storeOptions = (mocks.runtime.createDatabaseDispatchStore.mock.calls as unknown[][]).at(
			-1,
		)?.[1] as { enabledProviders: Set<string>; environment: unknown } | undefined;
		expect(storeOptions?.enabledProviders).toEqual(new Set(["kie"]));
		expect(storeOptions?.environment === process.env).toBe(true);
	});

	it("passes injected capacity configuration to the store and preserves its durable queue continuation", async () => {
		const environment = { MEDIA_GENERATION_ENABLED: "true", VIDEO_V1_PROVIDER_CONCURRENCY: "3" };
		const continuation = { eventIds: ["queue-retry"], notBefore: 1_800_000_000_000 };
		mocks.dispatchStore.claimDispatch.mockResolvedValueOnce({
			deferred: true,
			retryAfterMs: 5_000,
			continuation,
		});
		expect(
			await executeTask(
				{
					taskId: "media-dispatch-image-kie-nano-banana-2-lite",
					payload: { jobId: "queued-job", version: 4 },
				},
				context,
				{ environment },
			),
		).toEqual({ outcome: "DEFERRED", retryAfterMs: 5_000, continuation });
		const storeOptions = (mocks.runtime.createDatabaseDispatchStore.mock.calls as unknown[][]).at(
			-1,
		)?.[1] as { environment: unknown } | undefined;
		expect(storeOptions?.environment === environment).toBe(true);
		expect(mocks.continuation).not.toHaveBeenCalled();
		expect(mocks.adapter.submit).not.toHaveBeenCalled();
	});

	it("maps the Workflow retry identity to the historical payment attempt field", async () => {
		await executeTask(
			{ taskId: "media-process-payment-event", payload: { paymentEventId: "payment-1" } },
			context,
		);
		expect(mocks.payment).toHaveBeenCalledExactlyOnceWith(
			{ paymentEventId: "payment-1" },
			{ attempt: 2, maxAttempts: 8, triggerRunId: "workflow-1" },
		);
	});

	it.each([
		{ continuation: { eventIds: [], pollAttemptId: "attempt-1" }, synchronous: false },
		{ continuation: { eventIds: ["committed-finalize-1"] }, synchronous: true },
		{ continuation: { eventIds: [] }, synchronous: true },
		{ continuation: undefined, synchronous: false },
	])(
		"uses committed continuation and keeps legacy void fallback (%j)",
		async ({ continuation, synchronous }) => {
			mocks.dispatchStore.claimDispatch.mockResolvedValue({
				attemptId: "attempt-1",
				attemptNumber: 1,
				serviceClass: "STANDARD",
				provider: "kie",
				providerModelId: "nano-banana-2",
				input: { kind: "text-to-image", prompt: "sample", aspectRatio: "1:1" },
				mediaKind: "image",
				queueKey: "kie:nano-banana-2",
			});
			mocks.adapter.submit.mockResolvedValue({
				outcome: "accepted",
				status: synchronous ? "SUCCEEDED" : "RUNNING",
				providerTaskId: "remote-1",
				idempotency: { providerSupported: false, replayed: false },
				reconciliation: { submissionToken: "token-1" },
				...(synchronous
					? { snapshot: { providerTaskId: "remote-1", status: "SUCCEEDED", raw: {} } }
					: {}),
			});
			mocks.adapter.normalizeResult.mockResolvedValue({ outputs: [] });
			const record = synchronous
				? mocks.dispatchStore.recordSynchronousCompletion
				: mocks.dispatchStore.recordSubmission;
			record.mockResolvedValueOnce(continuation);
			const expected = continuation ?? { eventIds: [], pollAttemptId: "attempt-1" };
			mocks.continuation.mockResolvedValueOnce(expected);
			expect(
				await executeTask(
					{
						taskId: "media-dispatch-image-kie-nano-banana-2",
						payload: { jobId: "job-1", version: 0 },
					},
					context,
					{ now: () => new Date(1_200_000) },
				),
			).toEqual({ outcome: "SUBMITTED", continuation: expected });
			expect(mocks.continuation).toHaveBeenCalledTimes(continuation === undefined ? 1 : 0);
			expect(mocks.dispatch).not.toHaveBeenCalled();
			expect(record).toHaveBeenCalledTimes(1);
			expect(mocks.dispatchStore.recordUncertainSubmission).not.toHaveBeenCalled();
			expect(mocks.adapter.submit).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps the compatibility continuation query for a skipped dispatch", async () => {
		mocks.continuation.mockResolvedValueOnce({ eventIds: ["recovery-event"] });
		await expect(
			executeTask(
				{
					taskId: "media-dispatch-image-kie-nano-banana-2",
					payload: { jobId: "job-1", version: 0 },
				},
				context,
			),
		).resolves.toEqual({ outcome: "SKIPPED", continuation: { eventIds: ["recovery-event"] } });
		expect(mocks.continuation).toHaveBeenCalledExactlyOnceWith("job-1", expect.anything());
	});

	it("returns every committed callback continuation after ACK without executing its heavy children inline", async () => {
		const first = { eventIds: Array.from({ length: 100 }, (_, index) => `first-${index}`) };
		const second = { eventIds: Array.from({ length: 100 }, (_, index) => `second-${index}`) };
		const polling = {
			eventIds: [],
			pollAttemptId: "accepted-attempt",
			phaseOwner: { workflowId: "image-workflow", phaseKey: "provider-phase", epoch: 2 },
		};
		const delayed = { eventIds: ["committed-settlement"], notBefore: 1_800_000_000_500 };
		const continuations = [first, second, polling, delayed];
		for (const continuation of continuations)
			mocks.continuation.mockResolvedValueOnce(continuation);
		const events = continuations.map((_, index) =>
			event({
				id: `callback-${index}`,
				eventType: "PROVIDER_EVENT_RECEIVED",
				payload: { providerWebhookEventId: `provider-${index}` },
			}),
		);
		mocks.outboxStore.claimBatch.mockResolvedValueOnce(events);
		expect(
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				assertInlineTask: assertWorkerInlineTask,
			}),
		).toEqual({ claimed: 4, delivered: 4, continuations });
		expect(mocks.providerEvent).toHaveBeenCalledTimes(4);
		expect(mocks.outboxStore.complete).toHaveBeenCalledTimes(4);
		expect(mocks.outboxStore.claimBatch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ limit: 50 }),
		);
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.adapter.submit).not.toHaveBeenCalled();
	});

	it("does not forward a callback continuation when its Outbox ACK fails", async () => {
		mocks.outboxStore.claimBatch.mockResolvedValueOnce([
			event({
				eventType: "PROVIDER_EVENT_RECEIVED",
				payload: { providerWebhookEventId: "provider-event" },
			}),
		]);
		mocks.continuation.mockResolvedValueOnce({ eventIds: ["committed-finalize"] });
		mocks.outboxStore.complete.mockRejectedValueOnce(new Error("database unavailable"));
		expect(
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				assertInlineTask: assertWorkerInlineTask,
			}),
		).toEqual({ claimed: 1, delivered: 0 });
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("keeps a held inline callback unacknowledged without querying or forwarding a continuation", async () => {
		mocks.outboxStore.claimBatch.mockResolvedValueOnce([
			event({
				eventType: "PROVIDER_EVENT_RECEIVED",
				attempts: 11,
				payload: { providerWebhookEventId: "provider-event" },
			}),
		]);
		mocks.providerEvent.mockRejectedValueOnce(new ProviderEventPhaseHeldError(123_456));
		expect(
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				assertInlineTask: assertWorkerInlineTask,
				now: () => new Date(1_800_000_000_000),
			}),
		).toEqual({ claimed: 1, delivered: 0 });
		expect(mocks.outboxStore.defer).toHaveBeenCalledExactlyOnceWith({
			id: "outbox-1",
			workerId: "workflow:workflow-1",
			leaseToken: "lease-1",
			retryAt: new Date(1_800_000_123_456),
		});
		expect(mocks.outboxStore.complete).not.toHaveBeenCalled();
		expect(mocks.outboxStore.release).not.toHaveBeenCalled();
		expect(mocks.continuation).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("runs critical Outbox delivery inline and acknowledges only after completion", async () => {
		let finish: () => void = () => {
			throw new Error("cleanup was not started");
		};
		let started: () => void = () => undefined;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		mocks.cleanup.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
					started();
				}),
		);
		mocks.outboxStore.claimBatch.mockResolvedValue([event()]);
		const execution = executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
			assertInlineTask: assertWorkerInlineTask,
		});
		await didStart;
		expect(mocks.outboxStore.complete).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
		finish();
		expect(await execution).toEqual({ claimed: 1, delivered: 1 });
		expect(mocks.outboxStore.complete).toHaveBeenCalledWith(
			"outbox-1",
			expect.stringContaining("workflow-1"),
			"lease-1",
		);
	});

	it("leaves the Outbox recoverable if inline execution is not admitted", async () => {
		mocks.outboxStore.claimBatch.mockResolvedValue([event()]);
		const assertInlineTask = vi.fn(() => {
			throw new Error("CROSS_EXECUTOR_INLINE_TASK");
		});
		expect(
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				assertInlineTask,
			}),
		).toEqual({ claimed: 1, delivered: 0 });
		expect(assertInlineTask).toHaveBeenCalledOnce();
		expect(mocks.cleanup).not.toHaveBeenCalled();
		expect(mocks.outboxStore.complete).not.toHaveBeenCalled();
		expect(mocks.outboxStore.release).toHaveBeenCalledWith(
			expect.objectContaining({ id: "outbox-1", leaseToken: "lease-1" }),
		);
	});

	it("releases failed cleanup without ACK and awaits cancellation and guest admission", async () => {
		mocks.cleanup.mockRejectedValueOnce(new Error("storage unavailable"));
		mocks.outboxStore.claimBatch.mockResolvedValue([
			event(),
			event({
				id: "cancel-1",
				eventType: "GENERATION_CANCEL_REQUESTED",
				aggregateId: "job-1",
				payload: { version: 1 },
			}),
			event({
				id: "guest-1",
				eventType: "GUEST_GENERATION_ELIGIBLE",
				aggregateId: "job-2",
				payload: { trialId: "trial-1" },
			}),
		]);
		expect(
			await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context, {
				assertInlineTask: assertWorkerInlineTask,
			}),
		).toEqual({
			claimed: 3,
			delivered: 2,
		});
		expect(mocks.outboxStore.release).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "outbox-1",
				leaseToken: "lease-1",
				errorCode: "DELIVERY_FAILED",
			}),
		);
		expect(mocks.outboxStore.complete).not.toHaveBeenCalledWith(
			"outbox-1",
			expect.anything(),
			expect.anything(),
		);
		expect(mocks.cancel).toHaveBeenCalledWith({ jobId: "job-1", version: 1 }, expect.anything());
		expect(mocks.admit).toHaveBeenCalledWith(
			{ jobId: "job-2", trialId: "trial-1" },
			expect.anything(),
		);
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});

	it("uses the logical attempt for async delivery and requires a completion receipt", async () => {
		const paymentEvent = event({
			eventType: "PAYMENT_EVENT_RECEIVED",
			payload: { paymentEventId: "payment-1" },
		});
		mocks.outboxStore.claimBatch
			.mockResolvedValueOnce([paymentEvent])
			.mockResolvedValueOnce([{ ...paymentEvent, leaseToken: "lease-2", attempts: 2 }]);
		await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context);
		await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context);
		expect(mocks.dispatch.mock.calls).toEqual([
			[
				"media-process-payment-event",
				{ paymentEventId: "payment-1" },
				{
					idempotencyKey: "outbox:outbox-1:attempt:1:media-process-payment-event",
					requireCompletion: true,
				},
			],
			[
				"media-process-payment-event",
				{ paymentEventId: "payment-1" },
				{
					idempotencyKey: "outbox:outbox-1:attempt:2:media-process-payment-event",
					requireCompletion: true,
				},
			],
		]);
	});

	it.each(["PAYMENT_EVENT_RECEIVED", "JOB_CREATED"])(
		"keeps %s pending through capacity/startup waits and retries failed execution before ACK",
		async (eventType) => {
			const childTaskId =
				eventType === "JOB_CREATED"
					? "media-dispatch-image-kie-nano-banana-2"
					: "media-process-payment-event";
			mocks.resolveDispatchRoute.mockResolvedValue({
				taskId: childTaskId,
				provider: "kie",
				providerModelId: "nano-banana-2",
			});
			const first = event({
				eventType,
				aggregateId: eventType === "JOB_CREATED" ? "job-1" : "payment-1",
				payload: eventType === "JOB_CREATED" ? { version: 1 } : { paymentEventId: "payment-1" },
			});
			mocks.outboxStore.claimBatch
				.mockResolvedValueOnce([first])
				.mockResolvedValueOnce([{ ...first, leaseToken: "lease-2" }])
				.mockResolvedValueOnce([{ ...first, leaseToken: "lease-3" }])
				.mockResolvedValueOnce([{ ...first, leaseToken: "lease-4", attempts: 2 }]);
			mocks.dispatch
				.mockRejectedValueOnce(new OutboxDeliveryPendingError())
				.mockRejectedValueOnce(new OutboxDeliveryPendingError())
				.mockRejectedValueOnce(new Error("WORKFLOWS_DISPATCH_REJECTED"))
				.mockResolvedValueOnce(undefined);
			for (let poll = 0; poll < 3; poll += 1) {
				expect(await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context)).toEqual(
					{ claimed: 1, delivered: 0 },
				);
				expect(mocks.outboxStore.complete).not.toHaveBeenCalled();
			}
			expect(await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context)).toEqual({
				claimed: 1,
				delivered: 1,
			});
			expect(mocks.dispatch.mock.calls.map((call) => call[2])).toEqual([
				{ idempotencyKey: `outbox:outbox-1:attempt:1:${childTaskId}`, requireCompletion: true },
				{ idempotencyKey: `outbox:outbox-1:attempt:1:${childTaskId}`, requireCompletion: true },
				{ idempotencyKey: `outbox:outbox-1:attempt:1:${childTaskId}`, requireCompletion: true },
				{ idempotencyKey: `outbox:outbox-1:attempt:2:${childTaskId}`, requireCompletion: true },
			]);
			expect(mocks.outboxStore.defer).toHaveBeenCalledTimes(2);
			expect(mocks.outboxStore.release).toHaveBeenCalledTimes(1);
			expect(mocks.outboxStore.complete).toHaveBeenCalledExactlyOnceWith(
				"outbox-1",
				"workflow:workflow-1",
				"lease-4",
			);
		},
	);

	it("preserves quarantine opt-in and guest operational safety with scheduled time", async () => {
		await executeTask(
			{
				taskId: "media-verify-upload",
				payload: { assetId: "asset-1", allowQuarantinedReverification: true },
			},
			context,
		);
		expect(mocks.verify).toHaveBeenCalledWith(
			{ assetId: "asset-1", allowQuarantinedReverification: true },
			mocks.runtime.databaseVerifyUploadDependencies,
		);
		const timestamp = Date.UTC(2026, 8, 8, 14, 0);
		await executeTask({ taskId: "media-expire-guest-media", payload: { timestamp } }, context, {
			environment: {
				GUEST_MEDIA_ENABLED: "true",
				GUEST_PROMOTION_PERIOD: "launch",
				GUEST_RISK_BUDGET_MICROS: "12345",
			},
		});
		expect(mocks.expireGuest).toHaveBeenCalledWith(
			{ now: new Date(timestamp), limit: 100 },
			mocks.runtime.databaseGuestMediaExpiryDependencies,
		);
		expect(mocks.monitorGuest).toHaveBeenCalledWith(expect.anything(), {
			guestEnvironmentEnabled: true,
			guestPromotionPeriod: "launch",
			guestRiskBudgetMicros: 12345n,
			now: new Date(timestamp),
		});
	});
	it("finishes the verification workflow for a retired moderation hold", async () => {
		mocks.findAsset.mockResolvedValue({
			verificationEngine: "legacy",
			status: "VERIFYING",
			deletedAt: null,
			verificationNextAttemptAt: null,
			verificationLeasedUntil: null,
			verificationLastErrorCode: "MODERATION_PROVIDER_RETIRED",
		});
		expect(
			await executeTask(
				{ taskId: "media-verify-upload", payload: { assetId: "retired" } },
				context,
			),
		).toMatchObject({ done: true, waitSeconds: 0 });
	});

	it("passes an explicit unlimited budget through scheduled safety monitoring", async () => {
		const timestamp = Date.UTC(2026, 8, 21, 12, 0);
		await executeTask({ taskId: "media-expire-guest-media", payload: { timestamp } }, context, {
			environment: {
				GUEST_MEDIA_ENABLED: "true",
				GUEST_PROMOTION_PERIOD: "launch",
				GUEST_RISK_BUDGET_MICROS: "unlimited",
				GUEST_HARD_BUDGET_MICROS: "unlimited",
			},
		});
		expect(mocks.monitorGuest).toHaveBeenCalledWith(expect.anything(), {
			guestEnvironmentEnabled: true,
			guestPromotionPeriod: "launch",
			guestRiskBudgetMicros: null,
			now: new Date(timestamp),
		});
	});

	it("resumes subscription sweeps using their persisted sequence and continuation key", async () => {
		await executeTask(
			{
				taskId: "media-reconcile-subscriptions-continuation",
				payload: { sweepId: "sweep-1", sequence: 4, continuationKey: "continuation-4" },
			},
			context,
		);
		expect(mocks.subscriptions).toHaveBeenCalledWith({
			limit: 100,
			expectedSweepId: "sweep-1",
			continuationSequence: 4,
			scheduleContinuation: expect.any(Function),
			scheduleProviderReconciliation: expect.any(Function),
		});
		const schedule = mocks.subscriptions.mock.calls[0]![0].scheduleContinuation as (input: {
			sweepId: string;
			sequence: number;
			continuationKey: string;
		}) => Promise<void>;
		await schedule({ sweepId: "sweep-1", sequence: 5, continuationKey: "continuation-5" });
		expect(mocks.dispatch).toHaveBeenCalledWith(
			"media-reconcile-subscriptions-continuation",
			{ sweepId: "sweep-1", sequence: 5, continuationKey: "continuation-5" },
			{ idempotencyKey: "continuation-5" },
		);
	});

	it("recovers only due verification leases, expired policies, and explicitly quarantined legacy evidence", async () => {
		mocks.findAssets.mockResolvedValue([
			{ id: "asset-1", status: "VERIFYING", verificationLastErrorCode: null },
			{
				id: "asset-2",
				status: "QUARANTINED",
				verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED",
			},
		]);
		mocks.dispatch.mockRejectedValueOnce(new Error("temporary admission failure"));
		expect(
			await executeTask({ taskId: "media-recover-verifications", payload: {} }, context, {
				environment: {
					MEDIA_SAFETY_ADAPTER: "configured",
					MODERATION_IMAGE_SEEAPI_ENABLED: "true",
				},
			}),
		).toEqual({ recovered: 1 });
		expect(mocks.findAssets).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					deletedAt: null,
					OR: [
						{
							status: "VERIFYING",
							OR: [
								{
									verificationLeaseToken: null,
									OR: [
										{ verificationNextAttemptAt: null },
										{ verificationNextAttemptAt: { lte: expect.any(Date) } },
									],
								},
								{ verificationLeasedUntil: { lte: expect.any(Date) } },
								{ verificationLeaseToken: { not: null }, verificationLeasedUntil: null },
							],
						},
						{
							status: "READY",
							OR: [
								{ verificationValidUntil: { lte: expect.any(Date) } },
								{ verificationProvider: { not: "seeapi" } },
								{ verificationRuleVersion: { not: MEDIA_VERIFICATION_RULE_VERSION } },
								{ verificationPolicyVersion: { not: MEDIA_VERIFICATION_POLICY_VERSION } },
							],
						},
						{ status: "QUARANTINED", verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED" },
					],
				}),
				orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
				take: 25,
			}),
		);
		expect(mocks.dispatch.mock.calls).toEqual([
			[
				"media-verify-upload",
				{ assetId: "asset-1", allowQuarantinedReverification: false },
				{ idempotencyKey: "verification-recovery:workflow-1:asset-1" },
			],
			[
				"media-verify-upload",
				{ assetId: "asset-2", allowQuarantinedReverification: true },
				{ idempotencyKey: "verification-recovery:workflow-1:asset-2" },
			],
		]);
	});
});
