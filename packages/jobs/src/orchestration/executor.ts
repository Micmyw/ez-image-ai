import { getGuestRiskBudgetMicros } from "@repo/config/server";
import {
	expireGenerationDrafts,
	expirePendingMediaUploadSessions,
	monitorGuestOperationalSafety,
	recoverExpiredPaymentEvents,
	prepareWorkflowOutboxDelivery,
	beginWorkflowOutboxExecution,
	completeWorkflowOutboxExecution,
	failWorkflowOutboxExecution,
	deferWorkflowOutboxExecution,
	readWorkflowOutboxEvent,
	deleteExpiredImagePhaseOwners,
} from "@repo/database";
import {
	getAssetGenerationContinuation,
	getFinalizationContinuation,
	getSubmittedGenerationContinuation,
	getProviderEventContinuation,
	getInitialGenerationEventIds,
} from "@repo/database";
import type { MediaVerificationAdmission } from "@repo/database";
import { db } from "@repo/database/client";
import { deliverModerationIncidentNotification } from "@repo/notifications/moderation-incident";

import {
	copyAccountInput,
	cleanupAccountInputCopyOrphan,
	recoverAccountInputCopyTasks,
} from "../handlers/account-input-copy";
import { admitGuestGeneration } from "../handlers/admit-guest-generation";
import { cancelProviderGeneration } from "../handlers/cancel-generation";
import {
	abortMultipartObject,
	abortPromotionMultipart,
	cleanupUploadPromotion,
	deleteStorageObject,
} from "../handlers/cleanup-storage-object";
import { confirmCancellation } from "../handlers/confirm-subscription-cancellation";
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
import { reconcileProviderPayments } from "../handlers/reconcile-provider-payments";
import {
	reconcileSubscriptions,
	type StripeReconciliationContinuation,
} from "../handlers/reconcile-subscriptions";
import {
	DEFAULT_FINALIZATION_STALE_AFTER_SECONDS,
	recoverFinalizingGenerations,
} from "../handlers/recover-finalizing-generations";
import { recoverMediaVerifications } from "../handlers/recover-media-verifications";
import { recoverCheckout } from "../handlers/recover-subscription-checkout";
import { settleGeneration } from "../handlers/settle-generation";
import {
	executeFusedTargetedEvent,
	executeTargetedEvent,
	prepareTargetedEvent,
} from "../handlers/targeted-event-delivery";
import { terminateSubscriptionAfterRefund } from "../handlers/terminate-refunded-subscription";
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
	createDatabaseAccountInputCopyDependencies,
	createDatabaseAccountInputCopyOrphanDependencies,
	createDatabaseAccountInputCopyRecoveryDependencies,
	databaseVerifyUploadDependencies,
	getAnyRegisteredProvider,
	getRegisteredProvider,
	resolveDatabaseDispatchRoute,
} from "../runtime";
import { dispatchJob } from "./client";
import type { TaskContinuation, TaskExecutionContext, TaskRequest } from "./contracts";
import { parseTaskContinuation } from "./contracts";
import {
	consumeFusedLegacyTaskAdmission,
	createFusedLegacyTaskAdmission,
	type FusedLegacyTaskAdmission,
	type FusedLegacyTaskAdmissionProof,
} from "./fused-legacy-task-admission";
import { unmanagedLegacyTask } from "./legacy-task-ownership";
import { executePollingTick } from "./polling";
import {
	dispatchRouteForTask,
	parseDispatchPayload,
	parseTaskPayload,
	parseTaskRequest,
	taskDefinition,
} from "./registry";
import { logTaskStarted, outboxTaskTrace } from "./task-timing";
import { listVerificationRecoveryCandidates } from "./verification-recovery";

export interface ExecutorDependencies {
	dispatch?: typeof dispatchJob;
	now?: () => Date;
	environment?: Record<string, string | undefined>;
	/** Only the separately routed, bounded streaming receiver enables this. */
	streamingTransfersOnly?: boolean;
	assertInlineTask?(parent: TaskRequest, child: TaskRequest): void;
}

async function recoverCompletedEvent(request: TaskRequest): Promise<Record<string, unknown>> {
	if (request.taskId === "media-verify-upload")
		return {
			done: true,
			waitSeconds: 0,
			continuation: await getAssetGenerationContinuation(request.payload.assetId as string, db),
		};
	if (request.taskId === "media-settle-generation") return { continuation: { eventIds: [] } };
	const jobId = request.payload.jobId as string;
	if (dispatchRouteForTask(request.taskId))
		return { continuation: await getSubmittedGenerationContinuation(jobId, db) };
	// A transfer can commit its output-review events before its response is lost.
	// They must be recovered alongside settlement, without replaying the transfer.
	const [settlement, outputs] = await Promise.all([
		getFinalizationContinuation(jobId, db, {
			recoverRetry: true,
			excludeEventId: request.outboxReceipt?.eventId,
		}),
		db.generationJobAsset.findMany({
			where: { jobId, role: "OUTPUT", asset: { status: "VERIFYING", deletedAt: null } },
			select: { assetId: true },
			take: 100,
		}),
	]);
	const reviews = outputs.length
		? await db.outboxEvent.findMany({
				where: {
					aggregateType: "MEDIA_ASSET",
					aggregateId: { in: outputs.map(({ assetId }) => assetId) },
					eventType: { in: ["MEDIA_ASSET_VERIFY", "MEDIA_ASSET_MODERATION_REQUESTED"] },
					status: { in: ["PENDING", "LEASED"] },
				},
				select: { id: true },
				take: 100,
			})
		: [];
	return {
		continuation: {
			...settlement,
			eventIds: [...new Set([...settlement.eventIds, ...reviews.map(({ id }) => id)])].slice(
				0,
				100,
			),
		},
	};
}

export async function executeTask(
	request: TaskRequest,
	context: TaskExecutionContext,
	dependencies: ExecutorDependencies = {},
): Promise<unknown> {
	const parsed = parseTaskRequest(request);
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
	return executeParsedTask(parsed, context, dependencies);
}

/** Only parsed request-local children enter here; private admissions never cross RPC. */
async function executeParsedTask(
	parsed: TaskRequest,
	context: TaskExecutionContext,
	dependencies: ExecutorDependencies,
	fusedAdmission?: FusedLegacyTaskAdmission,
	proof?: FusedLegacyTaskAdmissionProof,
): Promise<unknown> {
	const { taskId, payload } = parsed;
	if (parsed.outboxReceipt) {
		return executeTargetedEvent(parsed, {
			begin: (input) => fusedAdmission?.begin(input) ?? beginWorkflowOutboxExecution(input, db),
			complete: (input) => completeWorkflowOutboxExecution(input, db),
			fail: (input) => failWorkflowOutboxExecution(input, db),
			defer: (input) => deferWorkflowOutboxExecution(input, db),
			execute: (task) =>
				executeParsedTask(task, context, dependencies, undefined, fusedAdmission?.proofFor(task)),
			recover: recoverCompletedEvent,
		});
	}
	let verificationAdmission: MediaVerificationAdmission | undefined;
	const unmanaged = consumeFusedLegacyTaskAdmission(proof, parsed, context, db)
		? null
		: await unmanagedLegacyTask(
				db,
				payload,
				taskId === "media-verify-upload" && payload.queryOnly === true
					? (admission) => {
							verificationAdmission = admission;
						}
					: undefined,
			);
	if (unmanaged) return unmanaged;
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
	const scheduleProviderReconciliation = async (
		provider: "paypal" | "waffo",
		continuationKey: string,
	) => {
		await dispatch(
			"media-reconcile-provider-payments",
			{ provider },
			{ idempotencyKey: continuationKey },
		);
	};

	if (dispatchRouteForTask(taskId)) {
		const registry = createProviderRegistry(environment);
		const result = await dispatchGeneration(parseDispatchPayload(taskId, payload), {
			store: createDatabaseDispatchStore(db, {
				environment,
				enabledProviders: new Set(registry.keys()),
				...(context.workflowId
					? { workflowId: context.workflowId, phaseOwner: context.phaseOwner }
					: {}),
			}),
			getProvider: (provider) => getRegisteredProvider(registry, provider),
			isGenerationEnabled: () => environment.MEDIA_GENERATION_ENABLED === "true",
		});
		if (
			result.phaseOwnershipLost ||
			(result.phaseOwner && context.workflowId !== result.phaseOwner.workflowId)
		)
			return { ...result, phaseOwnershipLost: true, continuation: { eventIds: [] } };
		return {
			...result,
			continuation:
				result.continuation === undefined
					? await getSubmittedGenerationContinuation(payload.jobId as string, db)
					: result.continuation,
		};
	}

	switch (taskId) {
		case "media-execute-event": {
			const input = parseTaskPayload(taskId, payload);
			return executeFusedTargetedEvent(input, {
				prepare: async () =>
					(await executeTask(
						{ taskId: "media-prepare-event", payload: { eventId: input.eventId } },
						context,
						dependencies,
					)) as { preparedEvent: TaskRequest | null; eventRetryAfterMs?: number },
				execute: (child) => {
					// A new event owns a new asset/provider phase. Only its Workflow identity
					// carries forward; an input review epoch cannot authorize model submission.
					const { phaseOwner: _parentPhaseOwner, ...parentContext } = context;
					const childContext = {
						...parentContext,
						attempt: 1,
						maxAttempts: taskDefinition(child.taskId).maxAttempts,
					};
					logTaskStarted(child, childContext, now().getTime(), {
						executionMode: "inline",
						parentTaskId: taskId,
					});
					return executeParsedTask(
						child,
						childContext,
						dependencies,
						createFusedLegacyTaskAdmission(db, child, childContext),
					);
				},
				recover: async () => {
					const event = await readWorkflowOutboxEvent(input.eventId, db);
					if (!event) return { eventRecoveryState: "missing" };
					if (event.status !== "PROCESSED") return { eventRecoveryState: "held" };
					// A completion receipt recovers only committed control state, never its paid body.
					let continuation;
					if (event.aggregateType === "MEDIA_ASSET")
						continuation = await getAssetGenerationContinuation(event.aggregateId, db);
					else if (["JOB_CREATED", "GENERATION_DISPATCH"].includes(event.eventType))
						continuation = await getSubmittedGenerationContinuation(event.aggregateId, db);
					else if (event.eventType === "GENERATION_SETTLE") continuation = { eventIds: [] };
					else
						continuation = (
							await recoverCompletedEvent({
								taskId: "media-finalize-generation",
								payload: { jobId: event.aggregateId },
							})
						).continuation;
					return {
						eventRecoveryState: "completed",
						continuation: parseTaskContinuation(continuation),
					};
				},
			});
		}
		case "media-prepare-event": {
			const input = parseTaskPayload(taskId, payload);
			let eventRetryAfterMs: number | undefined;
			const preparedEvent = await prepareTargetedEvent(
				{ eventId: input.eventId, workerId: `workflow:${context.runId}:event:${input.eventId}` },
				{
					prepare: async (claim) => {
						const prepared = await prepareWorkflowOutboxDelivery(claim, db);
						eventRetryAfterMs = prepared.retryAfterMs;
						return prepared.event;
					},
					resolve: resolveDatabaseDispatchRoute,
					complete: (receipt) => completeWorkflowOutboxExecution(receipt, db),
				},
			);
			return {
				preparedEvent,
				...(eventRetryAfterMs === undefined ? {} : { eventRetryAfterMs }),
				continuation: { eventIds: [] },
			};
		}
		case "media-copy-account-input":
			return copyAccountInput(
				parseTaskPayload(taskId, payload),
				createDatabaseAccountInputCopyDependencies(db),
			);
		case "media-cleanup-account-input-copy":
			return cleanupAccountInputCopyOrphan(
				parseTaskPayload(taskId, payload),
				createDatabaseAccountInputCopyOrphanDependencies(db),
			);
		case "media-recover-account-input-copies": {
			const { timestamp } = parseTaskPayload(taskId, payload);
			return recoverAccountInputCopyTasks(
				{ timestamp: timestamp ?? now().getTime() },
				createDatabaseAccountInputCopyRecoveryDependencies(db, dispatch),
			);
		}
		case "media-deliver-outbox":
		case "media-deliver-output-review":
		case "media-deliver-events":
			return dispatchOutbox(
				{
					workerId: `workflow:${context.runId}`,
					limit:
						taskId === "media-deliver-output-review"
							? 1
							: taskId === "media-deliver-events"
								? 100
								: 50,
					leaseSeconds: 90,
					...(taskId === "media-deliver-events"
						? { eventIds: parseTaskPayload(taskId, payload).eventIds }
						: {}),
					...(taskId === "media-deliver-output-review"
						? { outputReviewEventId: parseTaskPayload(taskId, payload).eventId }
						: {}),
				},
				{
					store: databaseOutboxStore,
					now,
					deliver: async (event) => {
						let continuation: TaskContinuation | undefined;
						await deliverOutboxEvent(event, {
							deliverModerationAlert: deliverModerationIncidentNotification,
							trigger: async (childTaskId, childPayload) => {
								if (await unmanagedLegacyTask(db, childPayload)) return;
								await dispatch(childTaskId, childPayload, {
									idempotencyKey: `outbox:${event.id}:attempt:${event.attempts}:${childTaskId}`,
									requireCompletion: true,
									...outboxTaskTrace(event),
								});
							},
							// Cleanup, cancellation, and guest admission must finish before ACK.
							// Inline execution retains the parent's admitted slot and avoids
							// reacquiring the same single-slot executor while awaiting a child.
							triggerAndWait: async (childTaskId, childPayload) => {
								const child = {
									taskId: childTaskId,
									payload: childPayload,
									...outboxTaskTrace(event),
								};
								dependencies.assertInlineTask?.(parsed, child);
								const childContext = {
									attempt: 1,
									maxAttempts: taskDefinition(childTaskId, environment).maxAttempts,
									runId: `${context.runId}:outbox:${event.id}:${event.leaseToken}`,
								};
								logTaskStarted(child, childContext, now().getTime());
								const result = await executeTask(child, childContext, dependencies);
								if (childTaskId === "media-process-provider-webhook")
									continuation = parseTaskContinuation(
										(result as { continuation?: unknown } | null)?.continuation,
									);
							},
							resolveDispatchRoute: resolveDatabaseDispatchRoute,
						});
						// The parent returns these identities after ACK. Workflows consume
						// them only after this maintenance invocation releases its slot.
						return continuation;
					},
				},
			);
		case "media-admit-guest-generation": {
			const input = parseTaskPayload(taskId, payload);
			const result = await admitGuestGeneration(input, databaseGuestAdmissionDependencies);
			return {
				result,
				continuation: { eventIds: await getInitialGenerationEventIds(input.jobId, db) },
			};
		}
		case "media-cancel-generation": {
			const registry = createProviderRegistry(environment, { includeRecoveryProviders: true });
			return cancelProviderGeneration(parseTaskPayload(taskId, payload), {
				store: databaseProviderCancellationStore,
				getProvider: (provider) => getRegisteredProvider(registry, provider),
			});
		}
		case "media-finalize-generation": {
			const input = parseTaskPayload(taskId, payload);
			const result = await finalizeMedia(
				input,
				createFinalizationDependencies(environment, {
					deferOutputReview: input.deferOutputReview,
					...(dependencies.streamingTransfersOnly ? { streamingTransfersOnly: true } : {}),
				}),
			);
			const continuation = result.retryEvent
				? { eventIds: [result.retryEvent.id], notBefore: result.retryEvent.availableAt }
				: result.outcome === "WAITING_MODERATION"
					? { eventIds: result.outputReviewEventIds ?? [] }
					: await getFinalizationContinuation(input.jobId, db, {
							recoverRetry: result.outcome === "RETRY_SCHEDULED",
						});
			return {
				...result,
				continuation: {
					...continuation,
					eventIds: [
						...new Set([...continuation.eventIds, ...(result.outputReviewEventIds ?? [])]),
					],
				},
			};
		}
		case "media-settle-generation": {
			const result = await settleGeneration(parseTaskPayload(taskId, payload), {
				store: databaseSettlementStore,
			});
			return { result, continuation: { eventIds: [] } };
		}
		case "media-terminate-refunded-subscription":
			return terminateSubscriptionAfterRefund(parseTaskPayload(taskId, payload));
		case "media-recover-subscription-checkout":
			return recoverCheckout(parseTaskPayload(taskId, payload));
		case "media-confirm-subscription-cancellation":
			return confirmCancellation(parseTaskPayload(taskId, payload));
		case "media-process-payment-event":
			return processPaymentEvent(parseTaskPayload(taskId, payload), {
				attempt: context.attempt,
				maxAttempts: context.maxAttempts,
				// This durable database field predates the orchestration platform change.
				triggerRunId: context.runId,
			});
		case "media-process-provider-webhook": {
			const registry = createProviderRegistry(environment, { includeRecoveryProviders: true });
			const input = parseTaskPayload(taskId, payload);
			const result = await processProviderEvent(input, {
				store: databaseProviderEventStore,
				getProvider: (provider) => getRegisteredProvider(registry, provider),
			});
			return {
				result,
				continuation: await getProviderEventContinuation(input.providerWebhookEventId, db),
			};
		}
		case "media-poll-generation":
			return executePollingTick(parseTaskPayload(taskId, payload), undefined, context);
		case "media-verify-upload": {
			const input = parseTaskPayload(taskId, payload);
			const progress = context.workflowId
				? await verifyUpload(
						input,
						databaseVerifyUploadDependencies,
						verificationAdmission,
						context,
					)
				: verificationAdmission
					? await verifyUpload(input, databaseVerifyUploadDependencies, verificationAdmission)
					: await verifyUpload(input, databaseVerifyUploadDependencies);
			const signal =
				progress === undefined
					? {}
					: {
							outboxCommitted: progress.outboxCommitted,
							...(progress.phaseOwner ? { phaseOwner: progress.phaseOwner } : {}),
							...(progress.phaseOwnershipLost ? { phaseOwnershipLost: true } : {}),
							...(progress.queryOnly ? { queryOnly: true } : {}),
						};
			if (
				progress?.phaseOwnershipLost ||
				(progress?.phaseOwner && progress.phaseOwner.workflowId !== context.workflowId)
			)
				return {
					done: false,
					waitSeconds: 60,
					...signal,
					phaseOwnershipLost: true,
					continuation: { eventIds: [] },
				};
			if (progress?.verificationCommit) {
				const committed = progress.verificationCommit;
				if (
					committed.assetId !== input.assetId ||
					!Number.isSafeInteger(committed.generation) ||
					committed.generation < 1
				)
					throw new Error("INVALID_VERIFICATION_COMMIT_RECEIPT");
				return {
					done: true,
					waitSeconds: 0,
					...signal,
					continuation: { eventIds: committed.eventIds },
				};
			}
			if (progress?.verificationObservation) {
				const observed = progress.verificationObservation;
				if (
					!input.queryOnly ||
					observed.assetId !== input.assetId ||
					!Number.isSafeInteger(observed.generation) ||
					observed.generation < 1
				)
					throw new Error("INVALID_VERIFICATION_TERMINAL_OBSERVATION");
				return {
					done: true,
					waitSeconds: 0,
					...signal,
					continuation: { eventIds: observed.eventIds },
				};
			}
			const asset = await db.mediaAsset.findUnique({
				where: { id: input.assetId },
				select: {
					status: true,
					deletedAt: true,
					verificationNextAttemptAt: true,
					verificationLeasedUntil: true,
					verificationLastErrorCode: true,
					verificationProviderTaskId: true,
					verificationSubmissionUncertain: true,
				},
			});
			if (asset?.verificationLastErrorCode === "MODERATION_PROVIDER_RETIRED")
				return { done: true, waitSeconds: 0, ...signal };
			if (!asset || asset.deletedAt || asset.status !== "VERIFYING")
				return {
					done: true,
					waitSeconds: 0,
					...signal,
					continuation: await getAssetGenerationContinuation(input.assetId, db),
				};
			// Only a successful bound PENDING commit may immediately consume a new
			// callback. Unclaimed, uncertain and failed work retain their retry wait.
			const currentTime = now().getTime();
			const nextAt = Math.max(
				asset.verificationNextAttemptAt?.getTime() ?? 0,
				asset.verificationLeasedUntil?.getTime() ?? 0,
			);
			if (
				progress?.queryOnly === true &&
				asset.verificationProviderTaskId &&
				asset.verificationSubmissionUncertain === false &&
				asset.verificationNextAttemptAt &&
				nextAt <= currentTime
			)
				return {
					done: false,
					continuation: { eventIds: [] },
					...signal,
					waitSeconds: 0,
					retryImmediately: true,
				};
			// Workflow sleep releases the executor until the persisted retry is due.
			return {
				done: false,
				continuation: { eventIds: [] },
				...signal,
				waitSeconds: nextAt
					? Math.min(60, Math.max(1, Math.ceil((nextAt - currentTime) / 1_000)))
					: 5,
			};
		}
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
				guestRiskBudgetMicros: getGuestRiskBudgetMicros(environment),
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
			return reconcileSubscriptions({
				limit: 100,
				continuationSequence: 0,
				scheduleContinuation,
				scheduleProviderReconciliation,
			});
		case "media-reconcile-provider-payments": {
			const input = parseTaskPayload(taskId, payload);
			return reconcileProviderPayments({
				provider: input.provider,
				scheduleNext: scheduleProviderReconciliation,
			});
		}
		case "media-reconcile-subscriptions-continuation": {
			const continuation = parseTaskPayload(taskId, payload);
			return reconcileSubscriptions({
				limit: 100,
				expectedSweepId: continuation.sweepId,
				continuationSequence: continuation.sequence,
				scheduleContinuation,
				scheduleProviderReconciliation,
			});
		}
		case "media-recover-finalizing-generations":
			return recoverFinalizingGenerations(
				{ limit: 25, staleAfterSeconds: DEFAULT_FINALIZATION_STALE_AFTER_SECONDS },
				createDatabaseFinalizingGenerationRecoveryStore(db),
			);
		case "media-recover-verifications": {
			const result = await recoverMediaVerifications(
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
			// Keep bounded owner cleanup off the generation and callback paths.
			await deleteExpiredImagePhaseOwners({ limit: 100 }, db);
			return result;
		}
		case "media-recover-payment-events":
			return recoverExpiredPaymentEvents({ limit: 25 }, db);
		default:
			throw new Error("UNREGISTERED_TASK_EXECUTOR");
	}
}
