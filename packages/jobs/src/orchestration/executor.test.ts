import { STATIC_DISPATCH_ROUTE_MANIFEST } from "@repo/ai/media/catalog/dispatch-manifest";
import {
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
} from "@repo/ai/media/moderation/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	OutboxDeliveryPendingError,
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
		cancel: vi.fn(),
		admit: vi.fn(),
		payment: vi.fn(),
		subscriptions: vi.fn(),
		verify: vi.fn(),
		expireGuest: vi.fn(),
		monitorGuest: vi.fn(),
		findAssets: vi.fn(),
		resolveDispatchRoute: vi.fn(),
		reconciliationStore,
		finalizationStore,
		finalizationRecovery: vi.fn(() => finalizationStore),
		recoverPayments: vi.fn(),
		runtime: {
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
vi.mock("@repo/database/client", () => ({ db: { mediaAsset: { findMany: mocks.findAssets } } }));
vi.mock("@repo/database", () => ({
	expireGenerationDrafts: vi.fn(),
	expirePendingMediaUploadSessions: vi.fn(),
	recoverExpiredPaymentEvents: mocks.recoverPayments,
	monitorGuestOperationalSafety: mocks.monitorGuest,
}));
vi.mock("../handlers/process-payment-event", () => ({ processPaymentEvent: mocks.payment }));
vi.mock("../handlers/reconcile-subscriptions", () => ({
	reconcileSubscriptions: mocks.subscriptions,
}));
vi.mock("../handlers/cleanup-storage-object", () => ({
	deleteStorageObject: mocks.cleanup,
	abortMultipartObject: mocks.cleanup,
	abortPromotionMultipart: mocks.cleanup,
	cleanupUploadPromotion: mocks.cleanup,
}));
vi.mock("../handlers/cancel-generation", () => ({ cancelProviderGeneration: mocks.cancel }));
vi.mock("../handlers/admit-guest-generation", () => ({ admitGuestGeneration: mocks.admit }));
vi.mock("../handlers/verify-upload", () => ({ verifyUpload: mocks.verify }));
vi.mock("../handlers/expire-guest-media", () => ({ expireGuestMedia: mocks.expireGuest }));
vi.mock("../handlers/finalization-recovery-store", () => ({
	createDatabaseFinalizingGenerationRecoveryStore: mocks.finalizationRecovery,
}));
vi.mock("../handlers/grant-billing-periods", () => ({ grantBillingPeriods: vi.fn() }));

import { executeTask } from "./executor";

const context = { attempt: 2, maxAttempts: 8, runId: "workflow-1" };
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
	mocks.dispatch.mockResolvedValue(undefined);
	mocks.cleanup.mockResolvedValue(undefined);
	mocks.cancel.mockResolvedValue(undefined);
	mocks.admit.mockResolvedValue(undefined);
	mocks.outboxStore.claimBatch.mockResolvedValue([]);
	mocks.outboxStore.complete.mockResolvedValue(undefined);
	mocks.outboxStore.defer.mockResolvedValue(undefined);
	mocks.outboxStore.release.mockResolvedValue(undefined);
	mocks.dispatchStore.claimDispatch.mockResolvedValue(null);
});

describe("Node task executor", () => {
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
		).toEqual({ claimed: 1, reconciled: 0 });
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
		});
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

	it("preserves all 16 pinned dispatch routes and lets the DB authorize submission", async () => {
		expect(STATIC_DISPATCH_ROUTE_MANIFEST).toHaveLength(16);
		for (const route of STATIC_DISPATCH_ROUTE_MANIFEST) {
			expect(
				await executeTask(
					{ taskId: route.taskId, payload: { jobId: "job-1", version: 0 } },
					context,
				),
			).toEqual({ outcome: "SKIPPED" });
			expect(mocks.dispatchStore.claimDispatch).toHaveBeenLastCalledWith({
				jobId: "job-1",
				version: 0,
				provider: route.provider,
				providerModelId: route.providerModelId,
			});
		}
		expect(mocks.runtime.createDatabaseDispatchStore).toHaveBeenCalledWith(expect.anything(), {
			enabledProviders: new Set(["kie"]),
		});
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

	it("keeps accepted submission durable when scheduling active polling fails", async () => {
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
			status: "RUNNING",
			providerTaskId: "remote-1",
			idempotency: { providerSupported: false, replayed: false },
			reconciliation: { submissionToken: "token-1" },
		});
		mocks.dispatch.mockRejectedValueOnce(new Error("scheduling unavailable"));
		expect(
			await executeTask(
				{
					taskId: "media-dispatch-image-kie-nano-banana-2",
					payload: { jobId: "job-1", version: 0 },
				},
				context,
				{ now: () => new Date(1_200_000) },
			),
		).toEqual({ outcome: "SUBMITTED" });
		expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
			"media-poll-generation",
			{ attemptId: "attempt-1" },
			{ idempotencyKey: "generation-poll:attempt-1:2" },
		);
		expect(mocks.dispatchStore.recordSubmission).toHaveBeenCalledTimes(1);
		expect(mocks.dispatchStore.recordUncertainSubmission).not.toHaveBeenCalled();
		expect(mocks.adapter.submit).toHaveBeenCalledTimes(1);
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
		const execution = executeTask({ taskId: "media-deliver-outbox", payload: {} }, context);
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
		expect(await executeTask({ taskId: "media-deliver-outbox", payload: {} }, context)).toEqual({
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
				.mockRejectedValueOnce(new Error("WORKFLOWS_EXECUTION_FAILED"))
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
				environment: { MEDIA_SAFETY_ADAPTER: "sightengine" },
			}),
		).toEqual({ recovered: 1 });
		expect(mocks.findAssets).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
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
								{ verificationProvider: { not: "sightengine" } },
								{ verificationRuleVersion: { not: MEDIA_VERIFICATION_RULE_VERSION } },
								{ verificationPolicyVersion: { not: MEDIA_VERIFICATION_POLICY_VERSION } },
							],
						},
						{ status: "QUARANTINED", verificationLastErrorCode: "LEGACY_EVIDENCE_UNTRUSTED" },
					],
				},
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
