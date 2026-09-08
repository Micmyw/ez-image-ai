import {
	expireGenerationDrafts,
	expirePendingMediaUploadSessions,
	monitorGuestOperationalSafety,
	recoverExpiredPaymentEvents,
} from "@repo/database";
import { db } from "@repo/database/client";

import { admitGuestGeneration } from "../handlers/admit-guest-generation";
import { cancelProviderGeneration } from "../handlers/cancel-generation";
import {
	abortMultipartObject,
	abortPromotionMultipart,
	cleanupUploadPromotion,
	deleteStorageObject,
} from "../handlers/cleanup-storage-object";
import { deliverOutboxEvent } from "../handlers/deliver-outbox-event";
import { dispatchGeneration } from "../handlers/dispatch-generation";
import { dispatchOutbox } from "../handlers/dispatch-outbox";
import { expireGuestMedia } from "../handlers/expire-guest-media";
import { expireMediaUploads } from "../handlers/expire-media-uploads";
import { createDatabaseFinalizingGenerationRecoveryStore } from "../handlers/finalization-recovery-store";
import { finalizeMedia } from "../handlers/finalize-media";
import { grantBillingPeriods } from "../handlers/grant-billing-periods";
import { processPaymentEvent } from "../handlers/process-payment-event";
import { processProviderEvent } from "../handlers/process-provider-event";
import { reconcileGenerations } from "../handlers/reconcile-generations";
import {
	reconcileSubscriptions,
	type StripeReconciliationContinuation,
} from "../handlers/reconcile-subscriptions";
import {
	DEFAULT_FINALIZATION_STALE_AFTER_SECONDS,
	recoverFinalizingGenerations,
} from "../handlers/recover-finalizing-generations";
import { recoverMediaVerifications } from "../handlers/recover-media-verifications";
import { settleGeneration } from "../handlers/settle-generation";
import { verifyUpload } from "../handlers/verify-upload";
import {
	createDatabaseDispatchStore,
	createFinalizationDependencies,
	createProviderRegistry,
	createReconciliationProviderRegistry,
	databaseGuestAdmissionDependencies,
	databaseGuestMediaExpiryDependencies,
	databaseOutboxStore,
	databaseProviderCancellationStore,
	databaseProviderEventStore,
	databaseReconciliationStore,
	databaseSettlementStore,
	databaseStorageCleanupDependencies,
	databaseVerifyUploadDependencies,
	getAnyRegisteredProvider,
	getRegisteredProvider,
	resolveDatabaseDispatchRoute,
} from "../runtime";
import { dispatchJob } from "./client";
import type { TaskExecutionContext, TaskRequest } from "./contracts";
import { executePollingTick } from "./polling";
import {
	dispatchRouteForTask,
	parseDispatchPayload,
	parseTaskPayload,
	parseTaskRequest,
	taskDefinition,
} from "./registry";
import { listVerificationRecoveryCandidates } from "./verification-recovery";

export interface ExecutorDependencies {
	dispatch?: typeof dispatchJob;
	now?: () => Date;
	environment?: Record<string, string | undefined>;
}

export async function executeTask(
	request: TaskRequest,
	context: TaskExecutionContext,
	dependencies: ExecutorDependencies = {},
): Promise<unknown> {
	const { taskId, payload } = parseTaskRequest(request);
	if (
		!Number.isSafeInteger(context.attempt) ||
		context.attempt < 1 ||
		!Number.isSafeInteger(context.maxAttempts) ||
		context.maxAttempts < context.attempt ||
		typeof context.runId !== "string" ||
		!context.runId.trim()
	) {
		throw new Error("INVALID_TASK_EXECUTION_CONTEXT");
	}
	const dispatch = dependencies.dispatch ?? dispatchJob;
	const environment = dependencies.environment ?? process.env;
	const now = dependencies.now ?? (() => new Date());
	const schedulePolling = (attemptId: string) =>
		dispatch(
			"media-poll-generation",
			{ attemptId },
			{
				// Bounded poll Workflows can finish while a Provider remains pending. A new
				// window lets scheduled recovery resume polling without replaying submission.
				idempotencyKey: `generation-poll:${attemptId}:${Math.floor(now().getTime() / 600_000)}`,
			},
		);
	const scheduleContinuation = (continuation: StripeReconciliationContinuation) =>
		dispatch(
			"media-reconcile-subscriptions-continuation",
			{ ...continuation },
			{ idempotencyKey: continuation.continuationKey },
		);

	if (dispatchRouteForTask(taskId)) {
		const registry = createProviderRegistry(environment);
		return dispatchGeneration(parseDispatchPayload(taskId, payload), {
			store: createDatabaseDispatchStore(db, { enabledProviders: new Set(registry.keys()) }),
			getProvider: (provider) => getRegisteredProvider(registry, provider),
			isGenerationEnabled: () => environment.MEDIA_GENERATION_ENABLED === "true",
			schedulePolling,
		});
	}

	switch (taskId) {
		case "media-deliver-outbox":
			return dispatchOutbox(
				{ workerId: `workflow:${context.runId}`, limit: 50, leaseSeconds: 90 },
				{
					store: databaseOutboxStore,
					now,
					deliver: (event) =>
						deliverOutboxEvent(event, {
							trigger: (childTaskId, childPayload) =>
								dispatch(childTaskId, childPayload, {
									idempotencyKey: `outbox:${event.id}:attempt:${event.attempts}:${childTaskId}`,
									requireCompletion: true,
								}),
							// Cleanup, cancellation, and guest admission must finish before ACK.
							// Inline execution avoids waiting on a second Container admission.
							triggerAndWait: async (childTaskId, childPayload) => {
								await executeTask(
									{ taskId: childTaskId, payload: childPayload },
									{
										attempt: 1,
										maxAttempts: taskDefinition(childTaskId, environment).maxAttempts,
										runId: `${context.runId}:outbox:${event.id}:${event.leaseToken}`,
									},
									dependencies,
								);
							},
							resolveDispatchRoute: resolveDatabaseDispatchRoute,
						}),
				},
			);
		case "media-admit-guest-generation":
			return admitGuestGeneration(
				parseTaskPayload(taskId, payload),
				databaseGuestAdmissionDependencies,
			);
		case "media-cancel-generation": {
			const registry = createProviderRegistry(environment, { includeRecoveryProviders: true });
			return cancelProviderGeneration(parseTaskPayload(taskId, payload), {
				store: databaseProviderCancellationStore,
				getProvider: (provider) => getRegisteredProvider(registry, provider),
			});
		}
		case "media-finalize-generation":
			return finalizeMedia(parseTaskPayload(taskId, payload), createFinalizationDependencies());
		case "media-settle-generation":
			return settleGeneration(parseTaskPayload(taskId, payload), {
				store: databaseSettlementStore,
			});
		case "media-process-payment-event":
			return processPaymentEvent(parseTaskPayload(taskId, payload), {
				attempt: context.attempt,
				maxAttempts: context.maxAttempts,
				// This durable database field predates the orchestration platform change.
				triggerRunId: context.runId,
			});
		case "media-process-provider-webhook": {
			const registry = createProviderRegistry(environment, { includeRecoveryProviders: true });
			return processProviderEvent(parseTaskPayload(taskId, payload), {
				store: databaseProviderEventStore,
				getProvider: (provider) => getRegisteredProvider(registry, provider),
			});
		}
		case "media-poll-generation":
			return executePollingTick(parseTaskPayload(taskId, payload));
		case "media-verify-upload":
			return verifyUpload(parseTaskPayload(taskId, payload), databaseVerifyUploadDependencies);
		case "media-delete-object":
			return deleteStorageObject(
				parseTaskPayload(taskId, payload),
				databaseStorageCleanupDependencies,
			);
		case "media-abort-multipart":
			return abortMultipartObject(
				parseTaskPayload(taskId, payload),
				databaseStorageCleanupDependencies,
			);
		case "media-cleanup-upload-promotion":
			return cleanupUploadPromotion(
				parseTaskPayload(taskId, payload),
				databaseStorageCleanupDependencies,
			);
		case "media-abort-promotion-multipart":
			return abortPromotionMultipart(
				parseTaskPayload(taskId, payload),
				databaseStorageCleanupDependencies,
			);
		case "media-expire-guest-media": {
			const { timestamp } = parseTaskPayload(taskId, payload);
			const scheduledAt = timestamp === undefined ? now() : new Date(timestamp);
			await expireGuestMedia(
				{ now: scheduledAt, limit: 100 },
				databaseGuestMediaExpiryDependencies,
			);
			return monitorGuestOperationalSafety(db, {
				guestEnvironmentEnabled: environment.GUEST_MEDIA_ENABLED === "true",
				guestPromotionPeriod: environment.GUEST_PROMOTION_PERIOD ?? "",
				guestRiskBudgetMicros: guestRiskBudgetMicros(environment.GUEST_RISK_BUDGET_MICROS),
				now: scheduledAt,
			});
		}
		case "media-expire-uploads": {
			const { timestamp } = parseTaskPayload(taskId, payload);
			return expireMediaUploads(
				{ limit: 100, now: timestamp === undefined ? now() : new Date(timestamp) },
				{
					expireDrafts: (at) => expireGenerationDrafts(at, db),
					expireUploadSessions: (at, limit) =>
						expirePendingMediaUploadSessions({ now: at, limit }, db),
				},
			);
		}
		case "media-grant-billing-periods":
			return grantBillingPeriods({ limit: 100 });
		case "media-reconcile-generations": {
			const registry = createReconciliationProviderRegistry(environment);
			return reconcileGenerations(
				{ limit: 25, leaseSeconds: 120 },
				{
					store: databaseReconciliationStore,
					getProvider: (provider) => getAnyRegisteredProvider(registry, provider),
					now,
					schedulePolling,
				},
			);
		}
		case "media-reconcile-subscriptions":
			return reconcileSubscriptions({ limit: 100, continuationSequence: 0, scheduleContinuation });
		case "media-reconcile-subscriptions-continuation": {
			const continuation = parseTaskPayload(taskId, payload);
			return reconcileSubscriptions({
				limit: 100,
				expectedSweepId: continuation.sweepId,
				continuationSequence: continuation.sequence,
				scheduleContinuation,
			});
		}
		case "media-recover-finalizing-generations":
			return recoverFinalizingGenerations(
				{ limit: 25, staleAfterSeconds: DEFAULT_FINALIZATION_STALE_AFTER_SECONDS },
				createDatabaseFinalizingGenerationRecoveryStore(db),
			);
		case "media-recover-verifications":
			return recoverMediaVerifications(
				{ limit: 25 },
				{
					listCandidates: (input) => listVerificationRecoveryCandidates(db, input, environment),
					trigger: (candidate) =>
						dispatch(
							"media-verify-upload",
							{ ...candidate },
							{
								idempotencyKey: `verification-recovery:${context.runId}:${candidate.assetId}`,
							},
						),
				},
			);
		case "media-recover-payment-events":
			return recoverExpiredPaymentEvents({ limit: 25 }, db);
		default:
			throw new Error("UNREGISTERED_TASK_EXECUTOR");
	}
}

function guestRiskBudgetMicros(value: string | undefined): bigint {
	if (!value || !/^[1-9][0-9]*$/.test(value)) return 0n;
	return BigInt(value);
}
