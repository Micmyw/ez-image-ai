import { createHash } from "node:crypto";

import {
	createConfiguredImageSafetyAdapter,
	isImageContentRejection,
	type MediaSafetyAdapter,
} from "@repo/ai";
import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	KieProviderAdapter,
	OpenRouterProviderAdapter,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	MediaProviderRegistry,
	createReplicateWebhookVerifier,
	ReplicateProviderAdapter,
	type CatalogRoute,
	type MediaProviderAdapter,
	type MediaProviderRegistry as ProviderRegistry,
	type ModerationDecision,
	type NormalizedResult,
	type ProviderExecutionInput,
	type ProviderKey,
	type ProviderOutput,
	type ProviderTaskSnapshot,
	type ProviderSubmission,
	type RetrieveOnlyMediaProviderAdapter,
	chooseCatalogRoute,
	configuredProviderKeysFromEnvironment,
	getCatalogEntry,
	isCatalogInputSupported,
	isStaticDispatchRoute,
	locallyExecutableProviderKeysFromEnvironment,
	parseRouteGraphSnapshot,
	recoveryProviderKeysFromEnvironment,
} from "@repo/ai";
import {
	isTechnicalGenerationFailureCode,
	KIE_ZERO_COST_REJECTION_CODE,
	isTemporaryReferenceObjectKey,
	isRetryableModerationError,
	MODERATION_RETRYABLE_ERROR_CODES,
	moderationServiceErrorCode,
} from "@repo/config";
import {
	imageModerationProviderForEnvironment,
	OUTPUT_MODERATION_BILLING_POLICY,
} from "@repo/config";
import type { ProductModelKey } from "@repo/config";
import {
	createRetrievedProviderTerminalEvidence,
	readProviderTerminalEvidence,
	type ProviderAttemptIdentity,
} from "@repo/config/provider-terminal-evidence";
import {
	getGuestMediaConfig,
	isEzPicProductEnvironmentEnabled,
	maximumMediaStorageBytes,
	mediaDailyProviderCostBudgetMicros,
} from "@repo/config/server";
import {
	recordModerationOutcome,
	recordLockedAssetModerationOutcome,
	lockAssetPromptReview,
	hasCurrentApprovedMediaAssetEvidence,
	isHistoricalImageModerationProvider,
	imageModerationRetryAt,
	kieGenerationCallbackRetryAt,
	readTerminalMediaVerificationObservation,
	getObservedAssetGenerationContinuation,
	KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
	KIE_IMAGE_COMPLETION_NOTICE_PREFIX,
	claimImagePhaseOwnerInTransaction,
	getImagePhaseOwner,
	getProviderEventDeliveryWait,
	isImagePhaseOwnerCurrent,
	sameImagePhaseOwner,
	prepareGenerationSubmissionInTransaction,
	isGenerationSubmissionPreparationCurrentInTransaction,
	type GenerationSubmissionPreparation,
} from "@repo/database";
import {
	claimOutputModerationGraceInTransaction,
	canSettleKieZeroCostRejection,
	claimGenerationOutputTransferTransaction,
	claimOutboxBatch,
	claimMediaStorageCleanupTransaction,
	completeGenerationOutputTransferTransaction,
	completePersistedImageFinalizationInTransaction,
	readStreamingImageFinalization,
	completeOutboxEvent,
	deferOutboxEvent,
	expireGuestJobBeforeProvider,
	expireGuestMediaTransaction,
	failGenerationOutputTransferTransaction,
	GenerationOutputStorageError,
	getCommittedGlobalDailyGenerationCost,
	getGenerationFundingReservation,
	finalizeImagePassReservationInTransaction,
	recordGenerationOutputPromotionMultipartTransaction,
	releaseOutboxEvent,
	resolveGuestRuntimeConfigOverride,
	reserveGenerationOutputStorageTransaction,
	isDatabaseSerializationConflict,
	isDatabaseLockNotAvailable,
	isStorageFreshReadEnabled,
	runSerializable,
	runReadCommitted,
	SERIALIZABLE_RETRY_LIMIT,
	settleCreditsInTransaction,
} from "@repo/database";
import type {
	MediaVerificationAdmission,
	Prisma,
	ImagePhaseOwner,
	ImagePhaseContext,
} from "@repo/database";
import { db } from "@repo/database/client";
import type {
	PrismaClient,
	MediaAssetStatus,
	ModerationStatus,
} from "@repo/database/generated-client";
import {
	claimAccountInputCopy,
	registerAccountInputCopyMultipart,
	clearAccountInputCopyMultipart,
	commitAccountInputCopy,
	failAccountInputCopy,
	recoverAccountInputCopies,
	claimAccountInputCopyOrphan,
	recordAccountInputCopyOrphanPass,
	reconcileAccountInputCopyTargetInTransaction,
} from "@repo/database/media-account-input-copy";
import {
	recordMediaJobNotification,
	type MediaJobNotification,
} from "@repo/database/media-job-notifications";
import {
	MEDIA_VERIFICATION_CLAIM_SELECT,
	readMediaVerificationQueryProjection,
	readMediaVerificationVerdictProjection,
	type MediaVerificationClaimAsset,
} from "@repo/database/media-verification-projections";
import {
	abortMultipartUpload,
	assertMediaKind,
	isMediaContentType,
	config as storageConfig,
	createAssetObjectKey,
	createStagingObjectKey,
	createSignedReadUrl,
	decodeInlineBase64MediaOutput,
	deleteObject,
	detectMediaType,
	headObject,
	inspectPrivateMediaObject,
	openInspectedRemoteMedia,
	listMultipartUploads,
	MediaValidationError,
	promoteStagedObject,
	putPrivateMediaObject,
	readMediaHeader,
	RemoteMediaPolicyError,
	streamRemoteObjectToStorage,
	tryWriteImmutableGenerationImage,
	canStreamImmutableGenerationImage,
	GUEST_WATERMARK_VERSION,
	watermarkStagedGuestImage,
} from "@repo/storage";
import type { MediaObjectMetadata } from "@repo/storage";

import {
	DispatchAdmissionBlockedError,
	GenerationTransferRequiresHeavyError,
	OutputTransferClaimConflictError,
	ProviderEventPhaseHeldError,
	type AccountInputCopyDependencies,
	type AccountInputCopyOrphanDependencies,
	type AccountInputCopyRecoveryDependencies,
	type DispatchStore,
	type DispatchDeferred,
	type DispatchOwnershipLost,
	type ReconciliationLease,
	type FinalizationDependencies,
	type FinalizationClaim,
	type FinalizationFailure,
	type FinalizationRetryEvent,
	type FinalizationStore,
	type GuestAdmissionDependencies,
	type GuestMediaExpiryDependencies,
	type GenerationPollingStore,
	type OutboxStore,
	type ProviderCancellationStore,
	type ProviderEventStore,
	type SettlementStore,
	SettlementTransactionConflictError,
	type OutboxCommitResult,
	type UncertainSubmissionEvidence,
} from "./contracts";
import { createDispatchPreSendProofs } from "./dispatch-pre-send-proof";
import { generationPollingDelaySeconds } from "./generation-polling-policy";
import type { StorageCleanupDependencies } from "./handlers/cleanup-storage-object";
import {
	canReuseApprovedImageEvidence,
	IMAGE_APPROVAL_NO_TIME_EXPIRY,
} from "./media-approval-lifetime";
import { imageModerationCallbackUrl } from "./orchestration/image-moderation-callback-auth";
import { kieCompletionCallbackUrl } from "./orchestration/kie-callback-auth";
import { unmanagedLegacyTask } from "./orchestration/legacy-task-ownership";
import {
	createOutputTransferEnvelope,
	providerOutputsFromTransferEnvelope,
	responseSnapshotForResult,
	providerCostForResult,
} from "./output-transfer-envelope";
import type { OutputTransferEnvelope } from "./output-transfer-envelope";
import { providerCdnAllowlist } from "./provider-output-policy";
import { dispatchRouteFor, providerQueueKey } from "./queues";
import { publishCommittedMediaJobNotifications } from "./realtime/publish";

export interface ProviderRegistryOptions {
	includeRecoveryProviders?: boolean;
}

function submissionProviderKeysFromEnvironment(
	environment: Record<string, string | undefined>,
): ReadonlySet<ProviderKey> {
	return new Set<ProviderKey>(
		[...configuredProviderKeysFromEnvironment(environment)].filter(
			(provider) => provider !== "openrouter",
		),
	);
}

function recoveryProviderKeysWithExplicitOpenRouter(
	environment: Record<string, string | undefined>,
): ReadonlySet<ProviderKey> {
	return new Set<ProviderKey>(
		[...recoveryProviderKeysFromEnvironment(environment)].filter(
			(provider) => provider !== "openrouter" || environment.MEDIA_RECOVERY_PROVIDERS !== undefined,
		),
	);
}

export function createProviderRegistry(
	environment = process.env,
	options: ProviderRegistryOptions = {},
): ProviderRegistry {
	const configuredProviders = submissionProviderKeysFromEnvironment(environment);
	const requestedProviders = options.includeRecoveryProviders
		? new Set([...configuredProviders, ...recoveryProviderKeysWithExplicitOpenRouter(environment)])
		: configuredProviders;
	const registeredProviders = locallyExecutableProviderKeysFromEnvironment(
		environment,
		requestedProviders,
	);
	if (environment.NODE_ENV === "production") {
		const missingCredentials = [...requestedProviders]
			.filter((provider) => !registeredProviders.has(provider))
			.sort();
		if (missingCredentials.length > 0) {
			throw new Error(`PROVIDER_WORKER_CREDENTIAL_MISSING:${missingCredentials.join(",")}`);
		}
	}
	return createLocallyExecutableProviderRegistry(environment, registeredProviders);
}

export function createReconciliationProviderRegistry(environment = process.env): ProviderRegistry {
	const requestedProviders = new Set([
		...submissionProviderKeysFromEnvironment(environment),
		...recoveryProviderKeysWithExplicitOpenRouter(environment),
	]);
	const registeredProviders = locallyExecutableProviderKeysFromEnvironment(
		environment,
		requestedProviders,
	);
	return createLocallyExecutableProviderRegistry(environment, registeredProviders);
}

function createLocallyExecutableProviderRegistry(
	environment: Record<string, string | undefined>,
	registeredProviders: ReadonlySet<ProviderKey>,
): ProviderRegistry {
	const registry = new MediaProviderRegistry();
	if (registeredProviders.has("replicate") && environment.REPLICATE_API_TOKEN) {
		registry.register(
			new ReplicateProviderAdapter({
				apiToken: environment.REPLICATE_API_TOKEN,
				webhookSecret: environment.REPLICATE_WEBHOOK_SECRET,
			}),
		);
	}
	if (registeredProviders.has("fal") && environment.FAL_API_KEY)
		registry.register(new FalProviderAdapter({ apiKey: environment.FAL_API_KEY }));
	if (registeredProviders.has("kie") && environment.KIE_API_KEY)
		registry.register(new KieProviderAdapter({ apiKey: environment.KIE_API_KEY }));
	if (registeredProviders.has("gemini") && environment.GEMINI_API_KEY) {
		registry.register(new GeminiProviderAdapter({ apiKey: environment.GEMINI_API_KEY }));
	}
	if (registeredProviders.has("openrouter") && environment.OPENROUTER_API_KEY) {
		registry.register(new OpenRouterProviderAdapter({ apiKey: environment.OPENROUTER_API_KEY }));
	}
	return registry;
}

export function createProviderWebhookVerifierRegistry(
	environment = process.env,
): ReadonlyMap<ProviderKey, Pick<MediaProviderAdapter, "verifyWebhook">> {
	const providers = new Set([
		...configuredProviderKeysFromEnvironment(environment),
		...recoveryProviderKeysWithExplicitOpenRouter(environment),
	]);
	const verifiers = new Map<ProviderKey, Pick<MediaProviderAdapter, "verifyWebhook">>();
	if (providers.has("replicate") && environment.REPLICATE_WEBHOOK_SECRET) {
		verifiers.set(
			"replicate",
			createReplicateWebhookVerifier({
				webhookSecret: environment.REPLICATE_WEBHOOK_SECRET,
			}),
		);
	}
	return verifiers;
}

export function getRegisteredProvider(
	registry: ProviderRegistry,
	provider: ProviderKey,
): MediaProviderAdapter {
	const adapter = registry.get(provider);
	if (!adapter.submit) throw new Error(`Provider ${provider} is retrieve-only`);
	return adapter as MediaProviderAdapter;
}

export function getAnyRegisteredProvider(
	registry: ProviderRegistry,
	provider: ProviderKey,
): MediaProviderAdapter | RetrieveOnlyMediaProviderAdapter {
	return registry.get(provider);
}

export interface DispatchRuntimeOptions {
	workflowId?: string;
	phaseOwner?: ImagePhaseOwner;
	beforeSynchronousCommit?: () => Promise<void>;
	afterInputAuthorization?: () => Promise<void>;
	createSignedReadUrl?: typeof createSignedReadUrl;
	database?: PrismaClient;
	enabledProviders?: ReadonlySet<ProviderKey>;
	environment?: Record<string, string | undefined>;
}

export interface GuestAdmissionRuntimeOptions {
	environment?: Record<string, string | undefined>;
	retryDelayMs?: number;
	queueCapacity?: number;
	serviceTimeMs?: number;
}

const dispatchAdmissionBlocked = Symbol("dispatch-admission-blocked");

export async function resolveDatabaseDispatchRoute(
	jobId: string,
	options: DispatchRuntimeOptions = {},
) {
	const database = options.database ?? db;
	const job = await database.generationJob.findUnique({
		where: { executionEngine: "legacy", id: jobId },
		include: {
			attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
			quote: { select: { costMicros: true } },
		},
	});
	if (!job) return null;
	const environment = options.environment ?? process.env;
	if (environment.MEDIA_GENERATION_ENABLED !== "true") {
		throw new Error("MEDIA_GENERATION_DISABLED");
	}
	if (await isMediaGenerationDisabled(database, job.productKey, environment)) {
		throw new Error("MEDIA_GENERATION_DISABLED");
	}
	const resolution = quotedExecutableRoutes(
		job,
		options.enabledProviders ?? configuredProviderKeysFromEnvironment(environment),
		environment,
	);
	if (resolution.kind === "UNAVAILABLE") {
		await database.$transaction((tx) =>
			markQuotedRouteUnavailable(tx, {
				jobId: job.id,
				code: resolution.code,
				diagnosticRoute: resolution.diagnosticRoute,
			}),
		);
		return null;
	}
	const existing = job.attempts[0];
	const route = existing
		? resolution.routes.find(
				(candidate) =>
					candidate.provider === existing.provider &&
					candidate.providerModelId === existing.providerModelId,
			)
		: chooseCatalogRoute(resolution.routes, deterministicFraction(job.id));
	if (!route) {
		await database.$transaction((tx) =>
			markQuotedRouteUnavailable(tx, {
				jobId: job.id,
				code: resolution.code,
				diagnosticRoute: existing
					? {
							provider: existing.provider as ProviderKey,
							providerModelId: existing.providerModelId,
							providerCostMicros: 0,
							weight: 1,
						}
					: resolution.diagnosticRoute,
			}),
		);
		return null;
	}
	return {
		...dispatchRouteFor(resolution.entry.mediaKind, route.provider, route.providerModelId),
		provider: route.provider,
		providerModelId: route.providerModelId,
	};
}

export function createDatabaseGuestAdmissionDependencies(
	database: PrismaClient,
	options: GuestAdmissionRuntimeOptions = {},
): GuestAdmissionDependencies {
	const environment = options.environment ?? process.env;
	const queueCapacity = options.queueCapacity ?? 1;
	const serviceTimeMs = options.serviceTimeMs ?? 60_000;
	return {
		async admit(input) {
			return database.$transaction(
				async (tx) => {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-dispatch:${input.jobId}`}, 0))`;
					const job = await tx.generationJob.findUnique({
						where: { executionEngine: "legacy", id: input.jobId },
						include: {
							attempts: { select: { id: true }, take: 1 },
							guestTrial: { include: { linkIntents: { select: { state: true } } } },
						},
					});
					const trial = job?.guestTrial;
					if (!job || !trial || trial.id !== input.trialId || job.serviceClass !== "GUEST_SLOW") {
						return { outcome: "SKIPPED" as const, jobId: input.jobId };
					}
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-owner-promotion:${job.ownerId}:${trial.promotionPeriod}`}, 0))`;
					await tx.$queryRaw`SELECT "id" FROM "guest_media_trial" WHERE "id" = ${trial.id} FOR UPDATE`;
					if (job.attempts.length !== 0 || job.status !== "RESERVED") {
						return { outcome: "SKIPPED" as const, jobId: job.id };
					}
					if (trial.expiresAt <= input.now) {
						const expired = await expireGuestJobBeforeProvider(
							{ jobId: job.id, now: input.now, queueCapacity, serviceTimeMs },
							tx,
						);
						return expired.outcome === "SKIPPED"
							? { outcome: "SKIPPED" as const, jobId: job.id }
							: expired;
					}
					if (!(await guestRuntimeEnabled(tx, environment, trial.promotionPeriod))) {
						const expired = await expireGuestJobBeforeProvider(
							{
								jobId: job.id,
								now: input.now,
								createReplacement: false,
								queueCapacity,
								serviceTimeMs,
							},
							tx,
						);
						return expired.outcome === "SKIPPED"
							? { outcome: "SKIPPED" as const, jobId: job.id }
							: expired;
					}
					if (
						trial.currentJobId !== job.id ||
						trial.consumedJobId !== null ||
						trial.eligibility !== "IN_FLIGHT" ||
						trial.riskState !== "HELD"
					) {
						const expired = await expireGuestJobBeforeProvider(
							{
								jobId: job.id,
								now: input.now,
								createReplacement: false,
								queueCapacity,
								serviceTimeMs,
							},
							tx,
						);
						return expired.outcome === "SKIPPED"
							? { outcome: "SKIPPED" as const, jobId: job.id }
							: expired;
					}
					const changed = await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: job.id,
							version: job.version,
							status: "RESERVED",
							serviceClass: "GUEST_SLOW",
						},
						data: {
							status: "DISPATCH_QUEUED",
							dispatchEligibleAt: input.now,
							version: { increment: 1 },
						},
					});
					if (changed.count !== 1) {
						return { outcome: "BUSY" as const, retryAt: new Date(input.now.getTime() + 1_000) };
					}
					const version = job.version + 1;
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-dispatch:${job.id}:guest-1` },
						create: {
							eventType: "GENERATION_DISPATCH",
							aggregateType: "GENERATION_JOB",
							aggregateId: job.id,
							dedupeKey: `generation-dispatch:${job.id}:guest-1`,
							payload: { jobId: job.id, version },
						},
						update: {},
					});
					return { outcome: "ADMITTED" as const, jobId: job.id, version };
				},
				{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 20_000 },
			);
		},
	};
}

export const databaseGuestAdmissionDependencies = createDatabaseGuestAdmissionDependencies(db);

export function createDatabaseGuestMediaExpiryDependencies(
	database: PrismaClient,
): GuestMediaExpiryDependencies {
	return { expire: (input) => expireGuestMediaTransaction(input, database) };
}

export const databaseGuestMediaExpiryDependencies = createDatabaseGuestMediaExpiryDependencies(db);

export function createDatabaseDispatchStore(
	database: PrismaClient,
	options: DispatchRuntimeOptions = {},
): DispatchStore {
	const environment = options.environment ?? process.env;
	const enabledProviders =
		options.enabledProviders ?? locallyExecutableProviderKeysFromEnvironment(environment);
	const preSendProofs = createDispatchPreSendProofs();
	return {
		async claimDispatch(payload) {
			if (environment.MEDIA_GENERATION_ENABLED !== "true") {
				throw new DispatchAdmissionBlockedError();
			}
			let preparation: GenerationSubmissionPreparation | undefined;
			const claim = await runReadCommitted(database, async (tx) => {
				// Serialize the same job only. Frozen routes are read after this lock;
				// unrelated owners do not share a retired provider-capacity lock.
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-dispatch:${payload.jobId}`}, 0))`;
				const job = await tx.generationJob.findFirst({
					where: {
						executionEngine: "legacy",
						id: payload.jobId,
						version: payload.version,
						status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
					},
					include: {
						attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
						assets: true,
						quote: { select: { costMicros: true, moderationDecision: true } },
						guestTrial: { include: { linkIntents: { select: { state: true } } } },
					},
				});
				if (!job) return null;
				// Historical bypass quotes remain recorded, but cannot start paid work.
				if (job.quote.moderationDecision === "BYPASS") return null;
				const isGuest = job.serviceClass === "GUEST_SLOW";
				if (isGuest && job.status !== "DISPATCH_QUEUED") return null;
				if (await isMediaGenerationDisabled(tx, job.productKey, environment)) {
					if (isGuest) {
						await expireGuestJobBeforeProvider(
							{ jobId: job.id, now: new Date(), createReplacement: false },
							tx,
						);
						return null;
					}
					const requeued = await requeueDispatchBlockedByKillSwitch(tx, job);
					if (!requeued) return null;
					return dispatchAdmissionBlocked;
				}
				const existing = job.attempts[0];
				if (existing) {
					await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${existing.id} FOR UPDATE`;
					const owner = await getImagePhaseOwner(
						{ kind: "generation", attemptId: existing.id },
						tx,
					);
					if (
						(owner && owner.workflowId !== options.workflowId) ||
						(options.phaseOwner && (!owner || !sameImagePhaseOwner(owner, options.phaseOwner)))
					)
						return { phaseOwnershipLost: true as const, ...(owner ? { phaseOwner: owner } : {}) };
				}
				if (isGuest && existing) return null;
				if (
					existing &&
					(existing.status !== "CREATED" ||
						existing.uncertainSubmission ||
						existing.submittedAt != null ||
						existing.providerTaskId != null)
				)
					return null;
				const dispatchNow = new Date();
				if (job.dispatchEligibleAt && job.dispatchEligibleAt > dispatchNow) {
					return deferProviderDispatch(tx, job, job.dispatchEligibleAt, dispatchNow);
				}
				if (isGuest) {
					const trial = job.guestTrial;
					if (!trial || trial.ownerId === null) return null;
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-owner-promotion:${job.ownerId}:${trial.promotionPeriod}`}, 0))`;
					await tx.$queryRaw`SELECT "id" FROM "guest_media_trial" WHERE "id" = ${trial.id} FOR UPDATE`;
					if (!(await guestDispatchChecksPass(tx, job, trial, environment, new Date()))) {
						await expireGuestJobBeforeProvider(
							{ jobId: job.id, now: new Date(), createReplacement: false },
							tx,
						);
						return null;
					}
				}
				const resolution = quotedExecutableRoutes(job, enabledProviders, environment);
				if (resolution.kind === "UNAVAILABLE") {
					await markQuotedRouteUnavailable(tx, {
						jobId: job.id,
						code: resolution.code,
						diagnosticRoute: resolution.diagnosticRoute,
					});
					return null;
				}
				const route = existing
					? resolution.routes.find(
							(candidate) =>
								candidate.provider === existing.provider &&
								candidate.providerModelId === existing.providerModelId,
						)
					: chooseCatalogRoute(resolution.routes, deterministicFraction(job.id));
				if (!route) {
					await markQuotedRouteUnavailable(tx, {
						jobId: job.id,
						code: resolution.code,
						diagnosticRoute: existing
							? {
									provider: existing.provider as ProviderKey,
									providerModelId: existing.providerModelId,
									providerCostMicros: 0,
									weight: 1,
								}
							: resolution.diagnosticRoute,
					});
					return null;
				}
				const hasPinnedRoute =
					payload.provider !== undefined || payload.providerModelId !== undefined;
				if (
					hasPinnedRoute &&
					(payload.provider !== route.provider || payload.providerModelId !== route.providerModelId)
				) {
					await markQuotedRouteUnavailable(tx, {
						jobId: job.id,
						code: "DISPATCH_ROUTE_MISMATCH",
						diagnosticRoute: route,
					});
					return null;
				}
				// The legacy project concurrency setting is not a verified provider quota.
				// Keep the atomic job claim and pre-send fence without limiting other jobs.
				const rawInput = job.inputSnapshot as unknown as ProviderExecutionInput & {
					sourceAssetId?: string;
				};
				let input: ProviderExecutionInput = rawInput;
				if (rawInput.sourceAssetId) {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${rawInput.sourceAssetId}`}, 0))`;
					const binding = await tx.generationJobAsset.findFirst({
						where: {
							AND: { job: { executionEngine: "legacy" } },
							jobId: job.id,
							assetId: rawInput.sourceAssetId,
							role: "INPUT",
						},
						include: {
							asset: {
								include: {
									moderationResults: {
										orderBy: [
											{ verificationGeneration: "desc" },
											{ attemptNumber: "desc" },
											{ createdAt: "desc" },
											{ id: "desc" },
										],
										take: 1,
									},
								},
							},
						},
					});
					if (binding && isTemporaryReferenceObjectKey(binding.asset.objectKey)) {
						if (
							!binding.asset.deleteAfter ||
							binding.asset.deleteAfter.getTime() <= Date.now() ||
							binding.asset.deletedAt ||
							["QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(binding.asset.status)
						) {
							await resolveJobsWaitingForMediaVerification(tx, {
								assetId: binding.asset.id,
								verificationGeneration: binding.asset.verificationGeneration,
								approved: false,
								failureCode:
									binding.asset.deleteAfter && binding.asset.deleteAfter.getTime() > Date.now()
										? "ASSET_VERIFICATION_FAILED"
										: "TEMPORARY_REFERENCE_EXPIRED",
							});
							return null;
						}
						// The durable verification event will wake this same job. No model attempt yet.
						if (binding.asset.status === "VERIFYING") return null;
						if (binding.asset.moderationResults[0]?.status !== "APPROVED") {
							await resolveJobsWaitingForMediaVerification(tx, {
								assetId: binding.asset.id,
								verificationGeneration: binding.asset.verificationGeneration,
								approved: false,
								failureCode: "ASSET_VERIFICATION_FAILED",
							});
							return null;
						}
					}
					if (!binding || binding.asset.status !== "READY") {
						throw new Error("Input asset is not ready");
					}
					if (!binding.asset.checksum || binding.assetChecksum !== binding.asset.checksum) {
						throw new Error("Input asset checksum no longer matches job binding");
					}
					const currentProvider = imageModerationProviderForEnvironment(environment);
					const now = new Date();
					if (
						!hasCurrentApprovedMediaAssetEvidence(binding.asset, {
							provider: currentProvider,
							ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
							policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
							now,
						})
					) {
						throw new Error("Input asset moderation evidence is stale");
					}
					const transferUrl = await (options.createSignedReadUrl ?? createSignedReadUrl)({
						bucket: "media",
						key: binding.asset.objectKey,
						expiresIn: 600,
					});
					const { sourceAssetId: _, ...withoutId } = rawInput;
					input = {
						...withoutId,
						sourceAsset: { assetId: binding.asset.id, transferUrl },
					} as ProviderExecutionInput;
					await options.afterInputAuthorization?.();
				}
				const changed = await tx.generationJob.updateMany({
					where: {
						executionEngine: "legacy",
						id: job.id,
						version: job.version,
						status: job.status,
					},
					data: { status: "SUBMITTING", version: { increment: 1 } },
				});
				if (changed.count !== 1) return null;
				const now = new Date();
				const attempt =
					existing ??
					(await tx.generationAttempt.create({
						data: {
							jobId: job.id,
							attemptNumber: 1,
							provider: route.provider,
							providerModelId: route.providerModelId,
							requestSnapshot: { catalogRoute: route.provider } as Prisma.InputJsonValue,
						},
					}));
				let phaseOwner: ImagePhaseOwner | undefined;
				if (options.workflowId) {
					const ownership = await claimImagePhaseOwnerInTransaction(
						{
							phase: { kind: "generation", attemptId: attempt.id },
							workflowId: options.workflowId,
							expectedOwner: options.phaseOwner,
							businessLeasedUntil: attempt.reconcileLeasedUntil,
						},
						tx,
					);
					if (!ownership.owned) throw new ImagePhaseOwnershipLostError(ownership.phaseOwner);
					phaseOwner = ownership.phaseOwner;
				}
				const preSend = preSendAttemptState(
					{
						attemptId: attempt.id,
						attemptNumber: attempt.attemptNumber,
						jobId: job.id,
						provider: route.provider,
						providerModelId: route.providerModelId,
						inputSnapshot: job.inputSnapshot,
					},
					now,
				);
				preparation = await prepareGenerationSubmissionInTransaction(
					{
						attemptId: attempt.id,
						attemptNumber: attempt.attemptNumber,
						jobId: job.id,
						jobVersion: job.version + 1,
						provider: route.provider,
						providerModelId: route.providerModelId,
						inputSnapshot: job.inputSnapshot,
						pricingSnapshot: job.pricingSnapshot,
						requestSnapshot: preSend.requestSnapshot as Prisma.InputJsonValue,
						now,
						nextReconcileAt: preSend.nextReconcileAt as Date,
					},
					tx,
				);
				if (isGuest) {
					const trial = job.guestTrial!;
					const committedRisk = await tx.guestRiskBudgetBucket.updateMany({
						where: {
							promotionPeriod: trial.promotionPeriod,
							subjectHash: "global",
							reservedMicros: { gte: trial.frozenQuotedRiskMicros },
						},
						data: {
							reservedMicros: { decrement: trial.frozenQuotedRiskMicros },
							consumedMicros: { increment: trial.frozenQuotedRiskMicros },
							version: { increment: 1 },
						},
					});
					if (committedRisk.count !== 1) throw new Error("GUEST_RISK_COMMIT_FAILED");
					const consumed = await tx.guestMediaTrial.updateMany({
						where: {
							id: trial.id,
							currentJobId: job.id,
							consumedJobId: null,
							eligibility: "IN_FLIGHT",
							riskState: "HELD",
							providerBoundaryAt: null,
						},
						data: {
							currentJobId: null,
							consumedJobId: job.id,
							eligibility: "CONSUMED",
							riskState: "COMMITTED",
							providerBoundaryAt: now,
							consumedAt: now,
						},
					});
					if (consumed.count !== 1) throw new Error("GUEST_TRIAL_CONSUME_FAILED");
				}
				return {
					...(phaseOwner ? { phaseOwner } : {}),
					attemptId: attempt.id,
					attemptNumber: attempt.attemptNumber,
					serviceClass: job.serviceClass,
					provider: route.provider,
					providerModelId: route.providerModelId,
					mediaKind: resolution.entry.mediaKind,
					queueKey: providerQueueKey(route.provider, route.providerModelId),
					input,
					webhookUrl:
						route.provider === "replicate" && process.env.NEXT_PUBLIC_SAAS_URL
							? `${process.env.NEXT_PUBLIC_SAAS_URL}/api/webhooks/ai/replicate`
							: route.provider === "kie" && resolution.entry.mediaKind === "image"
								? kieCompletionCallbackUrl(attempt.id, environment)
								: undefined,
				};
			}).catch((error: unknown) => {
				if (error instanceof ImagePhaseOwnershipLostError) return error.result;
				throw error;
			});
			if (claim === dispatchAdmissionBlocked) throw new DispatchAdmissionBlockedError();
			if (claim && "attemptId" in claim) {
				if (!preparation) throw new Error("GENERATION_SUBMISSION_PREPARATION_MISSING");
				// A lost/unknown COMMIT never reaches this registration boundary.
				return preSendProofs.register(claim, preparation);
			}
			return claim;
		},
		async recordSubmissionStarted(attemptId, phaseOwner, preparedClaim) {
			if (preparedClaim !== undefined) {
				const prepared = preSendProofs.consume(preparedClaim, attemptId, phaseOwner);
				if (!prepared) return false;
				return runReadCommitted(database, async (tx) => {
					if (
						!(await isGenerationSubmissionPreparationCurrentInTransaction(prepared, phaseOwner, tx))
					)
						return false as const;
				});
			}
			return database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				if (!(await generationPhaseIsCurrent(attemptId, phaseOwner, tx))) return false as const;
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					include: { job: { select: { inputSnapshot: true } } },
				});
				await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					data: preSendAttemptState(
						{
							attemptId: attempt.id,
							attemptNumber: attempt.attemptNumber,
							jobId: attempt.jobId,
							provider: attempt.provider,
							providerModelId: attempt.providerModelId,
							inputSnapshot: attempt.job.inputSnapshot,
						},
						new Date(),
					),
				});
			});
		},
		async recordSubmission(attemptId, submission, phaseOwner) {
			return database.$transaction(async (tx) => {
				// A query/callback can finish while the create request is returning.
				// Read after the row lock so a late acknowledgement cannot erase it.
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
				});
				if (submission.outcome !== "accepted") {
					throw new Error("Only accepted provider submissions may be recorded as submitted");
				}
				const providerTaskId = boundedString(submission.providerTaskId, 512);
				if (!providerTaskId) {
					throw new Error("Accepted provider submission omitted its task ID");
				}
				if (!(await generationPhaseIsCurrent(attemptId, phaseOwner, tx))) {
					await preserveLateAcceptedGeneration(tx, attempt, submission);
					return lostGenerationPhase(attemptId, tx);
				}
				if (
					readProviderTerminalEvidence(
						objectRecord(attempt.responseSnapshot)?.providerTerminalEvidence,
						attempt,
					)
				) {
					if (providerTaskId !== attempt.providerTaskId)
						throw new Error("PROVIDER_SUBMISSION_TASK_MISMATCH");
					return;
				}
				const terminal = submission.status === "SUCCEEDED";
				const submissionToken = boundedString(submission.reconciliation.submissionToken, 256);
				const reconciliationEndpoints = safeReconciliationEndpoints(
					attempt.provider,
					providerTaskId,
					submission.reconciliation,
				);
				await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attempt.id },
					data: {
						providerTaskId,
						...reconciliationEndpoints,
						...(submissionToken ? { submissionToken } : {}),
						status: terminal
							? "SUCCEEDED"
							: submission.status === "RUNNING"
								? "RUNNING"
								: "SUBMITTED",
						submittedAt: new Date(),
						completedAt: terminal ? new Date() : undefined,
						responseSnapshot: submission.snapshot
							? {
									providerTaskId: submission.snapshot.providerTaskId,
									status: submission.snapshot.status,
								}
							: undefined,
						uncertainSubmission: false,
						errorSnapshot: {},
						nextReconcileAt: terminal
							? null
							: await kieGenerationCallbackRetryAt(
									{ ...attempt, providerTaskId },
									new Date(Date.now() + 10_000),
									tx,
								),
					},
				});
				const changed = await tx.generationJob.updateMany({
					where: { executionEngine: "legacy", id: attempt.jobId, status: "SUBMITTING" },
					data: {
						status: terminal ? "FINALIZING" : "PROVIDER_PENDING",
						version: { increment: 1 },
					},
				});
				if (terminal) {
					const event = await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}` },
						create: {
							eventType: "GENERATION_FINALIZE",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}`,
							payload: { jobId: attempt.jobId },
						},
						update: {},
						select: { id: true },
					});
					return changed.count === 1 ? { eventIds: [event.id] } : undefined;
				}
				// A concurrent state transition retains the historical compatibility read.
				return changed.count === 1
					? { eventIds: [], pollAttemptId: attempt.id, ...(phaseOwner ? { phaseOwner } : {}) }
					: undefined;
			});
		},
		async recordUncertainSubmission(attemptId, evidence, phaseOwner) {
			return database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				const existing = await tx.generationAttempt.findUniqueOrThrow({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
				});
				const recovery = safeUncertainRecoveryEvidence(existing.provider, evidence);
				if (!(await generationPhaseIsCurrent(attemptId, phaseOwner, tx))) {
					// Preserve only an unbound accepted identity. A stale error cannot
					// overwrite a newer terminal verdict or clear the uncertainty hold.
					if (
						!existing.providerTaskId &&
						evidence.providerTaskId &&
						["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"].includes(existing.status)
					)
						await tx.generationAttempt.update({
							where: { id: attemptId },
							data: { ...recovery, nextReconcileAt: new Date() },
						});
					return lostGenerationPhase(attemptId, tx);
				}
				const attempt = await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					data: {
						...recovery,
						status: "SUBMISSION_UNCERTAIN",
						uncertainSubmission: true,
						submittedAt: new Date(),
						nextReconcileAt: await kieGenerationCallbackRetryAt(
							{
								...existing,
								providerTaskId:
									boundedString(evidence.providerTaskId, 512) ?? existing.providerTaskId,
							},
							new Date(Date.now() + 30_000),
							tx,
						),
					},
				});
				const changed = await tx.generationJob.updateMany({
					where: { executionEngine: "legacy", id: attempt.jobId, status: "SUBMITTING" },
					data: { status: "PROVIDER_PENDING", version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new Error("Uncertain submission job state changed");
			});
		},
		async recordProviderAdapterUnavailable(attemptId, phaseOwner) {
			return database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				if (!(await generationPhaseIsCurrent(attemptId, phaseOwner, tx)))
					return lostGenerationPhase(attemptId, tx);
				const attempt = await tx.generationAttempt.findUnique({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					include: { job: { select: { status: true } } },
				});
				if (!attempt) throw new Error("Generation attempt not found");
				await moveAttemptToManualReconciliation(tx, {
					attempt,
					jobStatus: attempt.job.status,
					code: "PROVIDER_ADAPTER_UNAVAILABLE",
					attemptStatuses: ["CREATED", "SUBMISSION_UNCERTAIN"],
					jobStatuses: ["SUBMITTING"],
					action: "MEDIA_PROVIDER_ADAPTER_UNAVAILABLE",
					uncertainSubmission: false,
				});
			});
		},
		async recordSynchronousCompletion(attemptId, submission, result, phaseOwner) {
			return database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					include: { job: { select: { productKey: true } } },
				});
				const currentOwner = await generationPhaseIsCurrent(attemptId, phaseOwner, tx);
				if (
					readProviderTerminalEvidence(
						objectRecord(attempt.responseSnapshot)?.providerTerminalEvidence,
						attempt,
					)
				)
					return currentOwner ? undefined : lostGenerationPhase(attemptId, tx);
				if (submission.outcome !== "accepted") {
					throw new Error("Only accepted provider submissions may complete synchronously");
				}
				const providerTaskId = boundedString(submission.providerTaskId, 512);
				if (!providerTaskId) throw new Error("Synchronous submission omitted task ID");
				const submissionToken = boundedString(submission.reconciliation.submissionToken, 256);
				const reconciliationEndpoints = safeReconciliationEndpoints(
					attempt.provider,
					providerTaskId,
					submission.reconciliation,
				);
				const envelope = createOutputTransferEnvelope(
					mediaKindForJob(attempt.job.productKey),
					result.outputs,
				);
				if (!currentOwner) {
					await preserveLateAcceptedGeneration(
						tx,
						attempt,
						submission,
						envelope ? { envelope, result } : undefined,
					);
					return lostGenerationPhase(attemptId, tx);
				}
				if (!envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result, attempt),
						attemptData: {
							providerTaskId,
							...reconciliationEndpoints,
							...(submissionToken ? { submissionToken } : {}),
							providerCostMicros: providerCostForResult(result, attempt),
							submittedAt: new Date(),
						},
					});
					return { eventIds: [] };
				}
				await tx.generationAttemptTransferEnvelope.upsert({
					where: { attemptId },
					create: { attemptId, payload: outputTransferEnvelopeInput(envelope) },
					update: { payload: outputTransferEnvelopeInput(envelope) },
				});
				await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					data: {
						providerTaskId,
						...reconciliationEndpoints,
						...(submissionToken ? { submissionToken } : {}),
						status: "SUCCEEDED",
						submittedAt: new Date(),
						completedAt: new Date(),
						responseSnapshot: responseSnapshotForResult(result, attempt) as Prisma.InputJsonValue,
						providerCostMicros: providerCostForResult(result, attempt),
						uncertainSubmission: false,
						errorSnapshot: {},
						nextReconcileAt: null,
					},
				});
				const changed = await tx.generationJob.updateMany({
					where: { executionEngine: "legacy", id: attempt.jobId, status: "SUBMITTING" },
					data: { status: "FINALIZING", version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new Error("Synchronous completion job state changed");
				const event = await tx.outboxEvent.upsert({
					where: { dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}` },
					create: {
						eventType: "GENERATION_FINALIZE",
						aggregateType: "GENERATION_JOB",
						aggregateId: attempt.jobId,
						dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}`,
						payload: { jobId: attempt.jobId },
					},
					update: {},
					select: { id: true },
				});
				await options.beforeSynchronousCommit?.();
				return { eventIds: [event.id] };
			});
		},
		async recordRejectedSubmission(attemptId, failure, phaseOwner) {
			return database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${attemptId} FOR UPDATE`;
				if (!(await generationPhaseIsCurrent(attemptId, phaseOwner, tx)))
					return lostGenerationPhase(attemptId, tx);
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attemptId },
					include: {
						job: { include: { attempts: true, quote: { select: { costMicros: true } } } },
					},
				});
				await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attempt.id },
					data: {
						status: "FAILED",
						errorSnapshot: {
							code: failure.code,
							retryable: failure.retryable,
						},
						uncertainSubmission: false,
						nextReconcileAt: null,
						completedAt: new Date(),
					},
				});
				const resolution = quotedExecutableRoutes(attempt.job, enabledProviders, environment);
				const attemptedRoutes = new Set(
					attempt.job.attempts.map((item) => `${item.provider}:${item.providerModelId}`),
				);
				const retryRoute =
					attempt.job.serviceClass !== "GUEST_SLOW" &&
					failure.retryable &&
					resolution.kind === "RESOLVED"
						? resolution.routes.find(
								(route) => !attemptedRoutes.has(`${route.provider}:${route.providerModelId}`),
							)
						: undefined;
				if (retryRoute) {
					const nextAttemptNumber =
						Math.max(...attempt.job.attempts.map((item) => item.attemptNumber)) + 1;
					await tx.generationAttempt.create({
						data: {
							jobId: attempt.jobId,
							attemptNumber: nextAttemptNumber,
							provider: retryRoute.provider,
							providerModelId: retryRoute.providerModelId,
							requestSnapshot: { catalogRoute: retryRoute.provider } as Prisma.InputJsonValue,
						},
					});
					const changed = await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: attempt.jobId,
							status: "SUBMITTING",
							version: attempt.job.version,
						},
						data: { status: "DISPATCH_QUEUED", version: { increment: 1 } },
					});
					if (changed.count !== 1) throw new Error("Rejected submission job state changed");
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-dispatch:${attempt.jobId}:${nextAttemptNumber}` },
						create: {
							eventType: "GENERATION_DISPATCH",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-dispatch:${attempt.jobId}:${nextAttemptNumber}`,
							payload: { jobId: attempt.jobId, version: attempt.job.version + 1 },
						},
						update: {},
					});
					return;
				}
				const changed = await tx.generationJob.updateMany({
					where: {
						executionEngine: "legacy",
						id: attempt.jobId,
						status: "SUBMITTING",
						version: attempt.job.version,
					},
					data: {
						status: "FINALIZING",
						failureCode: "PROVIDER_UNAVAILABLE",
						version: { increment: 1 },
					},
				});
				if (changed.count !== 1) throw new Error("Rejected submission job state changed");
				await tx.outboxEvent.upsert({
					where: { dedupeKey: `generation-settle:${attempt.jobId}` },
					create: {
						eventType: "GENERATION_SETTLE",
						aggregateType: "GENERATION_JOB",
						aggregateId: attempt.jobId,
						dedupeKey: `generation-settle:${attempt.jobId}`,
						payload: { jobId: attempt.jobId, version: attempt.job.version + 1 },
					},
					update: {},
				});
			});
		},
	};
}
export const databaseDispatchStore: DispatchStore = createDatabaseDispatchStore(db);

class ImagePhaseOwnershipLostError extends Error {
	readonly result: DispatchOwnershipLost;
	constructor(phaseOwner?: ImagePhaseOwner) {
		super("IMAGE_PHASE_OWNERSHIP_LOST");
		this.result = { phaseOwnershipLost: true, ...(phaseOwner ? { phaseOwner } : {}) };
	}
}

async function generationPhaseIsCurrent(
	attemptId: string,
	owner: ImagePhaseOwner | undefined,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const phase = { kind: "generation" as const, attemptId };
	return owner
		? isImagePhaseOwnerCurrent(phase, owner, tx)
		: !(await getImagePhaseOwner(phase, tx));
}

async function lostGenerationPhase(
	attemptId: string,
	tx: Prisma.TransactionClient,
): Promise<DispatchOwnershipLost> {
	const phaseOwner = await getImagePhaseOwner({ kind: "generation", attemptId }, tx);
	return { phaseOwnershipLost: true, ...(phaseOwner ? { phaseOwner } : {}) };
}

/** Acceptance remains durable even when its executor's epoch expired during I/O. */
async function preserveLateAcceptedGeneration(
	tx: Prisma.TransactionClient,
	attempt: {
		id: string;
		provider: string;
		providerTaskId: string | null;
		status: string;
		responseSnapshot: unknown;
	},
	submission: Extract<ProviderSubmission, { outcome: "accepted" }>,
	completion?: { envelope: OutputTransferEnvelope; result: NormalizedResult },
): Promise<void> {
	const providerTaskId = boundedString(submission.providerTaskId, 512);
	if (!providerTaskId) throw new Error("ACCEPTED_PROVIDER_TASK_MISSING");
	if (attempt.providerTaskId && attempt.providerTaskId !== providerTaskId)
		throw new Error("PROVIDER_SUBMISSION_TASK_MISMATCH");
	if (!["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"].includes(attempt.status)) return;
	// The first authenticated completion and its immutable envelope must stay a
	// pair. A second stale executor may only observe it, never replace metadata.
	const priorCompletion = objectRecord(objectRecord(attempt.responseSnapshot)?.phaseCompletion);
	if (priorCompletion) {
		if (priorCompletion.providerTaskId !== providerTaskId)
			throw new Error("PROVIDER_SUBMISSION_TASK_MISMATCH");
		return;
	}
	if (completion) {
		await tx.generationAttemptTransferEnvelope.upsert({
			where: { attemptId: attempt.id },
			create: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(completion.envelope) },
			update: {},
		});
	}
	const submissionToken = boundedString(submission.reconciliation.submissionToken, 256);
	await tx.generationAttempt.update({
		where: { id: attempt.id },
		data: {
			providerTaskId,
			...safeReconciliationEndpoints(attempt.provider, providerTaskId, submission.reconciliation),
			...(submissionToken ? { submissionToken } : {}),
			// Do not change the attempt/job state or uncertainty here. The current
			// owner consumes a preserved synchronous completion under its own lease.
			nextReconcileAt: new Date(),
			...(completion
				? {
						responseSnapshot: {
							...responseSnapshotForResult(completion.result, attempt),
							phaseCompletion: {
								providerTaskId,
								progress: completion.result.progress,
								providerCostMicros: completion.result.providerCostMicros,
								providerCharged: completion.result.providerCharged,
							},
						} as Prisma.InputJsonValue,
					}
				: {}),
		},
	});
}

async function deferProviderDispatch(
	tx: Prisma.TransactionClient,
	job: { id: string; version: number },
	retryAt: Date,
	now: Date,
): Promise<DispatchDeferred | null> {
	const changed = await tx.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: job.id,
			version: job.version,
			status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
		},
		data: { dispatchEligibleAt: retryAt },
	});
	if (changed.count !== 1) return null;
	const dedupeKey = `generation-dispatch-provider-capacity:${job.id}:${job.version}:${retryAt.getTime()}`;
	const event = await tx.outboxEvent.upsert({
		where: { dedupeKey },
		create: {
			eventType: "GENERATION_DISPATCH",
			aggregateType: "GENERATION_JOB",
			aggregateId: job.id,
			dedupeKey,
			payload: { jobId: job.id, version: job.version },
			availableAt: retryAt,
		},
		update: {},
		select: { id: true },
	});
	return {
		deferred: true,
		retryAfterMs: Math.max(0, retryAt.getTime() - now.getTime()),
		continuation: { eventIds: [event.id], notBefore: retryAt.getTime() },
	};
}

export const databaseOutboxStore: OutboxStore = {
	claimBatch: (input) => claimOutboxBatch(input, db),
	async complete(id, workerId, leaseToken) {
		await completeOutboxEvent(id, workerId, leaseToken, db);
	},
	async defer(input) {
		const result = await deferOutboxEvent(input, db);
		if (!result.applied) throw new Error("OUTBOX_DEFER_LEASE_LOST");
	},
	async release(input) {
		await releaseOutboxEvent({ ...input, error: input.errorCode, maxAttempts: 12 }, db);
	},
};

export function createDatabaseStorageCleanupDependencies(
	database: PrismaClient,
	storage: Pick<
		StorageCleanupDependencies,
		"deleteObject" | "abortMultipartUpload" | "listMultipartUploads"
	> = {
		deleteObject: (objectKey) => deleteObject({ bucket: "media", key: objectKey }),
		abortMultipartUpload: (objectKey, uploadId) =>
			abortMultipartUpload({ bucket: "media", key: objectKey, uploadId }),
		listMultipartUploads: (objectKey) => listMultipartUploads({ bucket: "media", key: objectKey }),
	},
): StorageCleanupDependencies {
	return {
		...storage,
		claimDeletion: (input) => claimMediaStorageCleanupTransaction(input, database),
		async isComplete(operationKey) {
			return Boolean(
				await database.auditLog.findFirst({
					where: { targetType: "MEDIA_STORAGE_OPERATION", targetId: operationKey },
					select: { id: true },
				}),
			);
		},
		async complete(input) {
			await database.$transaction(async (tx) => {
				if (
					input.storageReservationReferenceKey &&
					input.storageReservationReferenceKey !== `generation-output:${input.assetId}` &&
					input.storageReservationReferenceKey !== `media-draft:${input.assetId}` &&
					input.storageReservationReferenceKey !== `temporary-reference:${input.assetId}`
				) {
					throw new Error("Generated output storage reservation reference is invalid");
				}
				await tx.auditLog.create({
					data: {
						action: input.action,
						targetType: "MEDIA_STORAGE_OPERATION",
						targetId: input.operationKey,
						metadata: {
							assetId: input.assetId,
							objectKey: input.objectKey,
							...(input.deletedObjectKeys ? { deletedObjectKeys: input.deletedObjectKeys } : {}),
							...(input.multipartUploadId ? { multipartUploadId: input.multipartUploadId } : {}),
							...(input.uploadSessionId ? { uploadSessionId: input.uploadSessionId } : {}),
							...(input.reservationStatus ? { reservationStatus: input.reservationStatus } : {}),
							...(input.storageReservationReferenceKey
								? { storageReservationReferenceKey: input.storageReservationReferenceKey }
								: {}),
						},
					},
				});
				if (input.uploadSessionId && input.reservationStatus) {
					await tx.storageUsageReservation.updateMany({
						where: {
							referenceKey: `media-upload:${input.uploadSessionId}`,
							status: { in: ["ACTIVE", "COMMITTED"] },
						},
						data: { status: input.reservationStatus, releasedAt: new Date() },
					});
				}
				if (input.storageReservationReferenceKey) {
					await tx.storageUsageReservation.updateMany({
						where: {
							referenceKey: input.storageReservationReferenceKey,
							status: { in: ["ACTIVE", "COMMITTED"] },
						},
						data: { status: "RELEASED", releasedAt: new Date() },
					});
				}
			});
		},
	};
}

export const databaseStorageCleanupDependencies = createDatabaseStorageCleanupDependencies(db);

export function createDatabaseAccountInputCopyDependencies(
	database: PrismaClient,
): AccountInputCopyDependencies {
	return {
		claim: (input) => claimAccountInputCopy(input, database),
		registerMultipart: (input) => registerAccountInputCopyMultipart(input, database),
		clearMultipart: (input) => clearAccountInputCopyMultipart(input, database),
		commit: (input) => commitAccountInputCopy(input, database),
		fail: (input) => failAccountInputCopy(input, database),
		copy: promoteStagedObject,
	};
}

export function createDatabaseAccountInputCopyOrphanDependencies(
	database: PrismaClient,
): AccountInputCopyOrphanDependencies {
	return {
		claim: (input) => claimAccountInputCopyOrphan(input, database),
		listMultipartUploads,
		abortMultipartUpload,
		deleteObject,
		recordPass: (input) => recordAccountInputCopyOrphanPass(input, database),
	};
}

export function createDatabaseAccountInputCopyRecoveryDependencies(
	database: PrismaClient,
	dispatch: AccountInputCopyRecoveryDependencies["dispatch"],
): AccountInputCopyRecoveryDependencies {
	return { recover: (input) => recoverAccountInputCopies(input, database), dispatch };
}

interface VerifyUploadRuntimeOptions {
	environment?: NodeJS.ProcessEnv;
	headObject?: (location: { bucket: "media"; key: string }) => Promise<MediaObjectMetadata>;
	readMediaHeader?: (location: { bucket: "media"; key: string }) => Promise<Uint8Array>;
	inspectPrivateMediaObject?: (input: {
		bucket: "media";
		key: string;
		contentType:
			| "image/jpeg"
			| "image/png"
			| "image/webp"
			| "video/mp4"
			| "video/webm"
			| "video/quicktime";
		contentLength: number;
	}) => Promise<{ bytes: number; sha256: string; etag: string | null; versionId: string | null }>;
	createSignedReadUrl?: (location: {
		bucket: "media";
		key: string;
		expiresIn: number;
	}) => Promise<string>;
	safety?: MediaSafetyAdapter;
	moderationProvider?: string;
	afterVideoSubmission?: (submission: {
		moderationTaskId: string;
		idempotency: { key: string; providerSupported: boolean; replayed: boolean };
	}) => Promise<void>;
	onVerificationError?: (error: unknown) => void;
}

export const MEDIA_VERIFICATION_RETRY_POLICY = {
	maxTransientFailures: 4,
	leaseMs: 2 * 60 * 1_000,
	deadlineMs: 24 * 60 * 60 * 1_000,
	imageDeadlineMs: 2 * 60 * 1_000,
	evidenceTtlMs: 24 * 60 * 60 * 1_000,
	imageProcessingPollMs: 5_000,
	processingPollMs: 15_000,
} as const;

interface MediaVerificationClaim {
	phaseOwner?: ImagePhaseOwner;
	assetId: string;
	nextAllowedQueryAt: Date | null;
	objectKey: string;
	mimeType: string;
	byteSize: bigint;
	kind: "INPUT" | "OUTPUT";
	checksum: string | null;
	storageEtag: string | null;
	storageVersionId: string | null;
	finalizedAt: Date | null;
	generation: number;
	attemptNumber: number;
	provider: string;
	ruleVersion: string;
	policyVersion: string;
	providerTaskId: string | null;
	deadlineAt: Date;
	submissionToken: string | null;
	submissionUncertain: boolean;
	callbackReceivedAt?: Date | null;
	forceObjectInspection: boolean;
	processingDeadlineExpired: boolean;
	startedAt: Date;
	leaseToken: string;
}

export function createDatabaseVerifyUploadDependencies(
	database: PrismaClient,
	options: VerifyUploadRuntimeOptions = {},
) {
	return {
		async verify(
			this: void,
			assetId: string,
			verificationOptions: {
				allowQuarantinedReverification?: boolean;
				queryOnly?: boolean;
				admission?: MediaVerificationAdmission;
				workflowId?: string;
				phaseOwner?: ImagePhaseOwner;
			} = {},
		): Promise<OutboxCommitResult> {
			// Factories are imported during closed-generation builds. Resolve live
			// moderation configuration only when work starts, before any DB claim.
			const environment = options.environment ?? process.env;
			const moderationProvider =
				options.moderationProvider ?? imageModerationProviderForEnvironment(environment);
			if (!options.safety && moderationProvider === "seeapi" && !environment.SEEAPI_API_KEY?.trim())
				throw new Error("IMAGE_MODERATION_CONFIGURATION_ERROR");
			const safety = options.safety ?? createSafetyAdapter(environment);
			const taskStartedAt = Date.now();
			let lastStageAt = taskStartedAt;
			const recordStage = (stage: string, details: Record<string, unknown> = {}) => {
				const now = Date.now();
				console.info("media.upload.verification", {
					assetId,
					stage,
					at: now,
					stageMs: now - lastStageAt,
					elapsedMs: now - taskStartedAt,
					...details,
				});
				lastStageAt = now;
			};
			recordStage("verification_started");
			if (verificationOptions.queryOnly) {
				const observed = await readTerminalMediaVerificationObservation(
					{
						assetId,
						provider: moderationProvider,
						ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
						policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					},
					database,
					verificationOptions.admission,
				);
				const continuation = observed
					? await getObservedAssetGenerationContinuation(observed, database)
					: undefined;
				if (observed && continuation) {
					const owner = await getImagePhaseOwner(
						{ kind: "verification", assetId, generation: observed.generation },
						database,
					);
					if (
						(owner && owner.workflowId !== verificationOptions.workflowId) ||
						(verificationOptions.phaseOwner &&
							(!owner || !sameImagePhaseOwner(owner, verificationOptions.phaseOwner)))
					) {
						return {
							outboxCommitted: false,
							...(owner ? { phaseOwner: owner } : {}),
							phaseOwnershipLost: true,
						};
					}
					recordStage("terminal_observed", {
						generation: observed.generation,
						status: observed.status,
					});
					return {
						outboxCommitted: false,
						verificationObservation: {
							assetId: observed.assetId,
							generation: observed.generation,
							status: observed.status,
							eventIds: continuation.eventIds,
						},
					};
				}
			}
			const claimed = await claimMediaVerification(database, {
				assetId,
				provider: moderationProvider,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				allowQuarantinedReverification: verificationOptions.allowQuarantinedReverification === true,
				queryOnly: verificationOptions.queryOnly === true,
				imageRetrievalSupported: typeof safety.retrieveImage === "function",
				workflowId: verificationOptions.workflowId,
				phaseOwner: verificationOptions.phaseOwner,
			});
			const { claim } = claimed;
			let outboxCommitted = claimed.outboxCommitted;
			recordStage(
				claim ? "claimed" : "not_claimed",
				claim
					? {
							attemptNumber: claim.attemptNumber,
							generation: claim.generation,
							finalizedToTaskStartMs: claim.finalizedAt
								? Math.max(0, taskStartedAt - claim.finalizedAt.getTime())
								: null,
						}
					: { outboxCommitted: claimed.outboxCommitted },
			);
			if (!claim)
				return {
					outboxCommitted,
					...(claimed.phaseOwner ? { phaseOwner: claimed.phaseOwner } : {}),
					...(claimed.phaseOwnershipLost ? { phaseOwnershipLost: true } : {}),
				};
			const withPhase = async (result: OutboxCommitResult): Promise<OutboxCommitResult> => {
				if (
					!result.outboxCommitted &&
					!result.queryOnly &&
					!result.verificationCommit &&
					!result.verificationObservation &&
					!result.phaseOwnershipLost &&
					!(await verificationPhaseIsCurrent(claim, database))
				)
					result = { ...result, phaseOwnershipLost: true };
				return { ...result, ...(claim.phaseOwner ? { phaseOwner: claim.phaseOwner } : {}) };
			};

			let checksum = claim.checksum;
			let storageEtag = claim.storageEtag;
			let storageVersionId = claim.storageVersionId;
			let finalizedAt = claim.finalizedAt;
			let moderationStarted = false;
			let detectorRequestInFlight = false;
			try {
				if (claim.forceObjectInspection || !checksum || !finalizedAt) {
					const inspected = await (options.inspectPrivateMediaObject ?? inspectPrivateMediaObject)({
						bucket: "media",
						key: claim.objectKey,
						contentType: claim.mimeType as
							| "image/jpeg"
							| "image/png"
							| "image/webp"
							| "video/mp4"
							| "video/webm"
							| "video/quicktime",
						contentLength: Number(claim.byteSize),
					});
					if (claim.forceObjectInspection && checksum && inspected.sha256 !== checksum) {
						return withPhase(
							await completeMediaVerification(database, claim, {
								decision: "REJECT",
								reasonCode: "LEGACY_UPLOAD_CHECKSUM_MISMATCH",
								ruleVersion: claim.ruleVersion,
								checksum,
								storageEtag,
								storageVersionId,
								finalizedAt,
							}),
						);
					}
					checksum = inspected.sha256;
					storageEtag = inspected.etag;
					storageVersionId = inspected.versionId;
					finalizedAt = new Date();
				}

				const location = { bucket: "media" as const, key: claim.objectKey };
				const verifiedImmutableObject =
					(claim.kind === "OUTPUT" ||
						(claim.kind === "INPUT" && isTemporaryReferenceObjectKey(claim.objectKey))) &&
					Boolean(claim.checksum && claim.finalizedAt) &&
					!claim.forceObjectInspection;
				if (!verifiedImmutableObject) {
					const [metadata, header] = await Promise.all([
						(options.headObject ?? headObject)(location),
						(options.readMediaHeader ?? readMediaHeader)(location),
					]);
					const detectedType = detectMediaType(header);
					recordStage("storage_inspected");
					if (
						metadata.contentLength !== Number(claim.byteSize) ||
						metadata.contentType !== claim.mimeType ||
						detectedType !== claim.mimeType
					) {
						return withPhase(
							await completeMediaVerification(database, claim, {
								decision: "REJECT",
								reasonCode: "UPLOAD_METADATA_MISMATCH",
								ruleVersion: claim.ruleVersion,
								checksum,
								storageEtag,
								storageVersionId,
								finalizedAt,
							}),
						);
					}
				}

				// SeeAPI's existing-task GET ignores the adapter interface's assetUrl.
				// New submissions and other adapters still receive a signed private URL.
				const retrieveExistingSeeapiTask =
					claim.provider === "seeapi" &&
					claim.mimeType.startsWith("image/") &&
					claim.providerTaskId !== null &&
					(verificationOptions.queryOnly === true || typeof safety.submitImage === "function") &&
					typeof safety.retrieveImage === "function";
				const assetUrl = retrieveExistingSeeapiTask
					? ""
					: await (options.createSignedReadUrl ?? createSignedReadUrl)({
							...location,
							expiresIn: 300,
						});
				if (!verifiedImmutableObject) {
					const persistedInspection = await database.mediaAsset.updateMany({
						where: {
							verificationEngine: "legacy",
							id: claim.assetId,
							status: "VERIFYING",
							verificationLeaseToken: claim.leaseToken,
							verificationGeneration: claim.generation,
							verificationLeasedUntil: { gt: new Date() },
						},
						data: { checksum, storageEtag, storageVersionId, finalizedAt },
					});
					if (persistedInspection.count !== 1) return withPhase({ outboxCommitted });
				}
				recordStage("prepared");
				moderationStarted = true;
				if (claim.processingDeadlineExpired) {
					outboxCommitted = await failMediaVerification(
						database,
						claim,
						"MODERATION_TIMEOUT",
						"ERROR",
						checksum,
					);
					return withPhase({ outboxCommitted });
				}
				// Poll/recover an uncertain detector submission without sending another paid inference.
				if (
					claim.mimeType.startsWith("image/") &&
					claim.submissionUncertain &&
					!claim.providerTaskId
				) {
					outboxCommitted = await failMediaVerification(
						database,
						claim,
						"MODERATION_SUBMISSION_UNCERTAIN",
						"ERROR",
						checksum,
					);
					return withPhase({ outboxCommitted });
				}
				let decision: ModerationDecision;
				const asyncImage =
					claim.mimeType.startsWith("image/") &&
					(verificationOptions.queryOnly === true || typeof safety.submitImage === "function") &&
					typeof safety.retrieveImage === "function";
				if (claim.mimeType.startsWith("image/") && !asyncImage) {
					if (!(await verificationPhaseMayCallProvider(claim, database)))
						return withPhase({ outboxCommitted: false, phaseOwnershipLost: true });
					detectorRequestInFlight = true;
					decision = await safety.moderateImage({ assetUrl, ruleVersion: claim.ruleVersion });
					detectorRequestInFlight = false;
					recordStage("moderation_result", { decision: decision.decision });
				} else {
					let providerTaskId = claim.providerTaskId;
					let completedDecision: ModerationDecision | undefined;
					let submittedPending = false;
					if (!providerTaskId) {
						if (verificationOptions.queryOnly)
							throw new Error("MODERATION_QUERY_ONLY_IDENTITY_MISSING");
						const submissionToken = await beginMediaVerificationSubmission(database, claim);
						if (!submissionToken) return withPhase({ outboxCommitted, phaseOwnershipLost: true });
						recordStage("submission_recorded");
						const callbackUrl =
							asyncImage && claim.provider === "seeapi"
								? imageModerationCallbackUrl(
										{ assetId: claim.assetId, generation: claim.generation, submissionToken },
										environment,
									)
								: undefined;
						detectorRequestInFlight = true;
						const submitted = await (
							asyncImage ? safety.submitImage!.bind(safety) : safety.submitVideo.bind(safety)
						)({
							assetUrl,
							ruleVersion: claim.ruleVersion,
							idempotencyKey: submissionToken,
							...(asyncImage && claim.provider === "seeapi" ? { callbackUrl } : {}),
						});
						detectorRequestInFlight = false;
						recordStage("moderation_submitted");
						await options.afterVideoSubmission?.(submitted);
						if (submitted.idempotency.key !== submissionToken) {
							outboxCommitted = await failUncertainMediaVerification(
								database,
								claim,
								"VIDEO_SUBMISSION_IDEMPOTENCY_MISMATCH",
								checksum,
								submitted.moderationTaskId,
							);
							return withPhase({ outboxCommitted });
						}
						providerTaskId = submitted.moderationTaskId;
						const binding = await bindMediaVerificationProviderTask(
							database,
							claim,
							providerTaskId,
							submissionToken,
						);
						if (binding === "LOST") {
							outboxCommitted = await failUncertainMediaVerification(
								database,
								claim,
								"VIDEO_SUBMISSION_RESULT_NOT_BOUND",
								checksum,
								providerTaskId,
							);
							return withPhase({ outboxCommitted });
						}
						if (binding === "BOUND_LEASE_EXPIRED") {
							return withPhase({ outboxCommitted, phaseOwnershipLost: true });
						}
						// An authenticated POST can already contain the complete verdict. Only
						// consume it after binding that exact task under the existing lease.
						if (asyncImage && submitted.completedDecision) {
							const verdict = submitted.completedDecision;
							completedDecision =
								verdict.ruleVersion === claim.ruleVersion &&
								(claim.provider !== "seeapi" ||
									(verdict.evidence?.seeapi?.taskId === providerTaskId &&
										verdict.evidence.requestId === providerTaskId))
									? verdict
									: {
											decision: "ERROR",
											reasonCode: "MODERATION_INVALID_RESPONSE",
											ruleVersion: claim.ruleVersion,
										};
						} else if (
							asyncImage &&
							claim.provider === "seeapi" &&
							callbackUrl &&
							submitted.ruleVersion === claim.ruleVersion &&
							(submitted.nonterminalState === "queued" ||
								submitted.nonterminalState === "processing")
						) {
							// The authenticated POST already proves PENDING. Persist it and
							// release this lease so an early callback can wake the same task.
							// Without callbacks/this explicit opt-in, retain immediate retrieval.
							submittedPending = true;
						}
					}
					if (completedDecision) {
						decision = completedDecision;
					} else if (submittedPending) {
						decision = {
							decision: "REVIEW",
							reasonCode: "IMAGE_PROCESSING",
							ruleVersion: claim.ruleVersion,
						};
					} else {
						const retrieval = { moderationTaskId: providerTaskId, ruleVersion: claim.ruleVersion };
						if (!(await verificationPhaseMayCallProvider(claim, database)))
							return withPhase({ outboxCommitted: false, phaseOwnershipLost: true });
						recordStage("retrieval_prepared", {
							nextAllowedQueryAt: claim.nextAllowedQueryAt?.getTime() ?? null,
							queryStartedAt: Date.now(),
							allowedQueryToStartMs: claim.nextAllowedQueryAt
								? Math.max(0, Date.now() - claim.nextAllowedQueryAt.getTime())
								: null,
						});
						detectorRequestInFlight = true;
						decision = asyncImage
							? await safety.retrieveImage!({ ...retrieval, assetUrl })
							: await safety.retrieveVideo(retrieval);
						detectorRequestInFlight = false;
					}
					recordStage("moderation_result", {
						decision: decision.decision,
						source: completedDecision || submittedPending ? "submission" : "retrieval",
					});
					if (
						decision.decision === "REVIEW" &&
						["VIDEO_PROCESSING", "IMAGE_PROCESSING"].includes(decision.reasonCode)
					) {
						const pending = await recordMediaVerificationWaitOrFailure(
							database,
							claim,
							decision.reasonCode,
							"PENDING",
							checksum,
						);
						recordStage("pending_committed");
						return withPhase(pending);
					}
				}
				if (decision.decision === "ERROR") {
					outboxCommitted = await failMediaVerification(
						database,
						claim,
						decision.reasonCode,
						"ERROR",
						checksum,
					);
					return withPhase({ outboxCommitted });
				}
				const completed = await completeMediaVerification(database, claim, {
					...decision,
					detectorCompleted: true,
					checksum,
					storageEtag,
					storageVersionId,
					finalizedAt,
				});
				recordStage("verdict_transaction_completed", { decision: decision.decision });
				return withPhase(completed);
			} catch (error) {
				options.onVerificationError?.(error);
				if (isDeterministicLegacyInspectionFailure(error)) {
					const inspected = await completeMediaVerification(database, claim, {
						decision: "REJECT",
						reasonCode: "UPLOAD_INSPECTION_FAILED",
						ruleVersion: claim.ruleVersion,
						checksum,
						storageEtag,
						storageVersionId,
						finalizedAt,
					});
					return withPhase(inspected);
				}
				if (detectorRequestInFlight && claim.mimeType.startsWith("image/")) {
					const message = moderationServiceErrorCode(error);
					const state = await database.mediaAsset.findUnique({
						where: { verificationEngine: "legacy", id: claim.assetId },
						select: { verificationSubmissionUncertain: true, verificationProviderTaskId: true },
					});
					outboxCommitted = await failMediaVerification(
						database,
						claim,
						["MODERATION_CONFIGURATION_ERROR", "MODERATION_INVALID_INPUT"].includes(message)
							? message
							: state?.verificationSubmissionUncertain && !state.verificationProviderTaskId
								? "MODERATION_SUBMISSION_UNCERTAIN"
								: isRetryableModerationError(message)
									? message
									: "MODERATION_UNAVAILABLE",
						"ERROR",
						checksum,
					);
					return withPhase({ outboxCommitted });
				}
				// Persistence failures are not detector outages and cannot consume the permission budget.
				if (moderationStarted && claim.mimeType.startsWith("image/")) throw error;
				outboxCommitted = await failMediaVerificationFromError(
					database,
					claim,
					verificationErrorCode(error),
					checksum,
				);
			} finally {
				recordStage("attempt_finished");
			}
			return withPhase({ outboxCommitted });
		},
	};
}

export async function appendVerificationEvidence(
	tx: Prisma.TransactionClient,
	input: {
		assetId: string;
		assetChecksum: string | null;
		verificationGeneration: number;
		attemptNumber: number;
		evidenceKind: "INPUT" | "OUTPUT";
		provider: string;
		providerTaskId: string | null;
		ruleVersion: string;
		policyVersion: string;
		status: "PENDING" | "APPROVED" | "BYPASSED" | "REJECTED" | "REVIEW" | "ERROR";
		reasonCode: string;
		rawEnvelope: Prisma.InputJsonValue;
		scores?: Record<string, number>;
		validUntil?: Date | null;
	},
): Promise<void> {
	// The immutable (asset, generation, attempt) key arbitrates duplicates atomically.
	// A different proof for the same attempt must never replace the first row.
	await tx.assetModerationResult.createMany({
		skipDuplicates: true,
		data: {
			assetId: input.assetId,
			assetChecksum:
				input.assetChecksum && /^[a-f0-9]{64}$/i.test(input.assetChecksum)
					? input.assetChecksum
					: null,
			verificationGeneration: input.verificationGeneration,
			attemptNumber: input.attemptNumber,
			evidenceKind: input.evidenceKind,
			provider: input.provider,
			providerTaskId: input.providerTaskId,
			ruleVersion: input.ruleVersion,
			policyVersion: input.policyVersion,
			status: input.status,
			reasonCode: input.reasonCode,
			categories: {
				reasonCode: input.reasonCode,
				...(input.scores ? { scores: input.scores } : {}),
			},
			rawEnvelope: input.rawEnvelope,
			validUntil: input.validUntil ?? null,
		},
	});
}

async function resolveJobsWaitingForMediaVerification(
	tx: Prisma.TransactionClient,
	input: {
		assetId: string;
		verificationGeneration: number;
		approved: boolean;
		failureCode?: string;
		outputReady?: {
			ownerType: "USER" | "ORGANIZATION";
			ownerId: string;
			notifications: MediaJobNotification[];
		};
		continuationEvents?: Array<{ id: string; availableAt: Date }>;
	},
): Promise<boolean> {
	let outboxCommitted = false;
	const enqueue = async (data: Prisma.OutboxEventCreateManyInput) => {
		const collector = input.continuationEvents;
		if (!collector) return tx.outboxEvent.createMany({ skipDuplicates: true, data });
		// Immediate events use PostgreSQL's clock default. Return that committed
		// time with the ID instead of replacing it with a possibly skewed host clock.
		const inserted = await tx.outboxEvent.createManyAndReturn({
			skipDuplicates: true,
			data: { ...data, id: crypto.randomUUID() },
			select: { id: true, availableAt: true },
		});
		if (inserted.length) collector.push(...inserted);
		else {
			// A dedupe conflict must return the actual durable row, not our unused ID.
			const existing = await tx.outboxEvent.findFirst({
				where: { dedupeKey: data.dedupeKey, status: { in: ["PENDING", "LEASED"] } },
				select: { id: true, availableAt: true },
			});
			if (existing) collector.push(existing);
		}
		return { count: inserted.length };
	};
	const bindings = await tx.generationJobAsset.findMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			assetId: input.assetId,
			OR: [
				{
					role: "INPUT",
					job: { status: { in: ["RESERVED", "DISPATCH_QUEUED"] } },
				},
				{
					role: "OUTPUT",
					job: input.outputReady
						? { ownerType: input.outputReady.ownerType, ownerId: input.outputReady.ownerId }
						: { status: "FINALIZING" },
				},
			],
		},
		include: { job: true },
		orderBy: [{ jobId: "asc" }, { role: "asc" }],
	});
	for (const binding of bindings) {
		if (binding.role === "OUTPUT") {
			if (input.outputReady) {
				input.outputReady.notifications.push(
					await recordMediaJobNotification(tx, {
						jobId: binding.jobId,
						revision: `asset:${input.assetId}:g${input.verificationGeneration}:ready`,
					}),
				);
				outboxCommitted = true;
			}
			if (binding.job.status !== "FINALIZING") continue;
			const completedFinalizationScan = await tx.outboxEvent.findUnique({
				where: { dedupeKey: `generation-settle:${binding.jobId}` },
				select: { id: true, status: true, availableAt: true },
			});
			if (
				completedFinalizationScan &&
				["PENDING", "LEASED"].includes(completedFinalizationScan.status)
			)
				input.continuationEvents?.push(completedFinalizationScan);
			if (!completedFinalizationScan) {
				if (
					input.approved &&
					getCatalogEntry(binding.job.productKey as ProductModelKey)?.mediaKind === "image" &&
					(await completePersistedImageFinalizationInTransaction(
						{
							job: binding.job,
							verification: {
								provider: imageModerationProviderForEnvironment(process.env),
								ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
								policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
								now: new Date(),
							},
							settlementEvents: input.continuationEvents,
						},
						tx,
					))
				) {
					outboxCommitted = true;
					continue;
				}
				// Async moderation can finish before the finalization retry is due.
				// Incomplete or historical outputs still need the full heavy scan.
				const dedupeKey = `generation-finalize-after-output-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`;
				const inserted = await enqueue({
					eventType: "GENERATION_FINALIZE_RETRY",
					aggregateType: "GENERATION_JOB",
					aggregateId: binding.jobId,
					dedupeKey,
					payload: { jobId: binding.jobId, version: binding.job.version },
				});
				outboxCommitted ||= inserted.count > 0;
				continue;
			}
			const inserted = await enqueue({
				eventType: "GENERATION_SETTLE",
				aggregateType: "GENERATION_JOB",
				aggregateId: binding.jobId,
				dedupeKey: `generation-settle-after-output-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
				payload: { jobId: binding.jobId, version: binding.job.version },
			});
			outboxCommitted ||= inserted.count > 0;
			continue;
		}
		if (input.approved) {
			const inserted = await enqueue({
				eventType: "GENERATION_DISPATCH",
				aggregateType: "GENERATION_JOB",
				aggregateId: binding.jobId,
				dedupeKey: `generation-dispatch-after-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
				payload: { jobId: binding.jobId, version: binding.job.version },
			});
			outboxCommitted ||= inserted.count > 0;
			continue;
		}
		const changed = await tx.generationJob.updateMany({
			where: {
				executionEngine: "legacy",
				id: binding.jobId,
				version: binding.job.version,
				status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
			},
			data: {
				status: "FINALIZING",
				failureCode: input.failureCode ?? "INPUT_REVERIFICATION_FAILED",
				version: { increment: 1 },
			},
		});
		if (changed.count !== 1) continue;
		const inserted = await enqueue({
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: binding.jobId,
			dedupeKey: `generation-settle-after-input-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
			payload: { jobId: binding.jobId, version: binding.job.version + 1 },
		});
		outboxCommitted ||= inserted.count > 0;
	}
	return outboxCommitted;
}

async function claimMediaVerification(
	database: PrismaClient,
	input: {
		assetId: string;
		provider: string;
		ruleVersion: string;
		policyVersion: string;
		allowQuarantinedReverification: boolean;
		queryOnly?: boolean;
		imageRetrievalSupported?: boolean;
		workflowId?: string;
		phaseOwner?: ImagePhaseOwner;
	},
): Promise<{
	claim: MediaVerificationClaim | null;
	outboxCommitted: boolean;
	phaseOwner?: ImagePhaseOwner;
	phaseOwnershipLost?: true;
}> {
	let outboxCommitted = false;
	let phaseOwner: ImagePhaseOwner | undefined;
	let phaseOwnershipLost: true | undefined;
	const claim = await database.$transaction<MediaVerificationClaim | null>(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`;
		// The same locked snapshot covers first submission and later queries.
		// Owner acquisition/renewal still reads the full row and fresh DB time;
		// identity changes below invalidate these generation-specific facts.
		let queryProjection = input.workflowId
			? await readMediaVerificationQueryProjection(input.assetId, tx)
			: undefined;
		let asset: MediaVerificationClaimAsset | null =
			queryProjection !== undefined
				? (queryProjection?.asset ?? null)
				: await tx.mediaAsset.findUnique({
						where: { verificationEngine: "legacy", id: input.assetId },
					});
		if (!asset) return null;
		phaseOwner = queryProjection
			? queryProjection.phaseOwner
			: await getImagePhaseOwner(
					{
						kind: "verification",
						assetId: asset.id,
						generation: Math.max(1, asset.verificationGeneration),
					},
					tx,
				);
		if (
			(phaseOwner && phaseOwner.workflowId !== input.workflowId) ||
			(input.phaseOwner &&
				(!phaseOwner ||
					!sameImagePhaseOwner(phaseOwner, input.phaseOwner) ||
					(asset.verificationProvider && asset.verificationProvider !== input.provider) ||
					(asset.verificationRuleVersion && asset.verificationRuleVersion !== input.ruleVersion) ||
					(asset.verificationPolicyVersion &&
						asset.verificationPolicyVersion !== input.policyVersion)))
		) {
			phaseOwnershipLost = true;
			return null;
		}
		// A result-only execution may never reset an old identity or claim a new
		// paid submission after its callback became stale. Recheck inside the lease lock.
		if (
			input.queryOnly &&
			(asset.status !== "VERIFYING" ||
				!asset.mimeType.startsWith("image/") ||
				!asset.verificationProviderTaskId ||
				asset.verificationSubmissionUncertain ||
				asset.verificationGeneration < 1 ||
				asset.verificationProvider !== input.provider ||
				asset.verificationRuleVersion !== input.ruleVersion ||
				asset.verificationPolicyVersion !== input.policyVersion ||
				!input.imageRetrievalSupported)
		)
			return null;
		if (asset.deletedAt !== null || asset.status === "DELETED") return null;
		if (asset.kind === "INPUT" && queryProjection?.hasAccountInputCopy !== false) {
			const copy = await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx);
			if (copy.terminal) {
				outboxCommitted = true;
				return null;
			}
		}
		// Retired provider attempts never become a fresh paid SeeAPI submission.
		// Preserve completed evidence as written; unfinished attempts stay held for review.
		if (asset.verificationProvider?.split("+").includes("sightengine")) {
			if (asset.status === "VERIFYING") {
				await tx.mediaAsset.updateMany({
					where: { verificationEngine: "legacy", id: asset.id, status: "VERIFYING" },
					data: {
						verificationLastErrorCode: "MODERATION_PROVIDER_RETIRED",
						verificationLeaseToken: null,
						verificationLeasedUntil: null,
						verificationNextAttemptAt: null,
					},
				});
			}
			return null;
		}
		// Transfer recovery owns incomplete outputs. Moderation must not consume its
		// retry budget or terminalize a placeholder while storage still owns it.
		if (
			asset.kind === "OUTPUT" &&
			(asset.outputTransferToken || !asset.finalizedAt || !asset.checksum || asset.byteSize <= 0n)
		) {
			return null;
		}
		const now = new Date();
		if (
			isTemporaryReferenceObjectKey(asset.objectKey) &&
			(!asset.deleteAfter || asset.deleteAfter <= now)
		) {
			// Preserve historical approvals/rejections when a late wake-up sees expiry.
			await tx.mediaAsset.updateMany({
				where: { verificationEngine: "legacy", id: asset.id, status: "VERIFYING" },
				data: {
					status: "VERIFICATION_FAILED",
					verificationLastErrorCode: "TEMPORARY_REFERENCE_EXPIRED",
					verificationNextAttemptAt: null,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
				},
			});
			outboxCommitted = await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: asset.verificationGeneration,
				approved: false,
				failureCode: "TEMPORARY_REFERENCE_EXPIRED",
			});
			return null;
		}
		if (
			asset.status === "READY" &&
			asset.deletedAt === null &&
			(asset.verificationPolicyVersion !== input.policyVersion ||
				asset.verificationValidUntil?.toISOString() !== IMAGE_APPROVAL_NO_TIME_EXPIRY)
		) {
			const evidence = await tx.assetModerationResult.findFirst({
				where: { assetId: asset.id },
				orderBy: [
					{ verificationGeneration: "desc" },
					{ attemptNumber: "desc" },
					{ createdAt: "desc" },
					{ id: "desc" },
				],
			});
			if (evidence && canReuseApprovedImageEvidence(asset, evidence, input)) {
				const generation = asset.verificationGeneration + 1;
				const validUntil = new Date(IMAGE_APPROVAL_NO_TIME_EXPIRY);
				await appendVerificationEvidence(tx, {
					assetId: asset.id,
					assetChecksum: asset.checksum,
					verificationGeneration: generation,
					attemptNumber: 1,
					evidenceKind: asset.kind,
					provider: input.provider,
					providerTaskId: asset.verificationProviderTaskId,
					ruleVersion: input.ruleVersion,
					policyVersion: input.policyVersion,
					status: "APPROVED",
					reasonCode: "CONTENT_AND_RULE_UNCHANGED",
					validUntil,
					rawEnvelope: {
						decision: "ALLOW",
						reusedEvidenceId: evidence.id,
						sourceRuleVersion: evidence.ruleVersion,
						sourcePolicyVersion: evidence.policyVersion,
					},
				});
				await tx.mediaAsset.update({
					where: { verificationEngine: "legacy", id: asset.id },
					data: {
						verificationGeneration: generation,
						verificationAttemptCount: 1,
						verificationPolicyVersion: input.policyVersion,
						verificationValidUntil: validUntil,
						verificationNextAttemptAt: null,
						verificationDeadlineAt: null,
					},
				});
				await tx.auditLog.create({
					data: {
						action: "MEDIA_ASSET_APPROVAL_REUSED",
						targetType: "MEDIA_ASSET",
						targetId: asset.id,
						before: {
							generation: asset.verificationGeneration,
							policyVersion: asset.verificationPolicyVersion,
						},
						after: { generation, policyVersion: input.policyVersion },
						metadata: { sourceEvidenceId: evidence.id, reason: "CONTENT_AND_RULE_UNCHANGED" },
					},
				});
				outboxCommitted = await resolveJobsWaitingForMediaVerification(tx, {
					assetId: asset.id,
					verificationGeneration: generation,
					approved: true,
				});
				return null;
			}
		}
		const hasLegacyReverificationMarker =
			!isTemporaryReferenceObjectKey(asset.objectKey) &&
			asset.status === "VERIFYING" &&
			(queryProjection?.hasLegacyReverificationMarker ??
				Boolean(
					await tx.auditLog.findFirst({
						where: {
							action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
							targetType: "MEDIA_ASSET",
							targetId: asset.id,
						},
						select: { id: true },
					}),
				));
		const isAuthorizedLegacyReverification =
			asset.status === "QUARANTINED" &&
			input.allowQuarantinedReverification &&
			asset.verificationLastErrorCode === "LEGACY_EVIDENCE_UNTRUSTED" &&
			asset.deletedAt === null;
		const isStaleReady =
			asset.status === "READY" &&
			asset.deletedAt === null &&
			(!asset.verificationValidUntil ||
				asset.verificationValidUntil <= now ||
				asset.verificationProvider !== input.provider ||
				asset.verificationRuleVersion !== input.ruleVersion ||
				asset.verificationPolicyVersion !== input.policyVersion);
		if (isAuthorizedLegacyReverification || isStaleReady) {
			const generation = Math.max(asset.verificationGeneration + 1, 1);
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					status: "VERIFYING",
					verificationGeneration: generation,
					verificationAttemptCount: 0,
					verificationProvider: null,
					verificationRuleVersion: null,
					verificationPolicyVersion: null,
					verificationProviderTaskId: null,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: null,
					verificationDeadlineAt: new Date(
						now.getTime() +
							(asset.mimeType.startsWith("image/")
								? MEDIA_VERIFICATION_RETRY_POLICY.imageDeadlineMs
								: MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs),
					),
					verificationExhaustedAt: null,
					verificationValidUntil: null,
					verificationSubmissionToken: null,
					verificationCallbackReceivedAt: null,
					verificationSubmissionUncertain: false,
					verificationSubmittedAt: null,
					verificationLastErrorCode: null,
				},
			});
			await tx.auditLog.create({
				data: {
					action: isAuthorizedLegacyReverification
						? "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED"
						: "MEDIA_ASSET_STALE_REVERIFICATION_STARTED",
					targetType: "MEDIA_ASSET",
					targetId: asset.id,
					before: { status: asset.status, generation: asset.verificationGeneration },
					after: { status: "VERIFYING", generation },
					metadata: {
						source: isAuthorizedLegacyReverification
							? "immutable-upload-migration"
							: "verification-recovery",
					},
				},
			});
			queryProjection = undefined;
			asset = await tx.mediaAsset.findUniqueOrThrow({
				where: { verificationEngine: "legacy", id: asset.id },
			});
		}
		if (asset.status !== "VERIFYING" || asset.deletedAt !== null) return null;
		if (asset.verificationLeasedUntil && asset.verificationLeasedUntil > now) return null;

		if (
			!asset.mimeType.startsWith("image/") &&
			asset.verificationSubmissionUncertain &&
			!asset.verificationProviderTaskId
		) {
			const attemptNumber = Math.max(asset.verificationAttemptCount, 1);
			await appendVerificationEvidence(tx, {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				attemptNumber,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider ?? input.provider,
				providerTaskId: null,
				ruleVersion: asset.verificationRuleVersion ?? input.ruleVersion,
				policyVersion: asset.verificationPolicyVersion ?? input.policyVersion,
				status: "ERROR",
				reasonCode: "VIDEO_SUBMISSION_UNCERTAIN_REQUIRES_REVIEW",
				rawEnvelope: { decision: "ERROR", submissionUncertain: true },
			});
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					status: "VERIFICATION_FAILED",
					verificationAttemptCount: attemptNumber,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: null,
					verificationExhaustedAt: now,
					verificationLastErrorCode: "VIDEO_SUBMISSION_UNCERTAIN_REQUIRES_REVIEW",
				},
			});
			outboxCommitted = await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				approved: false,
				failureCode: "ASSET_VERIFICATION_SUBMISSION_UNCERTAIN",
			});
			return null;
		}

		if (asset.verificationLeaseToken) {
			const attemptNumber = Math.max(asset.verificationAttemptCount, 1);
			await appendVerificationEvidence(tx, {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				attemptNumber,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider ?? input.provider,
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: asset.verificationRuleVersion ?? input.ruleVersion,
				policyVersion: asset.verificationPolicyVersion ?? input.policyVersion,
				status: "ERROR",
				reasonCode: "VERIFICATION_LEASE_EXPIRED",
				rawEnvelope: { decision: "ERROR", leaseExpired: true },
			});
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					verificationAttemptCount: attemptNumber,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationLastErrorCode: "VERIFICATION_LEASE_EXPIRED",
				},
			});
			// The transaction appended ERROR evidence; its earlier count is obsolete.
			queryProjection = undefined;
			asset = await tx.mediaAsset.findUniqueOrThrow({
				where: { verificationEngine: "legacy", id: asset.id },
			});
		}
		if (asset.verificationNextAttemptAt && asset.verificationNextAttemptAt > now) return null;

		if (
			(asset.verificationProvider && asset.verificationProvider !== input.provider) ||
			(asset.verificationRuleVersion && asset.verificationRuleVersion !== input.ruleVersion) ||
			(asset.verificationPolicyVersion && asset.verificationPolicyVersion !== input.policyVersion)
		) {
			const generation = Math.max(asset.verificationGeneration + 1, 1);
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					verificationGeneration: generation,
					verificationAttemptCount: 0,
					verificationProvider: null,
					verificationRuleVersion: null,
					verificationPolicyVersion: null,
					verificationProviderTaskId: null,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: null,
					verificationDeadlineAt: new Date(
						now.getTime() +
							(asset.mimeType.startsWith("image/")
								? MEDIA_VERIFICATION_RETRY_POLICY.imageDeadlineMs
								: MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs),
					),
					verificationExhaustedAt: null,
					verificationValidUntil: null,
					verificationSubmissionToken: null,
					verificationCallbackReceivedAt: null,
					verificationSubmissionUncertain: false,
					verificationSubmittedAt: null,
					verificationLastErrorCode: null,
				},
			});
			queryProjection = undefined;
			asset = await tx.mediaAsset.findUniqueOrThrow({
				where: { verificationEngine: "legacy", id: asset.id },
			});
		}

		const deadlineAt =
			asset.verificationDeadlineAt ??
			new Date(
				now.getTime() +
					(asset.mimeType.startsWith("image/")
						? MEDIA_VERIFICATION_RETRY_POLICY.imageDeadlineMs
						: MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs),
			);
		const processingDeadlineExpired =
			asset.mimeType.startsWith("image/") &&
			asset.verificationLastErrorCode === "IMAGE_PROCESSING" &&
			asset.verificationAttemptCount >= 3 &&
			deadlineAt <= now;
		const boundedImageRecovery =
			asset.mimeType.startsWith("image/") &&
			(asset.verificationLastErrorCode === "IMAGE_PROCESSING" ||
				isRetryableModerationError(asset.verificationLastErrorCode ?? ""));
		if (
			deadlineAt <= now &&
			(!boundedImageRecovery || isTemporaryReferenceObjectKey(asset.objectKey))
		) {
			const attemptNumber = asset.verificationAttemptCount + 1;
			await appendVerificationEvidence(tx, {
				assetId: asset.id,
				assetChecksum: asset.checksum,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				attemptNumber,
				evidenceKind: asset.kind,
				provider: asset.verificationProvider ?? input.provider,
				providerTaskId: asset.verificationProviderTaskId,
				ruleVersion: asset.verificationRuleVersion ?? input.ruleVersion,
				policyVersion: asset.verificationPolicyVersion ?? input.policyVersion,
				status: "ERROR",
				reasonCode: "VERIFICATION_DEADLINE_EXCEEDED",
				rawEnvelope: { decision: "ERROR", deadlineExceeded: true },
			});
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					status: "VERIFICATION_FAILED",
					verificationAttemptCount: attemptNumber,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: null,
					verificationDeadlineAt: deadlineAt,
					verificationExhaustedAt: now,
					verificationLastErrorCode: "VERIFICATION_DEADLINE_EXCEEDED",
				},
			});
			outboxCommitted = await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				approved: false,
				failureCode: "ASSET_VERIFICATION_DEADLINE_EXCEEDED",
			});
			if (asset.kind === "INPUT")
				outboxCommitted =
					(await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx))
						.terminal || outboxCommitted;
			return null;
		}

		const failureCount =
			queryProjection?.failureCount ??
			(await tx.assetModerationResult.count({
				where: {
					assetId: asset.id,
					verificationGeneration: Math.max(asset.verificationGeneration, 1),
					status: "ERROR",
				},
			}));
		if (failureCount >= MEDIA_VERIFICATION_RETRY_POLICY.maxTransientFailures) {
			await tx.mediaAsset.update({
				where: { verificationEngine: "legacy", id: asset.id },
				data: {
					status: "VERIFICATION_FAILED",
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationNextAttemptAt: null,
					verificationDeadlineAt: deadlineAt,
					verificationExhaustedAt: now,
					verificationLastErrorCode:
						asset.verificationLastErrorCode ?? "VERIFICATION_FAILURE_BUDGET_EXHAUSTED",
				},
			});
			outboxCommitted = await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				approved: false,
				failureCode: "ASSET_VERIFICATION_FAILED",
			});
			if (asset.kind === "INPUT")
				outboxCommitted =
					(await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx))
						.terminal || outboxCommitted;
			return null;
		}
		const generation = Math.max(asset.verificationGeneration, 1);
		const attemptNumber = asset.verificationAttemptCount + 1;
		const nextAllowedQueryAt = asset.verificationNextAttemptAt;
		if (input.workflowId) {
			const ownership = await claimImagePhaseOwnerInTransaction(
				{
					phase: { kind: "verification", assetId: asset.id, generation },
					workflowId: input.workflowId,
					expectedOwner: input.phaseOwner,
					businessLeasedUntil: asset.verificationLeasedUntil,
				},
				tx,
			);
			phaseOwner = ownership.phaseOwner;
			if (!ownership.owned) {
				phaseOwnershipLost = true;
				return null;
			}
		}
		const leaseToken = crypto.randomUUID();
		const claimed = await tx.mediaAsset.update({
			where: { verificationEngine: "legacy", id: asset.id },
			select: MEDIA_VERIFICATION_CLAIM_SELECT,
			data: {
				verificationGeneration: generation,
				verificationAttemptCount: attemptNumber,
				verificationProvider: input.provider,
				verificationRuleVersion: input.ruleVersion,
				verificationPolicyVersion: input.policyVersion,
				verificationLeaseToken: leaseToken,
				verificationLeasedUntil: new Date(now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.leaseMs),
				verificationNextAttemptAt: null,
				verificationDeadlineAt: deadlineAt,
				verificationExhaustedAt: null,
				verificationLastErrorCode: null,
			},
		});
		return {
			processingDeadlineExpired,
			...(phaseOwner ? { phaseOwner } : {}),
			nextAllowedQueryAt,
			startedAt: now,
			assetId: claimed.id,
			objectKey: claimed.objectKey,
			mimeType: claimed.mimeType,
			byteSize: claimed.byteSize,
			kind: claimed.kind,
			checksum: claimed.checksum,
			storageEtag: claimed.storageEtag,
			storageVersionId: claimed.storageVersionId,
			finalizedAt: claimed.finalizedAt,
			generation,
			attemptNumber,
			provider: input.provider,
			ruleVersion: input.ruleVersion,
			policyVersion: input.policyVersion,
			providerTaskId: claimed.verificationProviderTaskId,
			deadlineAt,
			submissionToken: claimed.verificationSubmissionToken,
			submissionUncertain: claimed.verificationSubmissionUncertain,
			callbackReceivedAt: claimed.verificationCallbackReceivedAt,
			forceObjectInspection: isAuthorizedLegacyReverification || hasLegacyReverificationMarker,
			leaseToken,
		};
	});
	return {
		claim,
		outboxCommitted,
		...(phaseOwner ? { phaseOwner } : {}),
		...(phaseOwnershipLost ? { phaseOwnershipLost } : {}),
	};
}

async function verificationPhaseIsCurrent(
	claim: MediaVerificationClaim,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const phase = {
		kind: "verification" as const,
		assetId: claim.assetId,
		generation: claim.generation,
	};
	return claim.phaseOwner
		? isImagePhaseOwnerCurrent(phase, claim.phaseOwner, tx)
		: !(await getImagePhaseOwner(phase, tx));
}

async function verificationPhaseMayCallProvider(
	claim: MediaVerificationClaim,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const [result] = await tx.$queryRaw<Array<{ current: boolean }>>`
	 SELECT EXISTS (SELECT 1 FROM "media_asset" asset
	 LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
	  AND owner."subjectId" = asset."id" AND owner."generation" = asset."verificationGeneration" AND owner."leasedUntil" > clock_timestamp()
	 WHERE asset."id" = ${claim.assetId} AND asset."verificationEngine" = 'legacy'
	  AND asset."status" = 'VERIFYING' AND asset."verificationGeneration" = ${claim.generation}
	  AND asset."verificationLeaseToken" = ${claim.leaseToken} AND asset."verificationLeasedUntil" > clock_timestamp()
	  AND ((${claim.phaseOwner?.phaseKey ?? null}::text IS NULL AND owner."phaseKey" IS NULL)
	   OR (owner."phaseKey" = ${claim.phaseOwner?.phaseKey ?? null} AND owner."workflowId" = ${claim.phaseOwner?.workflowId ?? null}
	    AND owner."epoch" = ${claim.phaseOwner?.epoch ?? null}::int))) AS "current"`;
	return result?.current === true;
}

async function beginMediaVerificationSubmission(
	database: PrismaClient,
	claim: MediaVerificationClaim,
): Promise<string | null> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		// Keep the lock in its own statement so this update sees changes committed
		// while waiting for it. No provider request starts before this commit.
		const now = new Date();
		const [asset] = await tx.$queryRaw<Array<{ verificationSubmissionToken: string }>>`
			UPDATE "media_asset" AS asset
			SET "verificationSubmissionToken" = COALESCE("verificationSubmissionToken", ${crypto.randomUUID()}),
				"verificationCallbackReceivedAt" = CASE
					WHEN "verificationSubmissionToken" IS NULL THEN NULL
					ELSE "verificationCallbackReceivedAt"
				END,
				"verificationSubmissionUncertain" = TRUE,
				"verificationSubmittedAt" = ${now},
				"updatedAt" = ${now}
			WHERE "verificationEngine" = 'legacy'
				AND "id" = ${claim.assetId}
				AND "status" = 'VERIFYING'
				AND "verificationGeneration" = ${claim.generation}
				AND "verificationLeaseToken" = ${claim.leaseToken}
				AND "verificationLeasedUntil" > ${now}
				AND "verificationProviderTaskId" IS NULL
				AND "verificationSubmissionUncertain" = FALSE
				AND EXISTS (SELECT 1 FROM (SELECT 1) anchor
					LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
					 AND owner."subjectId" = asset."id" AND owner."generation" = asset."verificationGeneration"
					 AND owner."leasedUntil" > clock_timestamp()
					WHERE ((${claim.phaseOwner?.phaseKey ?? null}::text IS NULL AND owner."phaseKey" IS NULL)
					 OR (owner."phaseKey" = ${claim.phaseOwner?.phaseKey ?? null}
					  AND owner."workflowId" = ${claim.phaseOwner?.workflowId ?? null}
					  AND owner."epoch" = ${claim.phaseOwner?.epoch ?? null}::int)))
			RETURNING "verificationSubmissionToken"
		`;
		return asset?.verificationSubmissionToken ?? null;
	});
}

async function bindMediaVerificationProviderTask(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	providerTaskId: string,
	submissionToken: string,
): Promise<"BOUND_ACTIVE" | "BOUND_LEASE_EXPIRED" | "LOST"> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		// A successful submission must remain recoverable even when its lease
		// expired during the external request; only retrieval requires a live lease.
		const [asset] = await tx.$queryRaw<
			Array<{ verificationLeasedUntil: Date | null; ownerCurrent: boolean }>
		>`
			UPDATE "media_asset" AS asset
			SET "verificationProviderTaskId" = ${providerTaskId},
				"verificationSubmissionUncertain" = FALSE,
				"updatedAt" = ${new Date()}
			WHERE "verificationEngine" = 'legacy'
				AND "id" = ${claim.assetId}
				AND "status" = 'VERIFYING'
				AND "verificationGeneration" = ${claim.generation}
				AND "verificationLeaseToken" = ${claim.leaseToken}
				AND "verificationSubmissionToken" = ${submissionToken}
				AND "verificationSubmissionUncertain" = TRUE
				AND ("verificationProviderTaskId" IS NULL OR "verificationProviderTaskId" = ${providerTaskId})
			RETURNING "verificationLeasedUntil",
				EXISTS (SELECT 1 FROM (SELECT 1) anchor
					LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'verification'
					 AND owner."subjectId" = asset."id" AND owner."generation" = asset."verificationGeneration"
					 AND owner."leasedUntil" > clock_timestamp()
					WHERE ((${claim.phaseOwner?.phaseKey ?? null}::text IS NULL AND owner."phaseKey" IS NULL)
					 OR (owner."phaseKey" = ${claim.phaseOwner?.phaseKey ?? null}
					  AND owner."workflowId" = ${claim.phaseOwner?.workflowId ?? null}
					  AND owner."epoch" = ${claim.phaseOwner?.epoch ?? null}::int))) AS "ownerCurrent"
		`;
		if (!asset) return "LOST";
		if (!asset.ownerCurrent) return "BOUND_LEASE_EXPIRED";
		return asset.verificationLeasedUntil && asset.verificationLeasedUntil > new Date()
			? "BOUND_ACTIVE"
			: "BOUND_LEASE_EXPIRED";
	});
}

async function completeMediaVerification(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	input: ModerationDecision & {
		detectorCompleted?: boolean;
		checksum: string | null;
		storageEtag: string | null;
		storageVersionId: string | null;
		finalizedAt: Date | null;
	},
): Promise<OutboxCommitResult> {
	if (!input.checksum || !/^[a-f0-9]{64}$/i.test(input.checksum)) {
		return {
			outboxCommitted: await failMediaVerification(
				database,
				claim,
				"CHECKSUM_UNAVAILABLE",
				"ERROR",
				null,
			),
		};
	}
	if (input.ruleVersion !== claim.ruleVersion) {
		return {
			outboxCommitted: await failMediaVerification(
				database,
				claim,
				"VERIFICATION_RULE_VERSION_MISMATCH",
				"ERROR",
				input.checksum,
			),
		};
	}
	const approvedChecksum = input.checksum;
	const notifications: MediaJobNotification[] = [];
	let committedStatus: "READY" | "QUARANTINED" | null = null;
	const completed = await database.$transaction<OutboxCommitResult>(async (tx) => {
		const promptRejected = await lockAssetPromptReview(claim.assetId, tx);
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		if (!claim.phaseOwner && !(await verificationPhaseIsCurrent(claim, tx)))
			return { outboxCommitted: false, phaseOwnershipLost: true };
		if (claim.kind === "OUTPUT") {
			// Transfer claim/record take the job row before its output asset/binding.
			// Match that order before committing the verdict or repairing positions.
			await tx.$queryRaw`
				SELECT job."id" FROM "generation_job" job
				WHERE job."executionEngine" = 'legacy' AND job."id" IN (
					SELECT binding."jobId" FROM "generation_job_asset" binding
					WHERE binding."assetId" = ${claim.assetId} AND binding."role" = 'OUTPUT'
				)
				ORDER BY job."id" FOR NO KEY UPDATE OF job
			`;
		}
		const now = new Date();
		const verdictProjection = claim.phaseOwner
			? await readMediaVerificationVerdictProjection(
					{
						assetId: claim.assetId,
						generation: claim.generation,
						leaseToken: claim.leaseToken,
						now,
						phaseOwner: claim.phaseOwner,
					},
					tx,
				)
			: undefined;
		if (verdictProjection?.phaseOwnerCurrent === false)
			return { outboxCommitted: false, phaseOwnershipLost: true };
		const asset =
			verdictProjection !== undefined
				? (verdictProjection?.asset ?? null)
				: await tx.mediaAsset.findFirst({
						where: {
							verificationEngine: "legacy",
							id: claim.assetId,
							status: "VERIFYING",
							verificationGeneration: claim.generation,
							verificationLeaseToken: claim.leaseToken,
							verificationLeasedUntil: { gt: now },
						},
					});
		if (!asset) return { outboxCommitted: false };
		// Copy targets and their immutable pointer are created in one transaction;
		// existing ordinary assets never acquire a copy pointer later. Reuse only
		// this locked transaction's negative fact; positive/legacy paths still reconcile.
		const needsCopyReconciliation =
			asset.kind === "INPUT" && verdictProjection?.hasAccountInputCopy !== false;
		if (
			needsCopyReconciliation &&
			(await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx)).terminal
		)
			return { outboxCommitted: true };
		if (promptRejected)
			input = { ...input, decision: "REJECT", reasonCode: "ADMIN_CONTENT_REJECTED" };
		const status =
			input.decision === "ALLOW" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "REVIEW";
		if (asset.mimeType.startsWith("image/") && input.detectorCompleted) {
			const failures =
				verdictProjection?.failureCount ??
				(await tx.assetModerationResult.count({
					where: { assetId: asset.id, verificationGeneration: claim.generation, status: "ERROR" },
				}));
			const previous = verdictProjection
				? verdictProjection.previousReview
				: await tx.moderationReview.findUnique({
						where: { targetType_targetId: { targetType: "ASSET", targetId: asset.id } },
					});
			await recordLockedAssetModerationOutcome(
				{
					targetType: "ASSET",
					targetId: asset.id,
					provider: claim.provider,
					stage: "IMAGE",
					epoch: String(claim.generation),
					failures,
					lastErrorCode:
						input.decision === "REVIEW"
							? "CONTENT_REVIEW_REQUIRED"
							: (previous?.lastErrorCode ?? ""),
					startedAt: claim.startedAt,
					lastFailureAt: previous?.lastFailureAt ?? now,
					status:
						input.decision === "ALLOW"
							? "APPROVED"
							: input.decision === "REVIEW"
								? "BLOCKED"
								: "REJECTED",
					serviceResponded: true,
					detectorCompleted: true,
				},
				previous,
				tx,
			);
		} else if (asset.mimeType.startsWith("image/")) {
			await tx.moderationReview.updateMany({
				where: { targetType: "ASSET", targetId: asset.id, status: "RECHECKING", resolvedBy: null },
				data: { status: "BLOCKED", lastErrorCode: input.reasonCode, version: { increment: 1 } },
			});
		}
		const verificationValidUntil =
			input.decision === "ALLOW"
				? asset.mimeType.startsWith("image/")
					? new Date(IMAGE_APPROVAL_NO_TIME_EXPIRY)
					: new Date(now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.evidenceTtlMs)
				: null;
		await appendVerificationEvidence(tx, {
			assetId: asset.id,
			assetChecksum: approvedChecksum,
			verificationGeneration: claim.generation,
			attemptNumber: claim.attemptNumber,
			evidenceKind: asset.kind,
			provider: claim.provider,
			providerTaskId: asset.verificationProviderTaskId,
			ruleVersion: claim.ruleVersion,
			policyVersion: claim.policyVersion,
			status,
			reasonCode: input.reasonCode,
			rawEnvelope: {
				decision: input.decision,
				...(input.evidence ? { evidence: input.evidence } : {}),
			},
			scores: input.evidence?.scores,
			validUntil: verificationValidUntil,
		});
		await tx.mediaAsset.update({
			where: { verificationEngine: "legacy", id: asset.id },
			data: {
				status: input.decision === "ALLOW" ? "READY" : "QUARANTINED",
				checksum: approvedChecksum,
				storageEtag: input.storageEtag,
				storageVersionId: input.storageVersionId,
				finalizedAt: input.finalizedAt ?? new Date(),
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationExhaustedAt: null,
				verificationValidUntil,
				verificationSubmissionUncertain: false,
				verificationLastErrorCode: input.decision === "ALLOW" ? null : input.reasonCode,
			},
		});
		committedStatus = input.decision === "ALLOW" ? "READY" : "QUARANTINED";
		const copyTerminal =
			needsCopyReconciliation &&
			(await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx)).terminal;
		const continuationEvents: Array<{ id: string; availableAt: Date }> = [];
		const jobsCommitted = await resolveJobsWaitingForMediaVerification(tx, {
			assetId: asset.id,
			verificationGeneration: claim.generation,
			continuationEvents,
			approved: input.decision === "ALLOW",
			...(process.env.MEDIA_JOB_EVENTS_ENABLED === "true" &&
			asset.kind === "OUTPUT" &&
			asset.mimeType.startsWith("image/") &&
			input.decision === "ALLOW"
				? { outputReady: { ownerType: asset.ownerType, ownerId: asset.ownerId, notifications } }
				: {}),
			failureCode:
				input.decision === "REJECT"
					? "INPUT_REVERIFICATION_REJECTED"
					: "INPUT_REVERIFICATION_REVIEW_REQUIRED",
		});
		const eventIds = [
			...new Set(
				continuationEvents
					.sort(
						(left, right) =>
							left.availableAt.getTime() - right.availableAt.getTime() ||
							left.id.localeCompare(right.id),
					)
					.map(({ id }) => id),
			),
		].slice(0, 100);
		return {
			outboxCommitted: copyTerminal || jobsCommitted,
			...(!copyTerminal
				? {
						verificationCommit: {
							assetId: asset.id,
							generation: claim.generation,
							status: committedStatus,
							eventIds,
						},
					}
				: {}),
		};
	});
	if (committedStatus) {
		console.info("media.upload.verification", {
			assetId: claim.assetId,
			generation: claim.generation,
			stage: "verdict_committed",
			at: Date.now(),
			status: committedStatus,
		});
	}
	await publishCommittedMediaJobNotifications(notifications, database);
	return completed;
}

async function failMediaVerification(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	status: "PENDING" | "ERROR",
	checksum: string | null,
): Promise<boolean> {
	return (await recordMediaVerificationWaitOrFailure(database, claim, reasonCode, status, checksum))
		.outboxCommitted;
}

async function recordMediaVerificationWaitOrFailure(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	status: "PENDING" | "ERROR",
	checksum: string | null,
): Promise<OutboxCommitResult> {
	return database.$transaction(async (tx) => {
		await lockAssetPromptReview(claim.assetId, tx);
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		if (!(await verificationPhaseIsCurrent(claim, tx)))
			return { outboxCommitted: false, phaseOwnershipLost: true };
		const now = new Date();
		const asset = await tx.mediaAsset.findFirst({
			where: {
				verificationEngine: "legacy",
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationLeaseToken: claim.leaseToken,
				verificationLeasedUntil: { gt: now },
			},
		});
		if (!asset) return { outboxCommitted: false };
		if (
			asset.kind === "INPUT" &&
			(await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx)).terminal
		)
			return { outboxCommitted: true };
		await appendVerificationEvidence(tx, {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: claim.generation,
			attemptNumber: claim.attemptNumber,
			evidenceKind: asset.kind,
			provider: claim.provider,
			providerTaskId: asset.verificationProviderTaskId,
			ruleVersion: claim.ruleVersion,
			policyVersion: claim.policyVersion,
			status,
			reasonCode,
			rawEnvelope: { decision: status },
		});
		const totalFailureCount =
			status === "ERROR"
				? await tx.assetModerationResult.count({
						where: {
							assetId: asset.id,
							verificationGeneration: claim.generation,
							status: "ERROR",
						},
					})
				: 0;
		let failureCount =
			status === "ERROR"
				? await tx.assetModerationResult.count({
						where: {
							assetId: asset.id,
							verificationGeneration: claim.generation,
							status: "ERROR",
							reasonCode: { in: [...MODERATION_RETRYABLE_ERROR_CODES] },
						},
					})
				: 0;
		if (status === "ERROR" && claim.processingDeadlineExpired)
			failureCount += await tx.assetModerationResult.count({
				where: {
					assetId: asset.id,
					verificationGeneration: claim.generation,
					status: "PENDING",
					reasonCode: "IMAGE_PROCESSING",
				},
			});
		const imageRecovery =
			asset.mimeType.startsWith("image/") &&
			(reasonCode === "IMAGE_PROCESSING" || isRetryableModerationError(reasonCode));
		const exhausted =
			(isTemporaryReferenceObjectKey(asset.objectKey) && claim.deadlineAt <= now) ||
			(status === "ERROR" &&
				[
					"MODERATION_CONFIGURATION_ERROR",
					"MODERATION_INVALID_INPUT",
					"MODERATION_MEDIA_INVALID",
				].includes(reasonCode)) ||
			(!imageRecovery && claim.deadlineAt <= now) ||
			(status === "ERROR" &&
				(imageRecovery ? failureCount : totalFailureCount) >=
					MEDIA_VERIFICATION_RETRY_POLICY.maxTransientFailures);
		if (
			status === "ERROR" &&
			asset.mimeType.startsWith("image/") &&
			(isRetryableModerationError(reasonCode) ||
				[
					"MODERATION_CONFIGURATION_ERROR",
					"MODERATION_INVALID_INPUT",
					"MODERATION_MEDIA_INVALID",
				].includes(reasonCode))
		) {
			await recordModerationOutcome(
				{
					targetType: "ASSET",
					targetId: asset.id,
					provider: claim.provider,
					stage: "IMAGE",
					epoch: String(claim.generation),
					failures: imageRecovery ? failureCount : totalFailureCount,
					lastErrorCode: reasonCode,
					startedAt: now,
					lastFailureAt: now,
					status: exhausted ? "BLOCKED" : "RETRYING",
					bypassed: false,
				},
				tx,
			);
		}
		const normalRetryAt = exhausted
			? null
			: status === "PENDING"
				? new Date(
						now.getTime() +
							(asset.mimeType.startsWith("image/")
								? MEDIA_VERIFICATION_RETRY_POLICY.imageProcessingPollMs
								: MEDIA_VERIFICATION_RETRY_POLICY.processingPollMs),
					)
				: new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.max(failureCount - 1, 0)));
		const retryAt = imageModerationRetryAt({
			retryAt: normalRetryAt,
			now,
			callbackReceivedAt: asset.verificationCallbackReceivedAt,
			claimedCallbackReceivedAt: claim.callbackReceivedAt,
			providerTaskId: asset.verificationProviderTaskId,
			submissionUncertain: asset.verificationSubmissionUncertain,
			pending: status === "PENDING" && asset.mimeType.startsWith("image/"),
		});
		await tx.mediaAsset.update({
			where: { verificationEngine: "legacy", id: asset.id },
			data: {
				status: exhausted ? "VERIFICATION_FAILED" : "VERIFYING",
				...([
					"MODERATION_CONFIGURATION_ERROR",
					"MODERATION_INVALID_INPUT",
					"MODERATION_MEDIA_INVALID",
				].includes(reasonCode)
					? {
							verificationSubmissionUncertain: false,
							verificationSubmissionToken: null,
							verificationCallbackReceivedAt: null,
						}
					: {}),
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: retryAt,
				verificationExhaustedAt: exhausted ? now : null,
				verificationLastErrorCode: reasonCode,
			},
		});
		let outboxCommitted = false;
		if (exhausted) {
			if (asset.kind === "INPUT")
				outboxCommitted = (
					await reconcileAccountInputCopyTargetInTransaction({ assetId: asset.id }, tx)
				).terminal;
			const jobsCommitted = await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: claim.generation,
				approved: false,
				failureCode:
					claim.deadlineAt <= now
						? "INPUT_REVERIFICATION_DEADLINE_EXCEEDED"
						: "INPUT_REVERIFICATION_FAILED",
			});
			outboxCommitted ||= jobsCommitted;
		}
		if (retryAt) {
			const pendingImage = status === "PENDING" && asset.mimeType.startsWith("image/");
			const queryOnly =
				pendingImage && asset.verificationProviderTaskId && !asset.verificationSubmissionUncertain
					? { queryOnly: true as const }
					: {};
			// One active polling continuation per verification generation. Scheduled
			// recovery can retry its delivery without creating a Workflow on every poll.
			const dedupeKey = pendingImage
				? `media-asset-verify:${asset.id}:g${claim.generation}:poll`
				: `media-asset-verify:${asset.id}:g${claim.generation}:a${claim.attemptNumber + 1}`;
			const eventId = crypto.randomUUID();
			const inserted = await tx.outboxEvent.createMany({
				skipDuplicates: true,
				data: {
					id: eventId,
					eventType: "MEDIA_ASSET_VERIFY",
					aggregateType: "MEDIA_ASSET",
					aggregateId: asset.id,
					dedupeKey,
					payload: {
						assetId: asset.id,
						...(pendingImage && asset.kind === "OUTPUT" ? { originalDueAt: now.getTime() } : {}),
					},
					// The same event supports targeted delivery and scheduled recovery.
					// The asset's due time/lease throttles reads independently of delivery.
					// Immediate polling intent uses the DB default; real backoff stays explicit.
					...(pendingImage ? {} : { availableAt: retryAt }),
				},
			});
			outboxCommitted ||= pendingImage && inserted.count > 0;
			if (pendingImage && asset.kind === "OUTPUT" && asset.verificationProviderTaskId) {
				// The successful insert already proves the committed identity. On dedupe,
				// use the stored row so targeted delivery and recovery share the same event.
				const outputReviewEventId =
					inserted.count > 0
						? eventId
						: (
								await tx.outboxEvent.findUniqueOrThrow({
									where: { dedupeKey },
									select: { id: true },
								})
							).id;
				return { outboxCommitted, outputReviewEventId, ...queryOnly };
			}
			return { outboxCommitted, ...queryOnly };
		}
		return { outboxCommitted };
	});
}

async function failMediaVerificationFromError(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	checksum: string | null,
): Promise<boolean> {
	const current = await database.mediaAsset.findUnique({
		where: { verificationEngine: "legacy", id: claim.assetId },
		select: {
			verificationGeneration: true,
			verificationProviderTaskId: true,
			verificationSubmissionUncertain: true,
		},
	});
	if (
		current?.verificationGeneration === claim.generation &&
		current.verificationSubmissionUncertain &&
		!current.verificationProviderTaskId
	) {
		return failUncertainMediaVerification(
			database,
			claim,
			"VIDEO_SUBMISSION_UNCERTAIN_REQUIRES_REVIEW",
			checksum,
			null,
		);
	}
	return failMediaVerification(database, claim, reasonCode, "ERROR", checksum);
}

async function failUncertainMediaVerification(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	checksum: string | null,
	providerTaskId: string | null,
): Promise<boolean> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		if (!(await verificationPhaseIsCurrent(claim, tx))) return false;
		const asset = await tx.mediaAsset.findFirst({
			where: {
				verificationEngine: "legacy",
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationSubmissionUncertain: true,
			},
		});
		if (!asset) return false;
		await appendVerificationEvidence(tx, {
			assetId: asset.id,
			assetChecksum: checksum,
			verificationGeneration: claim.generation,
			attemptNumber: claim.attemptNumber,
			evidenceKind: asset.kind,
			provider: claim.provider,
			providerTaskId,
			ruleVersion: claim.ruleVersion,
			policyVersion: claim.policyVersion,
			status: "ERROR",
			reasonCode,
			rawEnvelope: { decision: "ERROR", submissionUncertain: true },
		});
		const now = new Date();
		await tx.mediaAsset.update({
			where: { verificationEngine: "legacy", id: asset.id },
			data: {
				status: "VERIFICATION_FAILED",
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationExhaustedAt: now,
				verificationLastErrorCode: reasonCode,
			},
		});
		return resolveJobsWaitingForMediaVerification(tx, {
			assetId: asset.id,
			verificationGeneration: claim.generation,
			approved: false,
			failureCode: "ASSET_VERIFICATION_SUBMISSION_UNCERTAIN",
		});
	});
}

function verificationErrorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code)) return code;
	}
	return "VERIFICATION_TRANSIENT";
}

function isDeterministicLegacyInspectionFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as {
		name?: unknown;
		message?: unknown;
		$metadata?: { httpStatusCode?: unknown };
	};
	if (details.name === "NoSuchKey" || details.$metadata?.httpStatusCode === 404) return true;
	const message = typeof details.message === "string" ? details.message : "";
	return /^(Stored object|Final object checksum mismatch)/.test(message);
}

export const databaseVerifyUploadDependencies = createDatabaseVerifyUploadDependencies(db);

interface SettlementOutputBindingSnapshot {
	assetChecksum: string;
	asset: {
		id: string;
		verificationEngine?: string;
		mimeType: string;
		kind: "INPUT" | "OUTPUT";
		status: MediaAssetStatus;
		checksum: string | null;
		deletedAt: Date | null;
		verificationGeneration: number;
		verificationAttemptCount: number;
		verificationProvider: string | null;
		verificationRuleVersion: string | null;
		verificationPolicyVersion: string | null;
		verificationProviderTaskId: string | null;
		verificationValidUntil: Date | null;
		verificationLastErrorCode: string | null;
		moderationResults: Array<{
			assetChecksum: string | null;
			verificationGeneration: number;
			attemptNumber: number;
			evidenceKind: "INPUT" | "OUTPUT";
			provider: string;
			providerTaskId: string | null;
			ruleVersion: string;
			policyVersion: string;
			status: ModerationStatus;
			reasonCode: string;
			validUntil: Date | null;
		}>;
	};
}

function evaluateSettlementOutputs(
	bindings: SettlementOutputBindingSnapshot[],
	now: Date,
	moderationProvider: string,
): {
	readyOutputCount: number;
	contentRejectedOutputCount: number;
	waitingForVerification: boolean;
} {
	let readyOutputCount = 0;
	let contentRejectedOutputCount = 0;
	let waitingForVerification = false;
	for (const binding of bindings) {
		const asset = binding.asset;
		if (asset.status === "UPLOADING" || asset.status === "VERIFYING") {
			waitingForVerification = true;
			continue;
		}
		if (
			asset.status === "QUARANTINED" &&
			asset.verificationLastErrorCode === "LEGACY_EVIDENCE_UNTRUSTED"
		) {
			waitingForVerification = true;
			continue;
		}
		const evidence = asset.moderationResults[0];
		const historicalContentRejection =
			moderationProvider === "seeapi" &&
			(asset.verificationEngine ?? "legacy") === "legacy" &&
			asset.status === "QUARANTINED" &&
			asset.mimeType.startsWith("image/") &&
			isHistoricalImageModerationProvider(asset.verificationProvider) &&
			isImageContentRejection(evidence);
		const matchingEvidence =
			asset.deletedAt === null &&
			asset.kind === "OUTPUT" &&
			Boolean(asset.checksum) &&
			binding.assetChecksum === asset.checksum &&
			(asset.verificationProvider === moderationProvider || historicalContentRejection) &&
			asset.verificationRuleVersion === MEDIA_VERIFICATION_RULE_VERSION &&
			asset.verificationPolicyVersion === MEDIA_VERIFICATION_POLICY_VERSION &&
			evidence?.assetChecksum === asset.checksum &&
			evidence.verificationGeneration === asset.verificationGeneration &&
			evidence.attemptNumber === asset.verificationAttemptCount &&
			evidence.evidenceKind === asset.kind &&
			evidence.provider === asset.verificationProvider &&
			evidence.providerTaskId === asset.verificationProviderTaskId &&
			evidence.ruleVersion === asset.verificationRuleVersion &&
			evidence.policyVersion === asset.verificationPolicyVersion;
		if (asset.status === "QUARANTINED" && matchingEvidence && isImageContentRejection(evidence)) {
			contentRejectedOutputCount += 1;
		}
		if (asset.status !== "READY") continue;
		const authorized =
			binding.assetChecksum === asset.checksum &&
			hasCurrentApprovedMediaAssetEvidence(asset, {
				provider: moderationProvider,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				now,
			});
		if (authorized) readyOutputCount += 1;
		else waitingForVerification = true;
	}
	return { readyOutputCount, contentRejectedOutputCount, waitingForVerification };
}

interface SettlementPolicy {
	unitCredits: bigint;
	requestedOutputCount: number;
	maxCharge: bigint;
}

function settlementPolicyFromSnapshot(
	pricingSnapshot: unknown,
	reservedCredits: bigint,
): SettlementPolicy {
	if (!pricingSnapshot || typeof pricingSnapshot !== "object" || Array.isArray(pricingSnapshot)) {
		throw new Error("INVALID_SETTLEMENT_POLICY");
	}
	const candidate = (pricingSnapshot as Record<string, unknown>).settlementPolicy;
	if (candidate === undefined) return legacySettlementPolicy(reservedCredits);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
		throw new Error("INVALID_SETTLEMENT_POLICY");
	}
	const policy = candidate as Record<string, unknown>;
	const unitCredits = parsePositiveCreditAmount(policy.unitCredits);
	const maxCharge = parsePositiveCreditAmount(policy.maxCharge);
	const requestedOutputCount = policy.requestedOutputCount;
	if (
		unitCredits === null ||
		maxCharge === null ||
		typeof requestedOutputCount !== "number" ||
		!Number.isSafeInteger(requestedOutputCount) ||
		requestedOutputCount < 1 ||
		requestedOutputCount > 100 ||
		maxCharge !== reservedCredits ||
		unitCredits > maxCharge ||
		unitCredits * BigInt(requestedOutputCount) < maxCharge
	) {
		throw new Error("INVALID_SETTLEMENT_POLICY");
	}
	return { unitCredits, requestedOutputCount, maxCharge };
}

function legacySettlementPolicy(reservedCredits: bigint): SettlementPolicy {
	return { unitCredits: reservedCredits, requestedOutputCount: 1, maxCharge: reservedCredits };
}

function parsePositiveCreditAmount(value: unknown): bigint | null {
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function confirmedTechnicalFailureCode(snapshot: ProviderTaskSnapshot, result: NormalizedResult) {
	return snapshot.status === "FAILED" &&
		result.outputs.length === 0 &&
		isTechnicalGenerationFailureCode(result.confirmedTechnicalFailure)
		? result.confirmedTechnicalFailure
		: null;
}

function settlementFailureCode(failureCode: string | null): string {
	return isTechnicalGenerationFailureCode(failureCode) ||
		failureCode === "SUBMISSION_REJECTED_CONFIRMED" ||
		failureCode === KIE_ZERO_COST_REJECTION_CODE ||
		failureCode === GUEST_OUTPUT_CARDINALITY_INVALID_CODE
		? failureCode
		: "NO_USABLE_OUTPUT";
}

function calculateSettlementCharge(input: {
	status: string;
	failureCode: string | null;
	readyOutputCount: number;
	reservedCredits: bigint;
	pricingSnapshot: unknown;
}): bigint {
	const policy = settlementPolicyFromSnapshot(input.pricingSnapshot, input.reservedCredits);
	if (
		input.status === "CANCELED" ||
		input.failureCode === "SUBMISSION_REJECTED_CONFIRMED" ||
		input.readyOutputCount === 0
	) {
		return 0n;
	}
	const approvedUnits = Math.min(input.readyOutputCount, policy.requestedOutputCount);
	const unitCharge = policy.unitCredits * BigInt(approvedUnits);
	return unitCharge < policy.maxCharge ? unitCharge : policy.maxCharge;
}

const settlementOutputInclude = {
	where: { role: "OUTPUT" as const },
	include: {
		asset: {
			include: {
				moderationResults: {
					orderBy: [
						{ verificationGeneration: "desc" as const },
						{ attemptNumber: "desc" as const },
						{ createdAt: "desc" as const },
						{ id: "desc" as const },
					],
					take: 1,
				},
			},
		},
	},
};

function assertImagePassSettlementCardinality(
	reservation: { fundingSource: string; status: string },
	outputCount: number,
	readyOutputCount: number,
): void {
	if (reservation.fundingSource !== "IMAGE_PASS") return;
	if (readyOutputCount > 0 && (outputCount !== 1 || readyOutputCount !== 1)) {
		throw new Error("IMAGE_PASS_OUTPUT_CARDINALITY_INVALID");
	}
	if (reservation.status === "RELEASED" && readyOutputCount > 0) {
		throw new Error("IMAGE_PASS_OUTCOME_CONFLICT");
	}
}

function assertGenerationFundingBinding(
	job: { fundingSource?: string; creditsReserved: bigint },
	reservation: { fundingSource: string },
): void {
	if (
		(job.fundingSource ?? "CREDITS") !== reservation.fundingSource ||
		(reservation.fundingSource === "IMAGE_PASS" && job.creditsReserved !== 0n)
	) {
		throw new Error("GENERATION_FUNDING_CONFLICT");
	}
}

function fundingReservationAuditMetadata(
	reservation: { id: string; amount: bigint; fundingSource: string },
	frozen = false,
) {
	return reservation.fundingSource === "IMAGE_PASS"
		? {
				reservationId: reservation.id,
				fundingSource: "IMAGE_PASS",
				imagePassUnitsReserved: reservation.amount.toString(),
				...(frozen ? { imagePassFrozen: true } : {}),
			}
		: {
				reservationId: reservation.id,
				reservedCredits: reservation.amount.toString(),
				...(frozen ? { creditsFrozen: true } : {}),
			};
}

async function fenceSettlementOutputVersions(tx: Prisma.TransactionClient, assetIds: string[]) {
	if (assetIds.length === 0) return;
	// SSI runs this last so a row changed after its snapshot raises 40001. The
	// fresh-read path instead reads every decision field after taking these locks.
	// NOWAIT avoids an account -> asset wait against guest cleanup's inverse order.
	const rows = await tx.$queryRaw<Array<{ id: string }>>`
		SELECT "id" FROM "media_asset" WHERE "id" = ANY(${assetIds}::text[])
		ORDER BY "id" FOR UPDATE NOWAIT
	`;
	const actualIds = new Set(rows.map(({ id }) => id));
	if (rows.length !== assetIds.length || assetIds.some((id) => !actualIds.has(id)))
		throw new Error("SETTLEMENT_OUTPUT_FENCE_LOST");
}

class SettlementFreshReadConflictError extends Error {
	readonly code = "SETTLEMENT_FRESH_READ_CONFLICT" as const;

	constructor(readonly reason: "OUTPUT_BINDINGS_CHANGED" | "FUNDING_CHANGED" | "JOB_CHANGED") {
		super(`Settlement read set changed: ${reason}`);
		this.name = "SettlementFreshReadConflictError";
	}
}

function isSettlementFreshReadEnabled(): boolean {
	return process.env.MEDIA_SETTLEMENT_FRESH_READ_ENABLED === "true";
}

function sameSettlementBindings(
	left: Array<{ assetId: string; assetChecksum: string }>,
	right: Array<{ assetId: string; assetChecksum: string }>,
): boolean {
	if (left.length !== right.length) return false;
	const expected = new Map(left.map((binding) => [binding.assetId, binding.assetChecksum]));
	return (
		expected.size === left.length &&
		new Set(right.map(({ assetId }) => assetId)).size === right.length &&
		right.every((binding) => expected.get(binding.assetId) === binding.assetChecksum)
	);
}

type SettlementCreditJob = Pick<
	Prisma.GenerationJobGetPayload<{ include: { reservation: true } }>,
	| "id"
	| "status"
	| "guestTrialId"
	| "serviceClass"
	| "failureCode"
	| "pricingSnapshot"
	| "creditsReserved"
	| "reservation"
>;

async function settleLockedGenerationCredits(
	tx: Prisma.TransactionClient,
	job: SettlementCreditJob,
	outputState: ReturnType<typeof evaluateSettlementOutputs>,
): Promise<string | undefined> {
	if (!job.reservation) throw new Error("GENERATION_FUNDING_CONFLICT");
	let chargeCredits = calculateSettlementCharge({
		status: job.status,
		failureCode: job.failureCode,
		readyOutputCount: outputState.readyOutputCount,
		reservedCredits: job.creditsReserved,
		pricingSnapshot: job.pricingSnapshot,
	});
	let moderationFailureCode: string | undefined;
	if (
		job.status === "FINALIZING" &&
		!job.guestTrialId &&
		job.serviceClass !== "GUEST_SLOW" &&
		job.failureCode !== "SUBMISSION_REJECTED_CONFIRMED" &&
		outputState.readyOutputCount === 0 &&
		outputState.contentRejectedOutputCount > 0 &&
		job.pricingSnapshot &&
		typeof job.pricingSnapshot === "object" &&
		!Array.isArray(job.pricingSnapshot) &&
		job.pricingSnapshot.outputModerationBillingPolicy === OUTPUT_MODERATION_BILLING_POLICY
	) {
		const waived = await claimOutputModerationGraceInTransaction(
			{ accountId: job.reservation.accountId, jobId: job.id },
			tx,
		);
		chargeCredits = waived
			? 0n
			: settlementPolicyFromSnapshot(job.pricingSnapshot, job.creditsReserved).maxCharge;
		moderationFailureCode = waived
			? "OUTPUT_CONTENT_BLOCKED_WAIVED"
			: "OUTPUT_CONTENT_BLOCKED_CHARGED";
	}
	await settleCreditsInTransaction(
		{ reservationId: job.reservation.id, amount: chargeCredits, referenceKey: `settle:${job.id}` },
		tx,
	);
	return moderationFailureCode;
}

async function settleGenerationCreditsWithFreshReads(
	database: PrismaClient,
	jobId: string,
): Promise<{ outcome: "SKIPPED" | "SETTLED" } | null> {
	const bindingSelect = {
		where: { role: "OUTPUT" as const },
		select: { assetId: true, assetChecksum: true },
	};
	for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
		try {
			return await runReadCommitted(database, async (tx) => {
				// Only discover identities here. No pre-lock result authorizes a charge.
				const discovered = await tx.generationJob.findFirst({
					where: {
						executionEngine: "legacy",
						id: jobId,
						status: { in: ["FINALIZING", "CANCELED"] },
					},
					select: {
						id: true,
						fundingSource: true,
						reservation: { select: { id: true, accountId: true, amount: true } },
						assets: bindingSelect,
					},
				});
				if (!discovered) return { outcome: "SKIPPED" };
				if (discovered.fundingSource !== "CREDITS") return null;
				if (!discovered.reservation) return { outcome: "SKIPPED" };
				const assetIds = [...new Set(discovered.assets.map(({ assetId }) => assetId))].sort();
				for (const assetId of assetIds)
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
				const accounts = await tx.$queryRaw<
					Array<{ id: string; ownerType: string; ownerId: string }>
				>`
					SELECT "id", "ownerType", "ownerId" FROM "credit_account"
					WHERE "id" = ${discovered.reservation.accountId} FOR UPDATE
				`;
				const account = accounts[0];
				if (!account) throw new Error("GENERATION_FUNDING_CONFLICT");
				// Account precedes job for old SSI settlements; NOWAIT breaks guest
				// cleanup's job/asset -> account inversion without changing its locks.
				const jobs = await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id" FROM "generation_job" WHERE "id" = ${jobId}
					AND "executionEngine" = 'legacy' AND "fundingSource" = 'CREDITS'
					AND "status" IN ('FINALIZING', 'CANCELED') FOR UPDATE NOWAIT
				`;
				if (jobs.length === 0) return { outcome: "SKIPPED" };
				// All output-binding writers must first perform the compatible job
				// write fence. Enable only after those receivers deploy and old writers drain.
				const lockedBindings = await tx.generationJobAsset.findMany({
					where: { jobId, role: "OUTPUT" },
					select: { assetId: true, assetChecksum: true },
				});
				if (!sameSettlementBindings(discovered.assets, lockedBindings))
					throw new SettlementFreshReadConflictError("OUTPUT_BINDINGS_CHANGED");
				await fenceSettlementOutputVersions(tx, assetIds);
				const job = await tx.generationJob.findFirst({
					where: {
						executionEngine: "legacy",
						id: jobId,
						fundingSource: "CREDITS",
						status: { in: ["FINALIZING", "CANCELED"] },
					},
					include: { reservation: true, assets: settlementOutputInclude },
				});
				if (!job) throw new SettlementFreshReadConflictError("JOB_CHANGED");
				if (!sameSettlementBindings(lockedBindings, job.assets))
					throw new SettlementFreshReadConflictError("OUTPUT_BINDINGS_CHANGED");
				const reservation = job.reservation;
				if (
					!reservation ||
					reservation.id !== discovered.reservation.id ||
					reservation.accountId !== account.id ||
					reservation.amount !== discovered.reservation.amount
				)
					throw new SettlementFreshReadConflictError("FUNDING_CHANGED");
				if (
					account.ownerType !== job.ownerType ||
					account.ownerId !== job.ownerId ||
					reservation.amount !== job.creditsReserved
				)
					throw new Error("GENERATION_FUNDING_CONFLICT");
				assertGenerationFundingBinding(job, { fundingSource: "CREDITS" });
				const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
				if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime()))
					throw new Error("SETTLEMENT_DATABASE_CLOCK_MISSING");
				const outputState = evaluateSettlementOutputs(
					job.assets,
					clock.now,
					imageModerationProviderForEnvironment(process.env),
				);
				if (outputState.waitingForVerification) return { outcome: "SKIPPED" };
				// Already-finalized reservations still repair FINALIZING under these
				// same locks. No old claim-side write may bypass fresh evidence.
				const active = reservation.status === "ACTIVE";
				const moderationFailureCode = active
					? await settleLockedGenerationCredits(tx, job, outputState)
					: undefined;
				if (job.status === "FINALIZING") {
					const terminal = await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: job.id,
							fundingSource: "CREDITS",
							status: "FINALIZING",
							version: job.version,
						},
						data: {
							status: outputState.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
							failureCode:
								outputState.readyOutputCount > 0
									? null
									: (moderationFailureCode ?? settlementFailureCode(job.failureCode)),
							terminalAt: clock.now,
							version: { increment: 1 },
						},
					});
					if (terminal.count !== 1) throw new SettlementFreshReadConflictError("JOB_CHANGED");
				}
				return { outcome: active ? "SETTLED" : "SKIPPED" };
			});
		} catch (error) {
			if (
				!(error instanceof SettlementFreshReadConflictError) &&
				!isDatabaseSerializationConflict(error) &&
				!isDatabaseLockNotAvailable(error)
			)
				throw error;
			if (attempt === SERIALIZABLE_RETRY_LIMIT) throw new SettlementTransactionConflictError(error);
		}
	}
	throw new Error("Settlement transaction retry limit exceeded");
}

async function repairSettledGenerationWithSerializable(database: PrismaClient, jobId: string) {
	await runSerializable(
		database,
		async (tx) => {
			const discovered = await tx.generationJob.findFirst({
				where: { executionEngine: "legacy", id: jobId, status: { in: ["FINALIZING", "CANCELED"] } },
				select: { id: true, assets: { where: { role: "OUTPUT" }, select: { assetId: true } } },
			});
			if (!discovered) return;
			const assetIds = [...new Set(discovered.assets.map(({ assetId }) => assetId))].sort();
			for (const assetId of assetIds)
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
			const job = await tx.generationJob.findFirst({
				where: { executionEngine: "legacy", id: jobId, status: { in: ["FINALIZING", "CANCELED"] } },
				include: { reservation: true, assets: settlementOutputInclude },
			});
			if (!job) return;
			const reservation = await getGenerationFundingReservation(
				job.id,
				tx,
				job.reservation ?? null,
			);
			if (!reservation || reservation.status === "ACTIVE") return;
			assertGenerationFundingBinding(job, reservation);
			const outputState = evaluateSettlementOutputs(
				job.assets,
				new Date(),
				imageModerationProviderForEnvironment(process.env),
			);
			if (outputState.waitingForVerification) return;
			assertImagePassSettlementCardinality(
				reservation,
				job.assets.length,
				outputState.readyOutputCount,
			);
			await tx.generationJob.updateMany({
				where: { executionEngine: "legacy", id: job.id, status: "FINALIZING" },
				data: {
					status: outputState.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
					failureCode:
						outputState.readyOutputCount > 0 ? null : settlementFailureCode(job.failureCode),
					terminalAt: new Date(),
				},
			});
			await fenceSettlementOutputVersions(tx, assetIds);
		},
		{ retryLockNotAvailable: true },
	).catch((error: unknown) => {
		if (isDatabaseSerializationConflict(error) || isDatabaseLockNotAvailable(error))
			throw new SettlementTransactionConflictError(error);
		throw error;
	});
}

export function createDatabaseSettlementStore(database: PrismaClient): SettlementStore {
	return {
		async settleForJob(payload) {
			return isSettlementFreshReadEnabled()
				? settleGenerationCreditsWithFreshReads(database, payload.jobId)
				: null;
		},
		async claimSettlement(payload) {
			const job = await database.generationJob.findFirst({
				where: {
					executionEngine: "legacy",
					id: payload.jobId,
					status: { in: ["FINALIZING", "CANCELED"] },
				},
				include: {
					reservation: true,
					assets: settlementOutputInclude,
					attempts: true,
				},
			});
			if (!job) return null;
			const reservation = await getGenerationFundingReservation(
				job.id,
				database,
				job.reservation ?? null,
			);
			if (!reservation) return null;
			assertGenerationFundingBinding(job, reservation);
			const outputState = evaluateSettlementOutputs(
				job.assets,
				new Date(),
				imageModerationProviderForEnvironment(process.env),
			);
			if (outputState.waitingForVerification) return null;
			assertImagePassSettlementCardinality(
				reservation,
				job.assets.length,
				outputState.readyOutputCount,
			);
			if (reservation.status !== "ACTIVE") {
				if (reservation.fundingSource === "CREDITS" && isSettlementFreshReadEnabled()) {
					await settleGenerationCreditsWithFreshReads(database, job.id);
				} else await repairSettledGenerationWithSerializable(database, job.id);
				return null;
			}
			return {
				jobId: job.id,
				reservationId: reservation.id,
				fundingSource: reservation.fundingSource,
				reservedCredits: job.creditsReserved,
				chargeCredits:
					reservation.fundingSource === "IMAGE_PASS"
						? 0n
						: calculateSettlementCharge({
								status: job.status,
								failureCode: job.failureCode,
								readyOutputCount: outputState.readyOutputCount,
								reservedCredits: job.creditsReserved,
								pricingSnapshot: job.pricingSnapshot,
							}),
				readyOutputCount: outputState.readyOutputCount,
				failureCode: job.failureCode,
				providerCostMicros: job.attempts.reduce(
					(total, attempt) => total + (attempt.providerCostMicros ?? 0n),
					0n,
				),
			};
		},
		async settle(claim) {
			if (claim.fundingSource !== "IMAGE_PASS" && isSettlementFreshReadEnabled()) {
				const result = await settleGenerationCreditsWithFreshReads(database, claim.jobId);
				if (result) return;
			}
			await runSerializable(
				database,
				async (tx) => {
					// The first read only discovers the lock set. Funding and moderation
					// evidence are loaded once below; Serializable keeps the same snapshot.
					const lockSnapshot = await tx.generationJob.findFirst({
						where: {
							executionEngine: "legacy",
							id: claim.jobId,
							status: { in: ["FINALIZING", "CANCELED"] },
						},
						select: {
							id: true,
							assets: { where: { role: "OUTPUT" }, select: { assetId: true } },
						},
					});
					if (!lockSnapshot) return;
					const outputAssetIds = [
						...new Set(lockSnapshot.assets.map((binding) => binding.assetId)),
					].sort();
					for (const assetId of outputAssetIds) {
						await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
					}
					const job = await tx.generationJob.findFirst({
						where: {
							executionEngine: "legacy",
							id: claim.jobId,
							status: { in: ["FINALIZING", "CANCELED"] },
						},
						include: { reservation: true, assets: settlementOutputInclude },
					});
					if (!job) return;
					const reservation = await getGenerationFundingReservation(
						job.id,
						tx,
						job.reservation ?? null,
					);
					if (!reservation || reservation.status !== "ACTIVE") return;
					assertGenerationFundingBinding(job, reservation);
					const outputState = evaluateSettlementOutputs(
						job.assets,
						new Date(),
						imageModerationProviderForEnvironment(process.env),
					);
					if (outputState.waitingForVerification) return;
					assertImagePassSettlementCardinality(
						reservation,
						job.assets.length,
						outputState.readyOutputCount,
					);
					if (reservation.fundingSource === "IMAGE_PASS") {
						await finalizeImagePassReservationInTransaction(
							{
								jobId: job.id,
								ownerId: job.ownerId,
								hasUsableOutput: outputState.readyOutputCount === 1,
							},
							tx,
						);
						await tx.generationJob.updateMany({
							where: { executionEngine: "legacy", id: job.id, status: "FINALIZING" },
							data: {
								status: outputState.readyOutputCount === 1 ? "SUCCEEDED" : "FAILED",
								failureCode:
									outputState.readyOutputCount === 1
										? null
										: settlementFailureCode(job.failureCode),
								terminalAt: new Date(),
								version: { increment: 1 },
							},
						});
						await fenceSettlementOutputVersions(tx, outputAssetIds);
						return;
					}
					const moderationFailureCode = await settleLockedGenerationCredits(tx, job, outputState);
					await tx.generationJob.updateMany({
						where: { executionEngine: "legacy", id: job.id, status: "FINALIZING" },
						data: {
							status: outputState.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
							failureCode:
								outputState.readyOutputCount > 0
									? null
									: (moderationFailureCode ?? settlementFailureCode(job.failureCode)),
							terminalAt: new Date(),
							version: { increment: 1 },
						},
					});
					await fenceSettlementOutputVersions(tx, outputAssetIds);
				},
				{ retryLockNotAvailable: true },
			).catch((error: unknown) => {
				if (
					error !== null &&
					typeof error === "object" &&
					(isDatabaseSerializationConflict(error) || isDatabaseLockNotAvailable(error))
				)
					throw new SettlementTransactionConflictError(error);
				throw error;
			});
		},
	};
}

export const databaseSettlementStore: SettlementStore = createDatabaseSettlementStore(db);

const OUTPUT_TRANSFER_MAX_FINALIZATION_ATTEMPTS = 5;
const OUTPUT_TRANSFER_CLEANUP_GRACE_MS = 60_000;
const OUTPUT_TRANSFER_EXHAUSTED_CODE = "STORAGE_TRANSFER_EXHAUSTED";
const OUTPUT_TRANSFER_FENCE_LOST_CODE = "OUTPUT_TRANSFER_FENCE_LOST";
const OUTPUT_TRANSFER_IN_PROGRESS_CODE = "OUTPUT_TRANSFER_IN_PROGRESS";
const GUEST_OUTPUT_CARDINALITY_INVALID_CODE = "GUEST_OUTPUT_CARDINALITY_INVALID";
const IMAGE_PASS_OUTPUT_CARDINALITY_INVALID_CODE = "IMAGE_PASS_OUTPUT_CARDINALITY_INVALID";

function isOutputTransferExhaustedPlaceholder(asset: {
	status: string;
	verificationLastErrorCode: string | null;
	checksum: string | null;
}): boolean {
	return (
		asset.status === "VERIFICATION_FAILED" &&
		asset.verificationLastErrorCode === OUTPUT_TRANSFER_EXHAUSTED_CODE &&
		!asset.checksum
	);
}

export function createDatabaseProviderCancellationStore(
	database: PrismaClient,
): ProviderCancellationStore {
	return {
		async claimProviderCancellation(payload) {
			const now = new Date();
			return database.$transaction(async (tx) => {
				const intent = await tx.outboxEvent.findUnique({
					where: { dedupeKey: `generation-cancel:${payload.jobId}` },
					select: { id: true },
				});
				if (!intent) return null;
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						jobId: payload.jobId,
						status: { in: ["SUBMITTED", "RUNNING"] },
						providerTaskId: { not: null },
						job: { status: { in: ["PROVIDER_PENDING", "PROVIDER_RUNNING"] } },
					},
					orderBy: { attemptNumber: "desc" },
					select: { id: true, provider: true, providerTaskId: true, reconcileLeasedUntil: true },
				});
				if (!attempt?.providerTaskId) return null;
				if (attempt.reconcileLeasedUntil && attempt.reconcileLeasedUntil > now) {
					return { kind: "BLOCKED", reason: "ATTEMPT_LEASED", retryable: true };
				}
				const leaseToken = crypto.randomUUID();
				const claimed = await tx.generationAttempt.updateMany({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: attempt.id,
						providerTaskId: attempt.providerTaskId,
						status: { in: ["SUBMITTED", "RUNNING"] },
						OR: [{ reconcileLeasedUntil: null }, { reconcileLeasedUntil: { lte: now } }],
					},
					data: {
						reconcileLeaseToken: leaseToken,
						reconcileLeasedUntil: new Date(now.getTime() + 60_000),
					},
				});
				if (claimed.count !== 1) {
					return { kind: "BLOCKED", reason: "ATTEMPT_LEASED", retryable: true };
				}
				return {
					jobId: payload.jobId,
					attemptId: attempt.id,
					provider: attempt.provider as ProviderKey,
					providerTaskId: attempt.providerTaskId,
					leaseToken,
					idempotencyKey: `generation-cancel:${payload.jobId}:${attempt.id}`,
				};
			});
		},
		async confirmProviderCancellation(claim) {
			return database.$transaction(async (tx) => {
				const canceledAttempt = await tx.generationAttempt.updateMany({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: claim.attemptId,
						providerTaskId: claim.providerTaskId,
						reconcileLeaseToken: claim.leaseToken,
						status: { in: ["SUBMITTED", "RUNNING"] },
					},
					data: {
						status: "CANCELED",
						uncertainSubmission: false,
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: null,
						completedAt: new Date(),
						responseSnapshot: {
							cancellation: "PROVIDER_CANCELED_CONFIRMED_NO_CHARGE",
						} as Prisma.InputJsonValue,
					},
				});
				if (canceledAttempt.count !== 1) return false;
				const canceledJob = await tx.generationJob.updateMany({
					where: {
						executionEngine: "legacy",
						id: claim.jobId,
						status: { in: ["PROVIDER_PENDING", "PROVIDER_RUNNING"] },
					},
					data: {
						status: "CANCELED",
						failureCode: "PROVIDER_CANCELED_CONFIRMED_NO_CHARGE",
						terminalAt: new Date(),
						version: { increment: 1 },
					},
				});
				if (canceledJob.count !== 1) return false;
				await tx.outboxEvent.upsert({
					where: { dedupeKey: `generation-settle:${claim.jobId}` },
					create: {
						eventType: "GENERATION_SETTLE",
						aggregateType: "GENERATION_JOB",
						aggregateId: claim.jobId,
						dedupeKey: `generation-settle:${claim.jobId}`,
						payload: { jobId: claim.jobId },
					},
					update: {},
				});
				return true;
			});
		},
		async markProviderCancellationManualRecovery(claim, code) {
			return database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUnique({
					where: { AND: { job: { executionEngine: "legacy" } }, id: claim.attemptId },
					include: { job: { select: { status: true } } },
				});
				if (!attempt) return false;
				return moveAttemptToManualReconciliation(tx, {
					attempt,
					jobStatus: attempt.job.status,
					code,
					attemptStatuses: ["SUBMITTED", "RUNNING"],
					jobStatuses: ["PROVIDER_PENDING", "PROVIDER_RUNNING"],
					action: "MEDIA_PROVIDER_CANCELLATION_NEEDS_RECONCILIATION",
					uncertainSubmission: true,
					reconcileLeaseToken: claim.leaseToken,
				});
			});
		},
		async releaseProviderCancellation(claim) {
			await database.generationAttempt.updateMany({
				where: {
					AND: { job: { executionEngine: "legacy" } },
					id: claim.attemptId,
					providerTaskId: claim.providerTaskId,
					reconcileLeaseToken: claim.leaseToken,
					status: { in: ["SUBMITTED", "RUNNING"] },
				},
				data: { reconcileLeaseToken: null, reconcileLeasedUntil: null },
			});
		},
	};
}

export const databaseProviderCancellationStore: ProviderCancellationStore =
	createDatabaseProviderCancellationStore(db);

export function createDatabaseFinalizationStore(
	database: PrismaClient,
	options: { streamingTransfersOnly?: boolean } = {},
): FinalizationStore {
	return {
		async claimFinalization(payload) {
			if (options.streamingTransfersOnly) {
				const projected = await readStreamingImageFinalization(payload.jobId, database);
				if (!projected || !projected.attemptId) return null;
				if (
					projected.ownerType !== "USER" ||
					projected.serviceClass === "GUEST_SLOW" ||
					projected.guestTrialId !== null ||
					getCatalogEntry(projected.productKey as ProductModelKey)?.mediaKind !== "image" ||
					!Array.isArray(projected.outputs) ||
					projected.outputs.length > 4 ||
					projected.outputs.some((output) => output?.kind !== "remote-url")
				) {
					throw new GenerationTransferRequiresHeavyError();
				}
				const outputs = providerOutputsFromTransferEnvelope("image", {
					version: 1,
					outputs: projected.outputs,
				});
				if (
					outputs.length === 0 ||
					outputs.some((output) => output.kind !== "remote-url") ||
					(projected.fundingSource === "IMAGE_PASS" && outputs.length !== 1)
				) {
					throw new GenerationTransferRequiresHeavyError();
				}
				return {
					jobId: projected.jobId,
					ownerId: projected.ownerId,
					mediaKind: "image",
					candidates: outputs.map((output, index) => ({
						key: `${projected.attemptId}:${index}`,
						output,
					})),
				};
			}
			return database.$transaction(async (tx) => {
				const job = await tx.generationJob.findFirst({
					where: { executionEngine: "legacy", id: payload.jobId, status: "FINALIZING" },
					include: {
						guestTrial: { select: { expiresAt: true } },
						attempts: {
							where: { status: "SUCCEEDED" },
							orderBy: { attemptNumber: "desc" },
							take: 1,
							include: { transferEnvelope: true },
						},
					},
				});
				const attempt = job?.attempts[0];
				if (!job || !attempt) return null;
				const mediaKind = mediaKindForJob(job.productKey);
				const singleOutput =
					job.serviceClass === "GUEST_SLOW" || job.fundingSource === "IMAGE_PASS";
				const cardinalityFailureCode =
					job.fundingSource === "IMAGE_PASS"
						? IMAGE_PASS_OUTPUT_CARDINALITY_INVALID_CODE
						: GUEST_OUTPUT_CARDINALITY_INVALID_CODE;
				if (job.fundingSource === "IMAGE_PASS" && mediaKind !== "image") {
					throw new Error("IMAGE_PASS_FINALIZATION_CONTEXT_INVALID");
				}
				if (job.serviceClass === "GUEST_SLOW" && (!job.guestTrial || mediaKind !== "image")) {
					throw new Error("GUEST_FINALIZATION_CONTEXT_INVALID");
				}
				let outputs = providerOutputsFromTransferEnvelope(
					mediaKind,
					attempt.transferEnvelope?.payload,
				);
				if (attempt.transferEnvelope && outputs.length === 0) {
					if (singleOutput) {
						await transitionSingleOutputCardinalityFailure(tx, {
							attemptId: attempt.id,
							jobId: job.id,
							jobVersion: job.version,
							previousFailureCode: job.failureCode,
							code: cardinalityFailureCode,
							outputCount: 0,
						});
						return null;
					}
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: job.id,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: safeResponseSnapshot(attempt.responseSnapshot, undefined, attempt),
						reasonCode: "TRANSFER_ENVELOPE_INVALID",
					});
					return null;
				}
				if (!attempt.transferEnvelope) {
					const promoted = createOutputTransferEnvelope(
						mediaKind,
						legacyOutputsFromResponseSnapshot(attempt.responseSnapshot),
					);
					if (!promoted) {
						if (singleOutput) {
							await transitionSingleOutputCardinalityFailure(tx, {
								attemptId: attempt.id,
								jobId: job.id,
								jobVersion: job.version,
								previousFailureCode: job.failureCode,
								code: cardinalityFailureCode,
								outputCount: 0,
							});
							return null;
						}
						await transitionTerminalSuccessWithoutMedia(tx, {
							attemptId: attempt.id,
							jobId: job.id,
							errorSnapshot: attempt.errorSnapshot,
							responseSnapshot: safeResponseSnapshot(attempt.responseSnapshot, undefined, attempt),
							reasonCode: "LEGACY_OUTPUT_PROMOTION_FAILED",
						});
						return null;
					}
					await tx.generationAttemptTransferEnvelope.create({
						data: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(promoted) },
					});
					await tx.generationAttempt.update({
						where: { AND: { job: { executionEngine: "legacy" } }, id: attempt.id },
						data: {
							responseSnapshot: safeResponseSnapshot(
								attempt.responseSnapshot,
								promoted.outputs.length,
								attempt,
							),
						},
					});
					outputs = providerOutputsFromTransferEnvelope(mediaKind, promoted);
				}
				if (singleOutput && outputs.length !== 1) {
					await transitionSingleOutputCardinalityFailure(tx, {
						attemptId: attempt.id,
						jobId: job.id,
						jobVersion: job.version,
						previousFailureCode: job.failureCode,
						code: cardinalityFailureCode,
						outputCount: outputs.length,
					});
					return null;
				}
				return {
					jobId: job.id,
					ownerId: job.ownerId,
					mediaKind,
					...(job.serviceClass === "GUEST_SLOW" && job.guestTrial
						? { guest: { deleteAfter: job.guestTrial.expiresAt } }
						: {}),
					candidates: outputs.map((output, index) => ({
						key: `${attempt.id}:${index}`,
						output,
					})),
				};
			});
		},
		async findPersistedCandidate(jobId, candidateKey) {
			const binding = await database.generationJobAsset.findFirst({
				where: {
					AND: { job: { executionEngine: "legacy" } },
					jobId,
					role: "OUTPUT",
					asset: { sourceUrl: `provider-output:${candidateKey}` },
				},
				include: {
					asset: true,
					job: {
						select: {
							serviceClass: true,
							guestTrial: { select: { expiresAt: true } },
						},
					},
				},
			});
			if (
				!binding ||
				binding.asset.status === "VERIFYING" ||
				binding.asset.status === "UPLOADING"
			) {
				return null;
			}
			if (
				binding.job.serviceClass === "GUEST_SLOW" &&
				(!binding.job.guestTrial ||
					binding.asset.retentionClass !== "GUEST_TRIAL" ||
					binding.asset.watermarkVersion !== GUEST_WATERMARK_VERSION ||
					!binding.asset.watermarkedAt ||
					!binding.asset.cleanStagingDeletedAt ||
					!binding.asset.deleteAfter ||
					binding.asset.deleteAfter.getTime() !== binding.job.guestTrial.expiresAt.getTime())
			) {
				return null;
			}
			if (isOutputTransferExhaustedPlaceholder(binding.asset)) {
				return null;
			}
			return { assetId: binding.assetId, approved: binding.asset.status === "READY" };
		},
		async recordFinalizationWait(claim, results) {
			await runSerializable(database, async (tx) => {
				// Claim and completion writers take job ownership before output bindings.
				await tx.$queryRaw`
					SELECT "id" FROM "generation_job" WHERE "id" = ${claim.jobId}
					AND "executionEngine" = 'legacy' FOR NO KEY UPDATE
				`;
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { executionEngine: "legacy", id: claim.jobId },
				});
				if (job.status !== "FINALIZING") return;
				await bindFinalizationResults(tx, claim, results);
			});
		},
		async recordFinalization(claim, results, failure) {
			await runSerializable(database, async (tx) => {
				await tx.$queryRaw`
					SELECT "id" FROM "generation_job" WHERE "id" = ${claim.jobId}
					AND "executionEngine" = 'legacy' FOR NO KEY UPDATE
				`;
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { executionEngine: "legacy", id: claim.jobId },
				});
				if (job.status !== "FINALIZING") return;
				await bindFinalizationResults(tx, claim, results);
				await tx.generationJob.update({
					where: { executionEngine: "legacy", id: job.id },
					data: {
						finalizationStage: failure?.stage ?? null,
						finalizationErrorCode: failure?.code ?? null,
						nextFinalizeAt: null,
					},
				});
				await queueGenerationSettlement(tx, job.id, job.version);
			});
		},
		async recordFinalizationRetry(claim, failure, results = []) {
			return runSerializable(database, async (tx) => {
				const locked = await tx.$queryRaw<Array<{ id: string }>>`
					SELECT "id" FROM "generation_job" WHERE "id" = ${claim.jobId}
					AND "executionEngine" = 'legacy' FOR UPDATE
				`;
				if (locked.length !== 1) return { outcome: "TERMINAL" as const, retryCount: 0 };
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { executionEngine: "legacy", id: claim.jobId },
				});
				if (job.status !== "FINALIZING") {
					return { outcome: "TERMINAL" as const, retryCount: job.finalizationRetryCount };
				}
				await bindFinalizationResults(tx, claim, results);
				if (
					failure.stage === "TRANSFER" &&
					job.finalizationStage === "TRANSFER" &&
					job.finalizationRetryCount >= OUTPUT_TRANSFER_MAX_FINALIZATION_ATTEMPTS &&
					(await isAlreadyTerminalizedOutputTransfer(tx, claim, failure))
				) {
					const retry = await tx.outboxEvent.findUnique({
						where: {
							dedupeKey: `generation-finalize-after-transfer-exhaustion:${job.id}:${failure.assetId}:${failure.transferToken}`,
						},
						select: { id: true, availableAt: true, status: true },
					});
					return {
						outcome: "RETRY_SCHEDULED" as const,
						retryCount: job.finalizationRetryCount,
						...(retry &&
						(retry.status === "PENDING" || retry.status === "LEASED") &&
						retry.availableAt.getTime() === job.nextFinalizeAt?.getTime()
							? { retryEvent: { id: retry.id, availableAt: retry.availableAt.getTime() } }
							: {}),
					};
				}
				if (
					failure.stage === "TRANSFER" &&
					(failure.code === OUTPUT_TRANSFER_IN_PROGRESS_CODE ||
						failure.code === OUTPUT_TRANSFER_FENCE_LOST_CODE)
				) {
					const transferRetryCount =
						job.finalizationStage === "TRANSFER" ? job.finalizationRetryCount : 0;
					const wait = await getOutputTransferWait(
						tx,
						claim,
						job.version,
						transferRetryCount,
						failure,
					);
					const retryEvent = await queueFinalizationRetryEvent(tx, {
						jobId: job.id,
						version: job.version,
						dedupeKey: `generation-finalize-transfer-wait:${job.id}:${wait.key}`,
						availableAt: wait.availableAt,
					});
					await tx.generationJob.update({
						where: { executionEngine: "legacy", id: job.id },
						data: {
							finalizationStage: failure.stage,
							finalizationRetryCount: transferRetryCount,
							finalizationErrorCode: failure.code,
							nextFinalizeAt: new Date(retryEvent.availableAt),
						},
					});
					return {
						outcome: "RETRY_SCHEDULED" as const,
						retryCount: transferRetryCount,
						retryEvent,
					};
				}
				const retryCount =
					job.finalizationStage === failure.stage ? job.finalizationRetryCount + 1 : 1;
				if (
					failure.stage === "TRANSFER" &&
					retryCount >= OUTPUT_TRANSFER_MAX_FINALIZATION_ATTEMPTS &&
					(await terminalizeExhaustedOutputTransfer(tx, claim, failure))
				) {
					const retryEvent = await queueFinalizationRetryEvent(tx, {
						jobId: job.id,
						version: job.version,
						dedupeKey: `generation-finalize-after-transfer-exhaustion:${job.id}:${failure.assetId}:${failure.transferToken}`,
						availableAt: new Date(),
					});
					await tx.generationJob.update({
						where: { executionEngine: "legacy", id: job.id },
						data: {
							finalizationStage: failure.stage,
							finalizationRetryCount: retryCount,
							finalizationErrorCode: OUTPUT_TRANSFER_EXHAUSTED_CODE,
							nextFinalizeAt: new Date(retryEvent.availableAt),
						},
					});
					return { outcome: "RETRY_SCHEDULED" as const, retryCount, retryEvent };
				}
				const nextFinalizeAt = new Date(Date.now() + Math.min(60, 2 ** retryCount) * 60_000);
				const retryEvent = await queueFinalizationRetryEvent(tx, {
					jobId: job.id,
					version: job.version,
					dedupeKey: `generation-finalize-retry:${job.id}:${failure.stage.toLowerCase()}:${retryCount}`,
					availableAt: nextFinalizeAt,
				});
				await tx.generationJob.update({
					where: { executionEngine: "legacy", id: job.id },
					data: {
						finalizationStage: failure.stage,
						finalizationRetryCount: retryCount,
						finalizationErrorCode: failure.code,
						nextFinalizeAt: new Date(retryEvent.availableAt),
					},
				});
				return { outcome: "RETRY_SCHEDULED" as const, retryCount, retryEvent };
			});
		},
	};
}

async function queueFinalizationRetryEvent(
	tx: Prisma.TransactionClient,
	input: { jobId: string; version: number; dedupeKey: string; availableAt: Date },
): Promise<FinalizationRetryEvent> {
	const id = crypto.randomUUID();
	const inserted = await tx.outboxEvent.createMany({
		data: {
			id,
			eventType: "GENERATION_FINALIZE_RETRY",
			aggregateType: "GENERATION_JOB",
			aggregateId: input.jobId,
			dedupeKey: input.dedupeKey,
			payload: { jobId: input.jobId, version: input.version },
			availableAt: input.availableAt,
		},
		skipDuplicates: true,
	});
	if (inserted.count === 1) return { id, availableAt: input.availableAt.getTime() };
	// Replay keeps the winner's lease and original due time. This identity is
	// returned only after the enclosing job/retry transaction commits.
	const event = await tx.outboxEvent.findUniqueOrThrow({
		where: { dedupeKey: input.dedupeKey },
		select: { id: true, availableAt: true },
	});
	return { id: event.id, availableAt: event.availableAt.getTime() };
}

async function bindFinalizationResults(
	tx: Prisma.TransactionClient,
	claim: Pick<FinalizationClaim, "jobId" | "candidates">,
	results: Array<{ assetId: string; approved: boolean; candidateKey: string }>,
): Promise<void> {
	const candidatePositions = new Map(
		claim.candidates.map((candidate, position) => [candidate.key, position] as const),
	);
	if (candidatePositions.size !== claim.candidates.length) {
		throw new Error("Finalization claim contains duplicate candidate keys");
	}
	for (const result of results) {
		const position = candidatePositions.get(result.candidateKey);
		if (position === undefined) {
			throw new Error("Finalization result does not belong to the claimed candidates");
		}
		const asset = await tx.mediaAsset.findUniqueOrThrow({
			where: { verificationEngine: "legacy", id: result.assetId },
			select: { checksum: true },
		});
		const hasImmutableChecksum = Boolean(asset.checksum && /^[a-f0-9]{64}$/i.test(asset.checksum));
		if (result.approved && !hasImmutableChecksum) {
			throw new Error("Finalized output is missing an immutable checksum");
		}
		const assetChecksum = hasImmutableChecksum
			? asset.checksum!
			: `pending-output:${result.assetId}`;
		await tx.generationJobAsset.upsert({
			where: {
				jobId_assetId_role: { jobId: claim.jobId, assetId: result.assetId, role: "OUTPUT" },
			},
			create: {
				jobId: claim.jobId,
				assetId: result.assetId,
				assetChecksum,
				role: "OUTPUT",
				position,
			},
			update: { position, assetChecksum },
		});
	}
}

async function queueGenerationSettlement(
	tx: Prisma.TransactionClient,
	jobId: string,
	version: number,
): Promise<void> {
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-settle:${jobId}` },
		create: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: jobId,
			dedupeKey: `generation-settle:${jobId}`,
			payload: { jobId, version },
		},
		update: {},
	});
}

async function transitionSingleOutputCardinalityFailure(
	tx: Prisma.TransactionClient,
	input: {
		attemptId: string;
		jobId: string;
		jobVersion: number;
		previousFailureCode: string | null;
		outputCount: number;
		code:
			| typeof GUEST_OUTPUT_CARDINALITY_INVALID_CODE
			| typeof IMAGE_PASS_OUTPUT_CARDINALITY_INVALID_CODE;
	},
): Promise<void> {
	await tx.generationAttempt.updateMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			id: input.attemptId,
			status: "SUCCEEDED",
		},
		data: {
			errorSnapshot: {
				code: input.code,
				outputCount: input.outputCount,
			},
		},
	});
	const changed = await tx.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: input.jobId,
			status: "FINALIZING",
			failureCode: input.previousFailureCode,
		},
		data: {
			failureCode: input.code,
			version: { increment: 1 },
		},
	});
	const settlementVersion = input.jobVersion + (changed.count === 1 ? 1 : 0);
	await queueGenerationSettlement(tx, input.jobId, settlementVersion);
	if (changed.count !== 1) return;
	await tx.auditLog.create({
		data: {
			action:
				input.code === IMAGE_PASS_OUTPUT_CARDINALITY_INVALID_CODE
					? "MEDIA_IMAGE_PASS_OUTPUT_CARDINALITY_REJECTED"
					: "MEDIA_GUEST_OUTPUT_CARDINALITY_REJECTED",
			targetType: "GENERATION_ATTEMPT",
			targetId: input.attemptId,
			metadata: {
				jobId: input.jobId,
				code: input.code,
				outputCount: input.outputCount,
			},
		},
	});
}

async function isAlreadyTerminalizedOutputTransfer(
	tx: Prisma.TransactionClient,
	claim: FinalizationClaim,
	failure: FinalizationFailure,
): Promise<boolean> {
	if (!failure.assetId || !failure.transferToken || !failure.candidateKey) return false;
	if (!claim.candidates.some((candidate) => candidate.key === failure.candidateKey)) return false;
	const [asset, cleanup] = await Promise.all([
		tx.mediaAsset.findFirst({
			where: {
				verificationEngine: "legacy",
				id: failure.assetId,
				ownerType: "USER",
				ownerId: claim.ownerId,
				kind: "OUTPUT",
				status: "VERIFICATION_FAILED",
				verificationLastErrorCode: OUTPUT_TRANSFER_EXHAUSTED_CODE,
				sourceUrl: `provider-output:${failure.candidateKey}`,
				jobBindings: { some: { jobId: claim.jobId, role: "OUTPUT" } },
			},
			select: { id: true },
		}),
		tx.outboxEvent.findUnique({
			where: {
				dedupeKey: `generation-output-terminal-cleanup:${failure.assetId}:${failure.transferToken}`,
			},
			select: { id: true },
		}),
	]);
	return Boolean(asset && cleanup);
}

async function getOutputTransferWait(
	tx: Prisma.TransactionClient,
	claim: FinalizationClaim,
	jobVersion: number,
	retryCount: number,
	failure: FinalizationFailure,
): Promise<{ availableAt: Date; key: string }> {
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
		SELECT clock_timestamp() AS "now"
	`;
	if (!clock) throw new Error("Database did not return its current time");
	const sourceUrls = claim.candidates.map((candidate) => `provider-output:${candidate.key}`);
	const bindings = await tx.generationJobAsset.findMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			jobId: claim.jobId,
			role: "OUTPUT",
			asset: {
				ownerType: "USER",
				ownerId: claim.ownerId,
				status: "VERIFYING",
				sourceUrl: { in: sourceUrls },
				outputTransferToken: { not: null },
				outputTransferLeaseExpiresAt: { gt: clock.now },
			},
		},
		select: {
			asset: {
				select: {
					id: true,
					outputTransferToken: true,
					outputTransferLeaseExpiresAt: true,
				},
			},
		},
	});
	const active = bindings
		.map(({ asset }) => asset)
		.filter(
			(
				asset,
			): asset is typeof asset & {
				outputTransferToken: string;
				outputTransferLeaseExpiresAt: Date;
			} => Boolean(asset.outputTransferToken && asset.outputTransferLeaseExpiresAt),
		)
		.sort((left, right) => left.id.localeCompare(right.id));
	if (active.length === 0) {
		const recoveryIdentity = createHash("sha256")
			.update(
				JSON.stringify({
					jobVersion,
					retryCount,
					candidateKey: failure.candidateKey ?? null,
					assetId: failure.assetId ?? null,
					transferToken: failure.transferToken ?? null,
				}),
			)
			.digest("base64url")
			.slice(0, 24);
		return {
			availableAt: new Date(clock.now.getTime() + 60_000),
			key: `recovery:${recoveryIdentity}`,
		};
	}
	const earliestLease = active.reduce(
		(earliest, asset) =>
			asset.outputTransferLeaseExpiresAt < earliest ? asset.outputTransferLeaseExpiresAt : earliest,
		active[0]!.outputTransferLeaseExpiresAt,
	);
	const key = createHash("sha256")
		.update(
			active
				.map(
					(asset) =>
						`${asset.id}:${asset.outputTransferToken}:${asset.outputTransferLeaseExpiresAt.toISOString()}`,
				)
				.join("|"),
		)
		.digest("base64url")
		.slice(0, 24);
	return { availableAt: new Date(earliestLease.getTime() + 1_000), key };
}

async function terminalizeExhaustedOutputTransfer(
	tx: Prisma.TransactionClient,
	claim: FinalizationClaim,
	failure: FinalizationFailure,
): Promise<boolean> {
	if (!failure.assetId || !failure.transferToken || !failure.candidateKey) return false;
	if (!claim.candidates.some((candidate) => candidate.key === failure.candidateKey)) return false;
	await tx.$executeRaw`
		SELECT pg_advisory_xact_lock(
			hashtextextended(${`media-asset-generation-binding:${failure.assetId}`}, 0)
		)`;
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
		SELECT clock_timestamp() AS "now"
	`;
	if (!clock) throw new Error("Database did not return its current time");
	const transfer = await tx.mediaAsset.findFirst({
		where: {
			verificationEngine: "legacy",
			id: failure.assetId,
			ownerType: "USER",
			ownerId: claim.ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			sourceUrl: `provider-output:${failure.candidateKey}`,
			outputTransferToken: failure.transferToken,
			outputTransferLeaseExpiresAt: { gt: clock.now },
			jobBindings: { some: { jobId: claim.jobId, role: "OUTPUT" } },
		},
		select: {
			id: true,
			objectKey: true,
			outputTransferLeaseExpiresAt: true,
			outputStagingObjectKey: true,
			outputPromotionMultipartUploadId: true,
		},
	});
	if (!transfer) return false;
	if (!transfer.outputTransferLeaseExpiresAt || !transfer.outputStagingObjectKey) {
		throw new Error("GENERATION_OUTPUT_TRANSFER_STATE_INCOMPLETE");
	}
	const terminalized = await tx.mediaAsset.updateMany({
		where: {
			verificationEngine: "legacy",
			id: transfer.id,
			status: "VERIFYING",
			outputTransferToken: failure.transferToken,
			outputTransferLeaseExpiresAt: { gt: clock.now },
		},
		data: {
			status: "VERIFICATION_FAILED",
			verificationLastErrorCode: OUTPUT_TRANSFER_EXHAUSTED_CODE,
			verificationExhaustedAt: clock.now,
			verificationNextAttemptAt: null,
			outputTransferToken: null,
			outputTransferLeaseExpiresAt: null,
			outputStagingObjectKey: null,
			outputPromotionMultipartUploadId: null,
		},
	});
	if (terminalized.count !== 1) return false;
	await tx.outboxEvent.upsert({
		where: {
			dedupeKey: `generation-output-terminal-cleanup:${transfer.id}:${failure.transferToken}`,
		},
		create: {
			eventType: "MEDIA_UPLOAD_CLEANUP",
			aggregateType: "MEDIA_ASSET",
			aggregateId: transfer.id,
			dedupeKey: `generation-output-terminal-cleanup:${transfer.id}:${failure.transferToken}`,
			payload: {
				assetId: transfer.id,
				objectKey: transfer.outputStagingObjectKey,
				promotionObjectKey: transfer.objectKey,
				storageReservationReferenceKey: `generation-output:${transfer.id}`,
				...(transfer.outputPromotionMultipartUploadId
					? { promotionMultipartUploadId: transfer.outputPromotionMultipartUploadId }
					: {}),
			},
			availableAt: new Date(
				transfer.outputTransferLeaseExpiresAt.getTime() + OUTPUT_TRANSFER_CLEANUP_GRACE_MS,
			),
		},
		update: {},
	});
	return true;
}

export const databaseFinalizationStore: FinalizationStore = createDatabaseFinalizationStore(db);

async function retryOutputTransferTransaction<T>(
	scope: { jobId: string; assetId: string; operation: "claim" | "reserve" | "complete" },
	transaction: () => Promise<T>,
): Promise<T> {
	// Use the database helper's isolation switch. The legacy Serializable
	// branch already retries internally; only the fresh-read branch needs this
	// outer retry budget. Never multiply the two layers' attempt counts.
	const maxAttempts = isStorageFreshReadEnabled() ? 3 : 1;
	for (let attempt = 1; ; attempt++) {
		try {
			return await transaction();
		} catch (error) {
			// Callers supply one database-only transaction, never a storage operation.
			// A confirmed rollback may retry under the same transfer identity; a
			// connection loss is not proof that a claim or completion did not commit.
			const rolledBack =
				error !== null && typeof error === "object" && isDatabaseSerializationConflict(error);
			console.warn("media.output.database_failure", {
				...scope,
				attempt,
				classification: rolledBack ? "rollback_conflict" : "unknown",
				willRetry: rolledBack && attempt < maxAttempts,
			});
			if (!rolledBack) throw error;
			if (attempt === maxAttempts) {
				if (scope.operation === "claim") throw new OutputTransferClaimConflictError(error);
				throw error;
			}
		}
	}
}

export function createFinalizationDependencies(
	environment = process.env,
	options: {
		store?: FinalizationStore;
		safety?: MediaSafetyAdapter;
		database?: PrismaClient;
		verification?: { verify(assetId: string): Promise<OutboxCommitResult | void> };
		/** New Workflow adapters release heavy transfer capacity before the first review. */
		deferOutputReview?: boolean;
		/** Stateless URL transfer executor: never loads inline bodies or uses buffered fallback. */
		streamingTransfersOnly?: boolean;
		storage?: Partial<{
			openInspectedRemoteMedia: typeof openInspectedRemoteMedia;
			putPrivateMediaObject: typeof putPrivateMediaObject;
			streamRemoteObjectToStorage: typeof streamRemoteObjectToStorage;
			tryWriteImmutableGenerationImage: typeof tryWriteImmutableGenerationImage;
			promoteStagedObject: typeof promoteStagedObject;
			watermarkStagedGuestImage: typeof watermarkStagedGuestImage;
		}>;
	} = {},
): FinalizationDependencies {
	const database = options.database ?? db;
	const store =
		options.store ??
		createDatabaseFinalizationStore(database, {
			streamingTransfersOnly: options.streamingTransfersOnly,
		});
	const verification =
		options.verification ??
		createDatabaseVerifyUploadDependencies(database, {
			environment,
			safety: options.safety,
		});
	const storage = {
		openInspectedRemoteMedia,
		putPrivateMediaObject,
		streamRemoteObjectToStorage,
		tryWriteImmutableGenerationImage,
		promoteStagedObject,
		watermarkStagedGuestImage,
		...options.storage,
	};
	return {
		store,
		async persistCandidate(claim, candidate, context) {
			const streamingTransfersOnly = options.streamingTransfersOnly === true;
			if (
				streamingTransfersOnly &&
				(claim.mediaKind !== "image" || claim.guest || candidate.output.kind !== "remote-url")
			) {
				throw new GenerationTransferRequiresHeavyError();
			}
			const managed = await database.generationJob.findUnique({
				where: { id: claim.jobId, executionEngine: "legacy" },
				select: { id: true },
			});
			if (!managed) throw new Error("LEGACY_EXECUTOR_NOT_MANAGED");
			if (!context?.persistedCandidateChecked) {
				const existing = await store.findPersistedCandidate(claim.jobId, candidate.key);
				if (existing) return existing;
			}
			const deferOutputReview =
				(options.deferOutputReview === true || streamingTransfersOnly) &&
				claim.mediaKind === "image";
			if (claim.guest && claim.guest.deleteAfter <= new Date()) {
				throw {
					code: "GUEST_RETENTION_EXPIRED",
					stage: "TRANSFER",
					retryable: false,
				};
			}
			const assetId = `asset_${createHash("sha256")
				.update(`${claim.jobId}:${candidate.key}`)
				.digest("base64url")
				.slice(0, 32)}`;
			const sourceUrl = `provider-output:${candidate.key}`;
			const placeholder = await database.mediaAsset.findUnique({
				where: { verificationEngine: "legacy", id: assetId },
			});
			const matchingPlaceholder =
				placeholder?.ownerType === "USER" &&
				placeholder.ownerId === claim.ownerId &&
				placeholder.kind === "OUTPUT" &&
				placeholder.sourceUrl === sourceUrl
					? placeholder
					: null;
			if (matchingPlaceholder && isOutputTransferExhaustedPlaceholder(matchingPlaceholder)) {
				throw {
					code: OUTPUT_TRANSFER_EXHAUSTED_CODE,
					stage: "TRANSFER",
					retryable: false,
				};
			}
			const storedMimeType = matchingPlaceholder?.mimeType;
			if (
				streamingTransfersOnly &&
				storedMimeType !== undefined &&
				!canStreamImmutableGenerationImage({ contentType: storedMimeType, contentLength: 1 })
			) {
				throw new GenerationTransferRequiresHeavyError();
			}
			if (
				streamingTransfersOnly &&
				matchingPlaceholder &&
				(matchingPlaceholder.outputTransferToken ||
					matchingPlaceholder.outputTransferLeaseExpiresAt ||
					matchingPlaceholder.outputStagingObjectKey ||
					matchingPlaceholder.outputPromotionMultipartUploadId)
			) {
				throw new GenerationTransferRequiresHeavyError();
			}
			if (storedMimeType !== undefined && !isMediaContentType(storedMimeType)) {
				throw new MediaValidationError(
					"OUTPUT_MEDIA_TYPE_UNSUPPORTED",
					"Stored output media type is not supported",
				);
			}
			let inlineBody: Buffer | null = null;
			let openedSource: Awaited<ReturnType<typeof openInspectedRemoteMedia>> | undefined;
			try {
				if (streamingTransfersOnly && !matchingPlaceholder?.finalizedAt) {
					try {
						openedSource = await storage.openInspectedRemoteMedia(
							(candidate.output as Extract<ProviderOutput, { kind: "remote-url" }>).url,
							{
								allowedHosts: providerCdnAllowlist(environment),
								maxRedirects: storageConfig.media.remoteMaxRedirects,
								connectTimeoutMs: storageConfig.media.remoteConnectTimeoutMs,
								firstByteTimeoutMs: storageConfig.media.remoteFirstByteTimeoutMs,
								totalTimeoutMs: storageConfig.media.remoteTotalTimeoutMs,
								expectedKind: "image",
							},
						);
					} catch (error) {
						if (error instanceof MediaValidationError)
							throw new GenerationTransferRequiresHeavyError();
						throw error;
					}
					if (
						!canStreamImmutableGenerationImage({
							contentType: openedSource.contentType,
							contentLength: openedSource.headers["content-length"],
						}) ||
						(storedMimeType !== undefined && storedMimeType !== openedSource.contentType)
					) {
						throw new GenerationTransferRequiresHeavyError();
					}
				}
				const mimeType =
					candidate.output.kind === "inline-base64"
						? (() => {
								const decoded = decodeInlineBase64MediaOutput(candidate.output);
								assertMediaKind(decoded.contentType, claim.mediaKind);
								inlineBody = decoded.body;
								return decoded.contentType;
							})()
						: (storedMimeType ??
							openedSource?.contentType ??
							(openedSource = await storage.openInspectedRemoteMedia(candidate.output.url, {
								allowedHosts: providerCdnAllowlist(environment),
								maxRedirects: storageConfig.media.remoteMaxRedirects,
								connectTimeoutMs: storageConfig.media.remoteConnectTimeoutMs,
								firstByteTimeoutMs: storageConfig.media.remoteFirstByteTimeoutMs,
								totalTimeoutMs: storageConfig.media.remoteTotalTimeoutMs,
								expectedKind: claim.mediaKind,
							})).contentType);
				assertMediaKind(mimeType, claim.mediaKind);
				const objectKey = createAssetObjectKey(claim.ownerId, assetId, mimeType);
				// The streaming preflight has already checked the real response length.
				// Reserve those bytes with the transfer claim, before opening a private write.
				const storageReservation =
					streamingTransfersOnly && openedSource && !claim.guest
						? {
								bytes: BigInt(openedSource.headers["content-length"]!),
								maximumStorageBytes: maximumMediaStorageBytes(environment),
							}
						: undefined;
				const transfer = await retryOutputTransferTransaction(
					{ jobId: claim.jobId, assetId, operation: "claim" },
					() =>
						claimGenerationOutputTransferTransaction(
							{
								jobId: claim.jobId,
								ownerId: claim.ownerId,
								assetId,
								objectKey,
								mimeType,
								sourceUrl,
								deferOutputReview,
								streamingTransfersOnly,
								...(storageReservation ? { storageReservation } : {}),
								...(claim.guest ? { guest: { deleteAfter: claim.guest.deleteAfter } } : {}),
								createStagingObjectKey: (transferToken) =>
									createStagingObjectKey(claim.ownerId, assetId, transferToken, mimeType),
							},
							database,
						),
				);
				if (transfer.outcome === "REQUIRES_HEAVY") throw new GenerationTransferRequiresHeavyError();
				if (transfer.outcome === "IN_PROGRESS") {
					throw {
						code: OUTPUT_TRANSFER_IN_PROGRESS_CODE,
						stage: "TRANSFER",
						retryable: true,
					};
				}

				let completedAsset = transfer.asset;
				let outputReviewEventId =
					transfer.outcome === "COMPLETED" ? transfer.outputReviewEventId : undefined;
				if (transfer.outcome === "CLAIMED") {
					try {
						// Only this freshly claimed immutable write can consume the receipt.
						// Recovery, changed lengths and later reserve calls recheck the lease.
						let reservedStorageBytes =
							transfer.freshAsset === true ? transfer.reservedStorageBytes : undefined;
						const reserve = async (bytes: number) => {
							const committedBytes = reservedStorageBytes;
							reservedStorageBytes = undefined;
							if (
								storageReservation &&
								Number.isSafeInteger(bytes) &&
								bytes > 0 &&
								committedBytes === BigInt(bytes) &&
								committedBytes === storageReservation.bytes
							)
								return;
							const reserved = await retryOutputTransferTransaction(
								{ jobId: claim.jobId, assetId, operation: "reserve" },
								() =>
									reserveGenerationOutputStorageTransaction(
										{
											assetId,
											ownerId: claim.ownerId,
											transferToken: transfer.transferToken,
											bytes: BigInt(bytes),
											maximumStorageBytes: maximumMediaStorageBytes(environment),
										},
										database,
									),
							);
							if (reserved.outcome === "STALE")
								throw { code: "OUTPUT_TRANSFER_FENCE_LOST", stage: "TRANSFER", retryable: true };
						};
						const direct =
							!claim.guest && !transfer.promotionMultipartUploadId
								? await storage.tryWriteImmutableGenerationImage({
										bucket: "media",
										key: objectKey,
										contentType: mimeType,
										streamingOnly: streamingTransfersOnly,
										freshClaim: transfer.freshAsset === true,
										...(openedSource ? { openedSource } : {}),
										...(inlineBody
											? { body: inlineBody }
											: {
													sourceUrl: (
														candidate.output as Extract<ProviderOutput, { kind: "remote-url" }>
													).url,
													allowedHosts: providerCdnAllowlist(environment),
												}),
										reserve,
									})
								: null;
						if (streamingTransfersOnly && !direct) {
							// Preflight used the storage writer's own eligibility predicate;
							// null here violates its contract. Retain the fenced retry and
							// never enter a buffer/multipart path in this executor.
							throw {
								code: "STREAMING_OUTPUT_WRITE_UNAVAILABLE",
								stage: "TRANSFER",
								retryable: true,
							};
						}
						// Keep the old lease/staging metadata contract for drain/rollback. Direct
						// mode never writes that staging key; its eventual delete is harmless.
						const promoted =
							direct ??
							(await (async () => {
								const staged = inlineBody
									? await storage.putPrivateMediaObject({
											bucket: "media",
											key: transfer.stagingObjectKey,
											contentType: mimeType,
											body: inlineBody,
										})
									: await storage.streamRemoteObjectToStorage({
											bucket: "media",
											key: transfer.stagingObjectKey,
											sourceUrl: (
												candidate.output as Extract<ProviderOutput, { kind: "remote-url" }>
											).url,
											allowedHosts: providerCdnAllowlist(environment),
											expectedContentType: mimeType,
											expectedMediaKind: claim.mediaKind,
											...(openedSource ? { openedSource } : {}),
										});
								await reserve(staged.bytes);
								return claim.guest
									? await storage.watermarkStagedGuestImage({
											staging: { bucket: "media", key: transfer.stagingObjectKey },
											final: { bucket: "media", key: objectKey },
											contentType: mimeType as "image/jpeg" | "image/png" | "image/webp",
											deleteAfter: claim.guest.deleteAfter,
										})
									: await storage.promoteStagedObject({
											staging: { bucket: "media", key: transfer.stagingObjectKey },
											final: { bucket: "media", key: objectKey },
											contentType: mimeType,
											contentLength: staged.bytes,
											acceptExistingFinalIdentity: true,
											preferSinglePut: true,
											promotion: {
												uploadId: transfer.promotionMultipartUploadId ?? undefined,
												onMultipartUploadCreated: async ({ uploadId }) => {
													await recordGenerationOutputPromotionMultipartTransaction(
														{
															assetId,
															ownerId: claim.ownerId,
															transferToken: transfer.transferToken,
															multipartUploadId: uploadId,
														},
														database,
													);
												},
											},
										});
							})());
						let guestCompletedAt: Date | undefined;
						if (claim.guest) {
							const resizedReservation = await retryOutputTransferTransaction(
								{ jobId: claim.jobId, assetId, operation: "reserve" },
								() =>
									reserveGenerationOutputStorageTransaction(
										{
											assetId,
											ownerId: claim.ownerId,
											transferToken: transfer.transferToken,
											bytes: BigInt(promoted.bytes),
											maximumStorageBytes: maximumMediaStorageBytes(environment),
										},
										database,
									),
							);
							if (resizedReservation.outcome === "STALE") {
								throw {
									code: "OUTPUT_TRANSFER_FENCE_LOST",
									stage: "TRANSFER",
									retryable: true,
								};
							}
							// Storage has confirmed watermarking and clean-source deletion. Record
							// that completion on PostgreSQL's clock, which owns the transfer lease.
							const [clock] = await database.$queryRaw<Array<{ now: Date }>>`
							SELECT clock_timestamp() AS "now"
						`;
							if (!clock) throw new Error("Database did not return its current time");
							guestCompletedAt = clock.now;
						}
						const completed = await retryOutputTransferTransaction(
							{ jobId: claim.jobId, assetId, operation: "complete" },
							() =>
								completeGenerationOutputTransferTransaction(
									{
										assetId,
										ownerId: claim.ownerId,
										transferToken: transfer.transferToken,
										bytes: BigInt(promoted.bytes),
										checksum: promoted.sha256,
										storageEtag: promoted.etag ?? null,
										storageVersionId: promoted.versionId ?? null,
										deferOutputReview,
										...(claim.guest && guestCompletedAt
											? {
													guestWatermark: {
														version: GUEST_WATERMARK_VERSION,
														watermarkedAt: guestCompletedAt,
														cleanStagingDeletedAt: guestCompletedAt,
														deleteAfter: claim.guest.deleteAfter,
													},
												}
											: {}),
									},
									database,
								),
						);
						if (completed.outcome === "STALE") {
							throw {
								code: "OUTPUT_TRANSFER_FENCE_LOST",
								stage: "TRANSFER",
								retryable: true,
							};
						}
						completedAsset = completed.asset;
						outputReviewEventId = completed.outputReviewEventId;
					} catch (error) {
						const structured = error as {
							code?: unknown;
							stage?: unknown;
							retryable?: unknown;
						};
						if (
							error instanceof MediaValidationError ||
							error instanceof RemoteMediaPolicyError ||
							error instanceof GenerationOutputStorageError ||
							(typeof structured.code === "string" &&
								structured.stage === "TRANSFER" &&
								structured.retryable === false)
						) {
							let failed;
							try {
								failed = await failGenerationOutputTransferTransaction(
									{
										assetId,
										ownerId: claim.ownerId,
										transferToken: transfer.transferToken,
										errorCode:
											error instanceof MediaValidationError ||
											error instanceof RemoteMediaPolicyError ||
											error instanceof GenerationOutputStorageError
												? error.code
												: (structured.code as string),
									},
									database,
								);
							} catch {
								throw {
									code: "OUTPUT_TRANSFER_FAILURE_PERSIST_RETRYABLE",
									stage: "TRANSFER",
									retryable: true,
								};
							}
							if (failed.outcome === "FAILED") throw error;
							throw {
								code: "OUTPUT_TRANSFER_FENCE_LOST",
								stage: "TRANSFER",
								retryable: true,
							};
						}
						if (
							typeof structured.code === "string" &&
							structured.stage === "TRANSFER" &&
							structured.retryable === true
						) {
							throw {
								code: structured.code,
								stage: "TRANSFER",
								retryable: true,
								assetId,
								transferToken: transfer.transferToken,
							};
						}
						throw {
							code: "STORAGE_TRANSFER_RETRYABLE",
							stage: "TRANSFER",
							retryable: true,
							assetId,
							transferToken: transfer.transferToken,
						};
					}
				}

				// The same policy-checked stream supplied both the media signature and
				// the transfer. Release it before moderation, including on recovered writes.
				openedSource?.stream.destroy();
				openedSource = undefined;
				inlineBody = null;
				if (completedAsset.status === "READY") return { assetId, approved: true };
				if (["QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(completedAsset.status)) {
					return { assetId, approved: false };
				}
				if (deferOutputReview) {
					if (!outputReviewEventId)
						throw { code: "OUTPUT_REVIEW_INTENT_MISSING", stage: "MODERATION", retryable: true };
					console.info("media.output.transfer", {
						jobId: claim.jobId,
						assetId,
						stage: "resources_released_review_deferred",
						at: Date.now(),
						outputReviewEventId,
					});
					return { assetId, approved: false, moderationPending: true, outputReviewEventId };
				}
				const progress = await verification.verify(assetId);
				const asset = await database.mediaAsset.findUniqueOrThrow({
					where: { verificationEngine: "legacy", id: assetId },
				});
				if (asset.status === "VERIFYING") {
					const pending = asset.verificationLastErrorCode === "IMAGE_PROCESSING";
					const polling =
						!asset.verificationLastErrorCode &&
						asset.verificationLeaseToken &&
						asset.verificationLeasedUntil &&
						asset.verificationLeasedUntil > new Date();
					if (
						asset.kind === "OUTPUT" &&
						asset.mimeType.startsWith("image/") &&
						(pending || polling) &&
						asset.verificationProviderTaskId
					) {
						// Duplicate/old finalizers may observe a wait committed by another actor.
						// Look up its real event; never create a replacement or reset the due time.
						const eventId =
							progress?.outputReviewEventId ??
							(
								await database.outboxEvent.findUnique({
									where: {
										dedupeKey: `media-asset-verify:${asset.id}:g${asset.verificationGeneration}:poll`,
									},
									select: { id: true },
								})
							)?.id;
						if (pending || eventId)
							return {
								assetId,
								approved: false,
								moderationPending: true,
								...(eventId ? { outputReviewEventId: eventId } : {}),
							};
					}
					throw { code: "MODERATION_RETRYABLE", stage: "MODERATION", retryable: true };
				}
				return { assetId, approved: asset.status === "READY" };
			} finally {
				openedSource?.stream.destroy();
			}
		},
	};
}

export function createDatabaseProviderEventStore(
	database: PrismaClient,
	options: {
		afterAttemptLock?: (claim: { eventId: string; attemptId: string }) => Promise<void>;
	} = {},
): ProviderEventStore {
	return {
		async claimProviderEvent(eventId) {
			return database.$transaction(async (tx) => {
				const event = await tx.providerWebhookEvent.findFirst({
					where: {
						id: eventId,
						provider: {
							notIn: [
								"kie-video-v1",
								"sightengine-video-v1",
								"seeapi-video-v1",
								KIE_IMAGE_COMPLETION_NOTICE_PROVIDER,
							],
						},
						NOT: { providerEventId: { startsWith: "video-v1:" } },
					},
				});
				if (!event?.providerTaskId) return null;
				if (event.status !== "RECEIVED" && event.status !== "PROCESSING") return null;
				const owner = await tx.generationAttempt.findFirst({
					where: { provider: event.provider, providerTaskId: event.providerTaskId },
					select: { id: true, job: { select: { executionEngine: true } } },
				});
				if (owner && owner.job.executionEngine !== "legacy") return null;
				// A held phase or processing lease is pending work. Compute its remaining
				// duration on the database clock and let Outbox persist a normal wait.
				const retryAfterMs = await getProviderEventDeliveryWait(
					{ eventId: event.id, attemptId: owner?.id, includeProcessingLease: true },
					tx,
				);
				if (retryAfterMs > 0) throw new ProviderEventPhaseHeldError(retryAfterMs);
				const processingToken = crypto.randomUUID();
				const claimed = await tx.providerWebhookEvent.updateMany({
					where: { id: event.id, status: event.status, processingToken: event.processingToken },
					data: {
						status: "PROCESSING",
						processingToken,
						processingLeasedUntil: new Date(Date.now() + 60_000),
					},
				});
				if (claimed.count !== 1) throw new ProviderEventPhaseHeldError();
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						provider: event.provider,
						providerTaskId: event.providerTaskId,
					},
					include: { job: true },
				});
				if (!attempt || ["SUCCEEDED", "FAILED", "CANCELED"].includes(attempt.status)) {
					await tx.providerWebhookEvent.update({
						where: { id: event.id, processingToken },
						data: {
							status: "PROCESSED",
							processedAt: new Date(),
							processingToken: null,
							processingLeasedUntil: null,
						},
					});
					return null;
				}
				return {
					eventId: event.id,
					attemptId: attempt.id,
					provider: event.provider as ProviderKey,
					receivedAt: event.receivedAt,
					providerOccurredAt: event.providerOccurredAt ?? undefined,
					providerSequence: event.providerSequence ?? undefined,
					processingToken,
					snapshot: {
						providerTaskId: event.providerTaskId,
						status: webhookStatus(event.envelope),
						raw: event.envelope,
					},
				};
			});
		},
		async recordProviderProgress(claim, result) {
			await database.$transaction(async (tx) => {
				const [attempt] = await tx.$queryRaw<
					Array<{
						id: string;
						jobId: string;
						status: string;
						progress: number | null;
						lastProviderEventAt: Date | null;
						lastProviderOccurredAt: Date | null;
						lastProviderReceivedAt: Date | null;
						lastProviderSequence: bigint | null;
						errorSnapshot: unknown;
						provider: string;
						providerTaskId: string | null;
						providerCostMicros: bigint | null;
						responseSnapshot: unknown;
					}>
				>`SELECT "id", "jobId", "status", "progress", "lastProviderEventAt", "provider", "providerTaskId", "providerCostMicros", "responseSnapshot",
						          "lastProviderOccurredAt", "lastProviderReceivedAt", "lastProviderSequence", "errorSnapshot"
					   FROM "generation_attempt" WHERE "id" = ${claim.attemptId} FOR UPDATE`;
				if (!attempt) throw new Error("Provider event attempt not found");
				const retryAfterMs = await getProviderEventDeliveryWait(
					{ eventId: claim.eventId, attemptId: attempt.id, includeProcessingLease: false },
					tx,
				);
				if (retryAfterMs > 0) throw new ProviderEventPhaseHeldError(retryAfterMs);
				await options.afterAttemptLock?.({ eventId: claim.eventId, attemptId: attempt.id });
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { executionEngine: "legacy", id: attempt.jobId },
					select: { productKey: true, status: true },
				});
				const incoming = claim.snapshot.status;
				const technicalFailure = confirmedTechnicalFailureCode(claim.snapshot, result);
				const canonicalTime = claim.providerOccurredAt ?? claim.receivedAt;
				const envelope =
					incoming === "SUCCEEDED"
						? createOutputTransferEnvelope(mediaKindForJob(job.productKey), result.outputs)
						: null;
				if (attempt.status === "NEEDS_RECONCILIATION" || job.status === "NEEDS_RECONCILIATION") {
					if (
						envelope &&
						attempt.status === "NEEDS_RECONCILIATION" &&
						job.status === "NEEDS_RECONCILIATION"
					) {
						await recoverManualProviderSuccess(tx, {
							attempt,
							job,
							result,
							envelope,
							providerEvent: {
								canonicalTime,
								occurredAt: claim.providerOccurredAt,
								receivedAt: claim.receivedAt,
								sequence: claim.providerSequence,
							},
						});
						await completeProviderWebhookEvent(tx, claim, "MANUAL_RECOVERY_SUCCEEDED");
						return;
					}
					await completeProviderWebhookEvent(tx, claim, "MANUAL_RECOVERY_RETAINED");
					return;
				}
				const incomingTerminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(incoming);
				const staleSequence =
					!incomingTerminal &&
					attempt.lastProviderSequence !== null &&
					(claim.providerSequence === undefined ||
						claim.providerSequence <= attempt.lastProviderSequence);
				const staleOccurredAt =
					!incomingTerminal &&
					attempt.lastProviderSequence === null &&
					claim.providerSequence === undefined &&
					attempt.lastProviderOccurredAt !== null &&
					(claim.providerOccurredAt === undefined ||
						claim.providerOccurredAt <= attempt.lastProviderOccurredAt);
				const staleReceivedAt =
					!incomingTerminal &&
					attempt.lastProviderSequence === null &&
					claim.providerSequence === undefined &&
					attempt.lastProviderOccurredAt === null &&
					claim.providerOccurredAt === undefined &&
					attempt.lastProviderReceivedAt !== null &&
					claim.receivedAt <= attempt.lastProviderReceivedAt;
				if (
					["SUCCEEDED", "FAILED", "CANCELED"].includes(attempt.status) ||
					staleSequence ||
					staleOccurredAt ||
					staleReceivedAt
				) {
					await completeProviderWebhookEvent(tx, claim, "STALE_EVENT_IGNORED");
					return;
				}
				if (claim.provider === "kie" && (incoming === "FAILED" || incoming === "CANCELED")) {
					// A callback only wakes authenticated retrieval; it cannot prove zero consumption.
					await tx.generationAttempt.update({
						where: { id: attempt.id },
						data: { nextReconcileAt: new Date() },
					});
					await completeProviderWebhookEvent(tx, claim, "KIE_TERMINAL_REQUIRES_RETRIEVAL");
					return;
				}
				if (incoming === "SUCCEEDED" && !envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result, attempt),
						attemptData: {
							progress:
								result.progress === null
									? attempt.progress
									: Math.max(attempt.progress ?? 0, Math.min(100, Math.round(result.progress))),
							providerCostMicros: providerCostForResult(result, attempt),
							lastProviderEventAt: canonicalTime,
							lastProviderOccurredAt: claim.providerOccurredAt,
							lastProviderReceivedAt: claim.receivedAt,
							lastProviderSequence: claim.providerSequence,
						},
					});
					await completeProviderWebhookEvent(tx, claim);
					return;
				}
				if (envelope) {
					await tx.generationAttemptTransferEnvelope.upsert({
						where: { attemptId: attempt.id },
						create: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(envelope) },
						update: { payload: outputTransferEnvelopeInput(envelope) },
					});
				}
				await tx.generationAttempt.update({
					where: { AND: { job: { executionEngine: "legacy" } }, id: attempt.id },
					data: {
						status:
							incoming === "SUCCEEDED"
								? "SUCCEEDED"
								: incoming === "FAILED"
									? "FAILED"
									: incoming === "CANCELED"
										? "CANCELED"
										: incoming === "RUNNING"
											? "RUNNING"
											: (attempt.status as
													| "CREATED"
													| "SUBMISSION_UNCERTAIN"
													| "SUBMITTED"
													| "RUNNING"
													| "SUCCEEDED"
													| "FAILED"
													| "CANCELED"),
						progress:
							result.progress === null
								? attempt.progress
								: Math.max(attempt.progress ?? 0, Math.min(100, Math.round(result.progress))),
						providerCostMicros: providerCostForResult(result, attempt),
						responseSnapshot: responseSnapshotForResult(result, attempt) as Prisma.InputJsonValue,
						uncertainSubmission: incomingTerminal ? false : undefined,
						errorSnapshot: technicalFailure
							? { code: technicalFailure, retryable: true }
							: undefined,
						reconcileLeaseToken: incomingTerminal ? null : undefined,
						reconcileLeasedUntil: incomingTerminal ? null : undefined,
						nextReconcileAt: incomingTerminal ? null : undefined,
						lastProviderEventAt: incoming === "UNKNOWN" ? undefined : canonicalTime,
						lastProviderOccurredAt: incoming === "UNKNOWN" ? undefined : claim.providerOccurredAt,
						lastProviderReceivedAt: incoming === "UNKNOWN" ? undefined : claim.receivedAt,
						lastProviderSequence: claim.providerSequence,
						completedAt: incomingTerminal ? new Date() : undefined,
					},
				});
				if (incoming === "SUCCEEDED") {
					await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: attempt.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: { status: "FINALIZING", version: { increment: 1 } },
					});
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}` },
						create: {
							eventType: "GENERATION_FINALIZE",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}`,
							payload: { jobId: attempt.jobId },
						},
						update: {},
					});
				} else if (incoming === "FAILED" || incoming === "CANCELED") {
					await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: attempt.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: {
							status: "FINALIZING",
							failureCode: technicalFailure ?? undefined,
							version: { increment: 1 },
						},
					});
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-settle:${attempt.jobId}` },
						create: {
							eventType: "GENERATION_SETTLE",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-settle:${attempt.jobId}`,
							payload: { jobId: attempt.jobId },
						},
						update: {},
					});
				} else if (incoming === "RUNNING") {
					await tx.generationJob.updateMany({
						where: { executionEngine: "legacy", id: attempt.jobId, status: "PROVIDER_PENDING" },
						data: { status: "PROVIDER_RUNNING", version: { increment: 1 } },
					});
				}
				await completeProviderWebhookEvent(tx, claim);
			});
		},
		async markProviderRecoveryUnavailable(claim) {
			if (await unmanagedLegacyTask(database, { attemptId: claim.attemptId })) return;
			await database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${claim.attemptId} FOR UPDATE`;
				const retryAfterMs = await getProviderEventDeliveryWait(
					{ eventId: claim.eventId, attemptId: claim.attemptId, includeProcessingLease: false },
					tx,
				);
				if (retryAfterMs > 0) throw new ProviderEventPhaseHeldError(retryAfterMs);
				const attempt = await tx.generationAttempt.findUnique({
					where: { AND: { job: { executionEngine: "legacy" } }, id: claim.attemptId },
					select: { id: true, jobId: true, status: true, errorSnapshot: true },
				});
				if (!attempt) {
					await completeProviderWebhookEvent(tx, claim, "PROVIDER_RECOVERY_UNAVAILABLE");
					return;
				}
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { executionEngine: "legacy", id: attempt.jobId },
					select: { status: true },
				});
				if (attempt.status === "NEEDS_RECONCILIATION" || job.status === "NEEDS_RECONCILIATION") {
					await completeProviderWebhookEvent(tx, claim, "MANUAL_RECOVERY_RETAINED");
					return;
				}
				await moveAttemptToManualReconciliation(tx, {
					attempt,
					jobStatus: job.status,
					code: "PROVIDER_RECOVERY_UNAVAILABLE",
					attemptStatuses: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"],
					jobStatuses: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"],
					action: "MEDIA_PROVIDER_RECOVERY_UNAVAILABLE",
					uncertainSubmission: true,
				});
				await completeProviderWebhookEvent(tx, claim, "PROVIDER_RECOVERY_UNAVAILABLE");
			});
		},
		async recordProviderEventFailure(claim, code) {
			if (await unmanagedLegacyTask(database, { attemptId: claim.attemptId })) return;
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUnique({
					where: { AND: { job: { executionEngine: "legacy" } }, id: claim.attemptId },
					include: { job: { select: { status: true } } },
				});
				if (
					attempt?.status === "NEEDS_RECONCILIATION" ||
					attempt?.job.status === "NEEDS_RECONCILIATION"
				) {
					await completeProviderWebhookEvent(tx, claim, "MANUAL_RECOVERY_RETAINED");
					return;
				}
				await tx.providerWebhookEvent.updateMany({
					where: { id: claim.eventId, processingToken: claim.processingToken },
					data: {
						status: "FAILED",
						failureReason: code,
						processingToken: null,
						processingLeasedUntil: null,
					},
				});
			});
		},
	};
}
export const databaseProviderEventStore: ProviderEventStore = createDatabaseProviderEventStore(db);

export interface ReconciliationRuntimeOptions extends ImagePhaseContext {
	afterAttemptRead?: () => Promise<void>;
	afterAttemptUpdate?: () => Promise<void>;
}

export function createDatabaseReconciliationStore(
	database: PrismaClient,
	options: ReconciliationRuntimeOptions = {},
): GenerationPollingStore {
	return {
		async getPollingState(attemptId) {
			if (!attemptId.trim()) throw new Error("INVALID_GENERATION_ATTEMPT_ID");
			// Keep each observation fresh while reading the attempt and its job in
			// one statement instead of Prisma's separate relation query.
			const [attempt] = await database.$queryRaw<
				Array<{
					nextReconcileAt: Date | null;
					reconcileLeasedUntil: Date | null;
					pending: boolean;
					phaseKey: string | null;
					workflowId: string | null;
					epoch: number | null;
				}>
			>`
				SELECT attempt."nextReconcileAt", attempt."reconcileLeasedUntil",
				  (attempt."providerTaskId" IS NOT NULL AND attempt."providerTaskId" <> ''
				   AND attempt."status" IN ('SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING')
				   AND job."status" IN ('SUBMITTING', 'PROVIDER_PENDING', 'PROVIDER_RUNNING')) AS "pending",
				  owner."phaseKey", owner."workflowId", owner."epoch"
				FROM "generation_attempt" attempt
				JOIN "generation_job" job ON job."id" = attempt."jobId"
				LEFT JOIN "media_workflow_phase_owner" owner ON owner."phaseKind" = 'generation'
				 AND owner."subjectId" = attempt."id" AND owner."generation" = 0 AND owner."leasedUntil" > clock_timestamp()
				WHERE attempt."id" = ${attemptId} AND job."executionEngine" = 'legacy'`;
			const phaseOwner =
				attempt?.phaseKey && attempt.workflowId && attempt.epoch
					? { phaseKey: attempt.phaseKey, workflowId: attempt.workflowId, epoch: attempt.epoch }
					: undefined;
			if (
				(phaseOwner && phaseOwner.workflowId !== options.workflowId) ||
				(options.phaseOwner &&
					(!phaseOwner || !sameImagePhaseOwner(phaseOwner, options.phaseOwner)))
			)
				return {
					pollAt: new Date(0),
					phaseOwnershipLost: true,
					...(phaseOwner ? { phaseOwner } : {}),
				};
			if (!attempt || !attempt.pending) return null;
			return {
				...(phaseOwner ? { phaseOwner } : {}),
				pollAt: new Date(
					Math.max(
						attempt.nextReconcileAt?.getTime() ?? 0,
						attempt.reconcileLeasedUntil?.getTime() ?? 0,
					),
				),
				leasedUntil: attempt.reconcileLeasedUntil,
			};
		},
		async claimStale({ limit, leaseSeconds, now, attemptId }) {
			if (attemptId !== undefined && !attemptId.trim())
				throw new Error("INVALID_GENERATION_ATTEMPT_ID");
			const leasedUntil = new Date(now.getTime() + leaseSeconds * 1_000);
			const scopedAttemptId = attemptId ?? null;
			const claim = async (
				tx: Prisma.TransactionClient,
				phaseOwner?: ImagePhaseOwner,
			): Promise<ReconciliationLease[]> => {
				const leases = await tx.$queryRaw<
					Array<
						ReconciliationLease & {
							responseSnapshot?: unknown;
							transferEnvelope?: unknown;
							productKey?: string;
						}
					>
				>`
			WITH claimable AS (
				SELECT "id" FROM "generation_attempt" candidate
				WHERE "jobId" IN (SELECT "id" FROM "generation_job" WHERE "executionEngine" = 'legacy')
				AND ("providerTaskId" IS NOT NULL OR "uncertainSubmission" = true)
			  AND "status" IN ('SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING')
				  AND (${scopedAttemptId}::text IS NULL OR "id" = ${scopedAttemptId})
				  AND ("nextReconcileAt" IS NULL OR "nextReconcileAt" <= ${now})
				  AND ("reconcileLeasedUntil" IS NULL OR "reconcileLeasedUntil" <= ${now})
				  AND NOT EXISTS (SELECT 1 FROM "media_workflow_phase_owner" owner
				   WHERE owner."phaseKind" = 'generation' AND owner."subjectId" = candidate."id" AND owner."generation" = 0
				   AND owner."leasedUntil" > clock_timestamp() AND (
				    ${phaseOwner?.phaseKey ?? null}::text IS NULL OR owner."phaseKey" <> ${phaseOwner?.phaseKey ?? null}
				    OR owner."workflowId" <> ${phaseOwner?.workflowId ?? null} OR owner."epoch" <> ${phaseOwner?.epoch ?? null}::int))
				ORDER BY "updatedAt", "id" FOR UPDATE SKIP LOCKED LIMIT ${limit}
			), leased AS (
			UPDATE "generation_attempt" attempt
			SET "reconcileLeaseToken" = gen_random_uuid()::text,
			    "reconcileLeasedUntil" = ${leasedUntil},
				    "reconciliationCount" = attempt."reconciliationCount" + ${attemptId === undefined ? 1 : 0}
			FROM claimable WHERE attempt."id" = claimable."id"
			RETURNING attempt."jobId", attempt."id" AS "attemptId", attempt."provider",
			          attempt."providerTaskId", attempt."providerStatusUrl" AS "statusUrl",
			          attempt."providerResultUrl" AS "resultUrl",
			          attempt."reconcileLeaseToken" AS "leaseToken",
			          GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${now} - attempt."updatedAt")) / 60))::int AS "staleAgeMinutes",
			          attempt."reconciliationCount" AS "repairCount", attempt."responseSnapshot"
			), consumed AS (
				UPDATE "provider_webhook_event" notice
				SET "status" = 'PROCESSED', "processedAt" = ${now}
				FROM leased WHERE leased."provider" = 'kie'
				  AND notice."provider" = ${KIE_IMAGE_COMPLETION_NOTICE_PROVIDER}
				  AND notice."providerEventId" = ${KIE_IMAGE_COMPLETION_NOTICE_PREFIX} || leased."attemptId" || ':' || leased."providerTaskId"
				  AND notice."providerTaskId" = leased."providerTaskId"
				  AND notice."status" = 'RECEIVED'
				RETURNING notice."id"
			)
			SELECT leased.*, envelope."payload" AS "transferEnvelope", job."productKey"
			FROM leased JOIN "generation_job" job ON job."id" = leased."jobId"
			LEFT JOIN "generation_attempt_transfer_envelope" envelope ON envelope."attemptId" = leased."attemptId"
			 AND leased."responseSnapshot" ? 'phaseCompletion'`;
				return leases.map(({ responseSnapshot, transferEnvelope, productKey, ...lease }) => {
					const saved = objectRecord(objectRecord(responseSnapshot)?.phaseCompletion);
					const outputs =
						saved && productKey
							? providerOutputsFromTransferEnvelope(mediaKindForJob(productKey), transferEnvelope)
							: [];
					const completion =
						saved && outputs.length > 0 && saved.providerTaskId === lease.providerTaskId
							? {
									snapshot: {
										providerTaskId: lease.providerTaskId!,
										status: "SUCCEEDED" as const,
										raw: {},
									},
									result: {
										outputs,
										progress: typeof saved.progress === "number" ? saved.progress : null,
										providerCostMicros:
											typeof saved.providerCostMicros === "number"
												? saved.providerCostMicros
												: null,
										providerCharged: saved.providerCharged === true,
										failure: null,
										retryable: false,
									},
								}
							: undefined;
					return {
						...lease,
						...(phaseOwner ? { phaseOwner } : {}),
						...(completion ? { completion } : {}),
					};
				});
			};
			if (!options.workflowId || !attemptId) return claim(database);
			return database.$transaction(async (tx) => {
				const [attempt] = await tx.$queryRaw<Array<{ reconcileLeasedUntil: Date | null }>>`
				 SELECT "reconcileLeasedUntil" FROM "generation_attempt"
				 WHERE "id" = ${attemptId} AND "status" IN ('SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING')
				 AND "jobId" IN (SELECT "id" FROM "generation_job" WHERE "executionEngine" = 'legacy')
				 AND ("providerTaskId" IS NOT NULL OR "uncertainSubmission" = true)
				 AND ("nextReconcileAt" IS NULL OR "nextReconcileAt" <= ${now})
				 AND ("reconcileLeasedUntil" IS NULL OR "reconcileLeasedUntil" <= ${now}) FOR UPDATE`;
				if (!attempt) return [];
				const ownership = await claimImagePhaseOwnerInTransaction(
					{
						phase: { kind: "generation", attemptId },
						workflowId: options.workflowId!,
						expectedOwner: options.phaseOwner,
						businessLeasedUntil: attempt.reconcileLeasedUntil,
					},
					tx,
				);
				if (!ownership.owned) return [];
				return claim(tx, ownership.phaseOwner);
			});
		},
		async recordReconciled(lease, snapshot, result) {
			return database.$transaction(async (tx) => {
				if (options.afterAttemptRead) {
					await tx.generationAttempt.findUnique({ where: { id: lease.attemptId } });
					await options.afterAttemptRead();
				}
				// Serialize callbacks and repairs, and re-read after waiting. A stale read must
				// neither erase earlier charge evidence nor write outputs after losing its lease.
				const locked = await tx.$queryRaw<
					Array<{ id: string }>
				>`SELECT "id" FROM "generation_attempt" WHERE "id" = ${lease.attemptId} AND "reconcileLeaseToken" = ${lease.leaseToken} FOR UPDATE`;
				if (locked.length !== 1) return { outboxCommitted: false };
				if (!(await generationPhaseIsCurrent(lease.attemptId, lease.phaseOwner, tx)))
					return { outboxCommitted: false, phaseOwnershipLost: true };
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
					},
					include: { job: { select: { productKey: true, status: true, fundingSource: true } } },
				});
				if (!attempt) return { outboxCommitted: false };
				if (
					snapshot.providerTaskId !== attempt.providerTaskId ||
					lease.jobId !== attempt.jobId ||
					lease.provider !== attempt.provider
				)
					throw new Error("RECONCILIATION_TASK_MISMATCH");
				// Supplier occupancy can end while billing/output reconciliation
				// still needs frozen credits. Only authenticated retrieval writes this.
				const providerTerminalEvidence = createRetrievedProviderTerminalEvidence(attempt, snapshot);
				if (providerTerminalEvidence) {
					attempt.responseSnapshot = {
						...objectRecord(attempt.responseSnapshot),
						providerTerminalEvidence,
					} as Prisma.JsonValue;
					await tx.generationAttempt.update({
						where: { id: attempt.id },
						data: { responseSnapshot: attempt.responseSnapshot as Prisma.InputJsonValue },
					});
				}
				if (
					attempt.status === "NEEDS_RECONCILIATION" ||
					attempt.job.status === "NEEDS_RECONCILIATION"
				) {
					await tx.generationAttempt.updateMany({
						where: {
							AND: { job: { executionEngine: "legacy" } },
							id: attempt.id,
							reconcileLeaseToken: lease.leaseToken,
						},
						data: { reconcileLeaseToken: null, reconcileLeasedUntil: null, nextReconcileAt: null },
					});
					return { outboxCommitted: false };
				}
				const rejection = result.confirmedZeroCostRejection;
				if (
					snapshot.status === "FAILED" &&
					result.outputs.length === 0 &&
					result.providerCostMicros === 0 &&
					!result.providerCharged &&
					rejection?.source === "record-info" &&
					snapshot.retrieval?.source === "kie-record-info" &&
					rejection.observedAt === snapshot.retrieval.observedAt
				) {
					await tx.$queryRaw`SELECT "id" FROM "generation_job" WHERE "id" = ${attempt.jobId} FOR UPDATE`;
					if (await canSettleKieZeroCostRejection(attempt.id, rejection, tx)) {
						await tx.generationAttempt.update({
							where: { id: attempt.id },
							data: {
								status: "FAILED",
								uncertainSubmission: false,
								completedAt: new Date(),
								providerCostMicros: 0n,
								responseSnapshot: responseSnapshotForResult(
									result,
									attempt,
								) as Prisma.InputJsonValue,
								errorSnapshot: { code: KIE_ZERO_COST_REJECTION_CODE, retryable: false },
								reconcileLeaseToken: null,
								reconcileLeasedUntil: null,
								nextReconcileAt: null,
							},
						});
						const changed = await tx.generationJob.updateMany({
							where: {
								id: attempt.jobId,
								executionEngine: "legacy",
								status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
							},
							data: {
								status: "FINALIZING",
								failureCode: KIE_ZERO_COST_REJECTION_CODE,
								version: { increment: 1 },
							},
						});
						if (changed.count !== 1) throw new Error("KIE_REJECTION_JOB_STATE_CONFLICT");
						const inserted = await tx.outboxEvent.createMany({
							skipDuplicates: true,
							data: {
								eventType: "GENERATION_SETTLE",
								aggregateType: "GENERATION_JOB",
								aggregateId: attempt.jobId,
								dedupeKey: `generation-settle:${attempt.jobId}`,
								payload: { jobId: attempt.jobId },
							},
						});
						await tx.auditLog.create({
							data: {
								action: "MEDIA_KIE_ZERO_COST_REJECTION_CONFIRMED",
								targetType: "GENERATION_ATTEMPT",
								targetId: attempt.id,
								metadata: {
									jobId: attempt.jobId,
									evidence: rejection,
									source: "AUTHENTICATED_RETRIEVAL",
								},
							},
						});
						return { outboxCommitted: inserted.count > 0 };
					}
					await moveAttemptToManualReconciliation(tx, {
						attempt,
						jobStatus: attempt.job.status,
						code: "RECONCILIATION_TERMINAL_UNVERIFIED",
						attemptStatuses: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"],
						jobStatuses: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"],
						action: "MEDIA_KIE_ZERO_COST_REJECTION_CONFLICT",
						uncertainSubmission: true,
						reconcileLeaseToken: lease.leaseToken,
					});
					return { outboxCommitted: false };
				}
				const terminalFailure = snapshot.status === "FAILED" || snapshot.status === "CANCELED";
				const observedAt = Date.parse(snapshot.retrieval?.observedAt ?? "");
				// A pass promises a usable image, independently of supplier billing.
				// Only authenticated retrieval of this exact task closes its unknown hold.
				const passReservation =
					terminalFailure &&
					result.outputs.length === 0 &&
					attempt.job.fundingSource === "IMAGE_PASS" &&
					attempt.provider === "kie" &&
					lease.provider === "kie" &&
					Boolean(attempt.providerTaskId) &&
					lease.providerTaskId === attempt.providerTaskId &&
					snapshot.retrieval?.source === "kie-record-info" &&
					Number.isFinite(observedAt) &&
					observedAt <= Date.now()
						? await getGenerationFundingReservation(attempt.jobId, tx)
						: null;
				const imagePassFailure =
					passReservation?.fundingSource === "IMAGE_PASS" && passReservation.status === "ACTIVE"
						? "IMAGE_PASS_PROVIDER_FAILED_CONFIRMED"
						: undefined;
				const technicalFailure = confirmedTechnicalFailureCode(snapshot, result);
				const knownFailure = technicalFailure ?? imagePassFailure;
				const envelope =
					snapshot.status === "SUCCEEDED"
						? createOutputTransferEnvelope(mediaKindForJob(attempt.job.productKey), result.outputs)
						: null;
				if (snapshot.status === "SUCCEEDED" && !envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result, attempt),
						reconcileLeaseToken: lease.leaseToken,
						attemptData: {
							progress: result.progress,
							providerCostMicros: providerCostForResult(result, attempt),
						},
					});
					return { outboxCommitted: false };
				}
				const changed = await tx.generationAttempt.updateMany({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: attempt.id,
						reconcileLeaseToken: lease.leaseToken,
					},
					data: {
						status:
							snapshot.status === "SUCCEEDED"
								? "SUCCEEDED"
								: terminalFailure
									? knownFailure
										? "FAILED"
										: "NEEDS_RECONCILIATION"
									: snapshot.status === "RUNNING"
										? "RUNNING"
										: undefined,
						progress: result.progress,
						responseSnapshot: responseSnapshotForResult(result, attempt) as Prisma.InputJsonValue,
						providerCostMicros: providerCostForResult(result, attempt),
						uncertainSubmission: terminalFailure
							? !knownFailure
							: snapshot.status === "SUCCEEDED"
								? false
								: undefined,
						errorSnapshot: knownFailure
							? { code: knownFailure, retryable: imagePassFailure === undefined }
							: terminalFailure
								? manualReconciliationErrorSnapshot(
										attempt.errorSnapshot,
										"RECONCILIATION_TERMINAL_UNVERIFIED",
									)
								: undefined,
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						completedAt: knownFailure || snapshot.status === "SUCCEEDED" ? new Date() : undefined,
						nextReconcileAt:
							terminalFailure || snapshot.status === "SUCCEEDED"
								? null
								: await kieGenerationCallbackRetryAt(
										attempt,
										new Date(
											Date.now() +
												generationPollingDelaySeconds(attempt.submittedAt, new Date()) * 1_000,
										),
										tx,
									),
					},
				});
				if (changed.count !== 1) return { outboxCommitted: false };
				if (envelope) {
					await tx.generationAttemptTransferEnvelope.upsert({
						where: { attemptId: attempt.id },
						create: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(envelope) },
						update: { payload: outputTransferEnvelopeInput(envelope) },
					});
				}
				await options.afterAttemptUpdate?.();
				let outboxCommitted = false;
				if (snapshot.status === "SUCCEEDED") {
					await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: lease.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: { status: "FINALIZING", version: { increment: 1 } },
					});
					const inserted = await tx.outboxEvent.createMany({
						skipDuplicates: true,
						data: {
							eventType: "GENERATION_FINALIZE",
							aggregateType: "GENERATION_JOB",
							aggregateId: lease.jobId,
							dedupeKey: `generation-finalize:${lease.jobId}:${lease.attemptId}`,
							payload: { jobId: lease.jobId },
						},
					});
					outboxCommitted = inserted.count > 0;
				} else if (knownFailure) {
					const jobChanged = await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: attempt.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: {
							status: "FINALIZING",
							failureCode: knownFailure,
							version: { increment: 1 },
						},
					});
					if (jobChanged.count !== 1) throw new Error("TECHNICAL_FAILURE_JOB_STATE_CONFLICT");
					const inserted = await tx.outboxEvent.createMany({
						skipDuplicates: true,
						data: {
							eventType: "GENERATION_SETTLE",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-settle:${attempt.jobId}`,
							payload: { jobId: attempt.jobId },
						},
					});
					outboxCommitted = inserted.count > 0;
				} else if (terminalFailure) {
					const reservation = await getGenerationFundingReservation(lease.jobId, tx);
					if (!reservation || reservation.status !== "ACTIVE") {
						throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
					}
					const jobChanged = await tx.generationJob.updateMany({
						where: {
							executionEngine: "legacy",
							id: lease.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: {
							status: "NEEDS_RECONCILIATION",
							failureCode: "RECONCILIATION_TERMINAL_UNVERIFIED",
							version: { increment: 1 },
						},
					});
					if (jobChanged.count !== 1) {
						throw new Error("UNVERIFIED_RECONCILIATION_JOB_STATE_CONFLICT");
					}
					await tx.auditLog.create({
						data: {
							action: "MEDIA_RECONCILIATION_TERMINAL_UNVERIFIED",
							targetType: "GENERATION_ATTEMPT",
							targetId: attempt.id,
							metadata: {
								jobId: lease.jobId,
								providerStatus: snapshot.status,
								...fundingReservationAuditMetadata(reservation, true),
								pageAdmin: true,
							},
						},
					});
				}
				return { outboxCommitted };
			});
		},
		async releaseReconciliationLease(lease, code, retryAt) {
			await database.$transaction(async (tx) => {
				// Serialize with the callback before deciding whether backoff can advance.
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${lease.attemptId} AND "reconcileLeaseToken" = ${lease.leaseToken} FOR UPDATE`;
				if (!(await generationPhaseIsCurrent(lease.attemptId, lease.phaseOwner, tx))) return;
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
					},
					select: { id: true, provider: true, providerTaskId: true, errorSnapshot: true },
				});
				if (!attempt) return;
				const changed = await tx.generationAttempt.updateMany({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
					},
					data: {
						errorSnapshot: reconciliationErrorSnapshot(attempt.errorSnapshot, code),
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: await kieGenerationCallbackRetryAt(attempt, retryAt, tx),
					},
				});
				if (changed.count === 1 && lease.repairCount >= 5) {
					await tx.auditLog.create({
						data: {
							action: "MEDIA_RECONCILIATION_REPEATED",
							targetType: "GENERATION_ATTEMPT",
							targetId: lease.attemptId,
							metadata: { repairCount: lease.repairCount, code, pageAdmin: true },
						},
					});
				}
			});
		},
		async markUncertainForManualReconciliation(
			lease,
			code = "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
		) {
			await database.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "generation_attempt" WHERE "id" = ${lease.attemptId} AND "reconcileLeaseToken" = ${lease.leaseToken} FOR UPDATE`;
				if (!(await generationPhaseIsCurrent(lease.attemptId, lease.phaseOwner, tx))) return;
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
						status: { in: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] },
					},
					select: { errorSnapshot: true },
				});
				if (!attempt) return;
				const reservation = await getGenerationFundingReservation(lease.jobId, tx);
				const changed = await tx.generationAttempt.updateMany({
					where: {
						AND: { job: { executionEngine: "legacy" } },
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
						status: { in: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] },
					},
					data: {
						status: "NEEDS_RECONCILIATION",
						errorSnapshot: manualReconciliationErrorSnapshot(attempt.errorSnapshot, code),
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: null,
					},
				});
				if (changed.count !== 1) return;
				const jobChanged = await tx.generationJob.updateMany({
					where: {
						executionEngine: "legacy",
						id: lease.jobId,
						status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
					},
					data: {
						status: "NEEDS_RECONCILIATION",
						failureCode: safeRecoveryCode(code),
						version: { increment: 1 },
					},
				});
				if (jobChanged.count !== 1) throw new Error("UNCERTAIN_JOB_STATE_CONFLICT");
				if (!reservation || reservation.status !== "ACTIVE") {
					throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
				}
				await tx.auditLog.create({
					data: {
						action:
							safeRecoveryCode(code) === "PROVIDER_RECOVERY_UNAVAILABLE"
								? "MEDIA_PROVIDER_RECOVERY_UNAVAILABLE"
								: "MEDIA_SUBMISSION_NEEDS_RECONCILIATION",
						targetType: "GENERATION_ATTEMPT",
						targetId: lease.attemptId,
						metadata: {
							jobId: lease.jobId,
							repairCount: lease.repairCount,
							code: safeRecoveryCode(code),
							...fundingReservationAuditMetadata(reservation, true),
							pageAdmin: true,
						},
					},
				});
			});
		},
	};
}
export const databaseReconciliationStore: GenerationPollingStore =
	createDatabaseReconciliationStore(db);

function deterministicFraction(value: string): number {
	let hash = 0;
	for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
	return hash / 0x1_0000_0000;
}

type QuotedRouteUnavailableCode =
	| "QUOTED_INPUT_UNSUPPORTED"
	| "QUOTED_ROUTE_UNAVAILABLE"
	| "LEGACY_QUOTE_ROUTE_UNAVAILABLE";

type QuotedRouteResolution =
	| {
			kind: "RESOLVED";
			entry: ReturnType<typeof getCatalogEntry>;
			routes: CatalogRoute[];
			code: "QUOTED_ROUTE_UNAVAILABLE" | "LEGACY_QUOTE_ROUTE_UNAVAILABLE";
			diagnosticRoute?: CatalogRoute;
	  }
	| {
			kind: "UNAVAILABLE";
			code: QuotedRouteUnavailableCode;
			diagnosticRoute?: CatalogRoute;
	  };

function quotedExecutableRoutes(
	job: {
		productKey: string;
		catalogVersion: string;
		pricingVersion: string;
		inputSnapshot: unknown;
		pricingSnapshot: unknown;
		quote?: { costMicros: bigint };
	},
	enabledProviders: ReadonlySet<ProviderKey>,
	environment: Record<string, string | undefined>,
): QuotedRouteResolution {
	const submissionProviders = new Set<ProviderKey>(
		[...enabledProviders].filter((provider) => provider !== "openrouter"),
	);
	const pricingSnapshot = objectRecord(job.pricingSnapshot);
	const entry = getCatalogEntry(job.productKey as ProductModelKey);
	if (!entry) {
		return { kind: "UNAVAILABLE", code: "QUOTED_ROUTE_UNAVAILABLE" };
	}
	if (!isCatalogInputSupported(entry, job.inputSnapshot)) {
		return {
			kind: "UNAVAILABLE",
			code: "QUOTED_INPUT_UNSUPPORTED",
			diagnosticRoute: entry.routes[0],
		};
	}
	if (pricingSnapshot && "routeGraph" in pricingSnapshot) {
		const routeGraph = parseRouteGraphSnapshot({
			productKey: job.productKey,
			catalogVersion: job.catalogVersion,
			pricingVersion: job.pricingVersion,
			routeGraph: pricingSnapshot.routeGraph,
		});
		if (!routeGraph) {
			return {
				kind: "UNAVAILABLE",
				code: "QUOTED_ROUTE_UNAVAILABLE",
				diagnosticRoute: entry.routes[0],
			};
		}
		if (
			job.quote?.costMicros === undefined ||
			BigInt(routeGraph.maximumRouteCostMicros) > job.quote.costMicros
		) {
			return {
				kind: "UNAVAILABLE",
				code: "QUOTED_ROUTE_UNAVAILABLE",
				diagnosticRoute: routeGraph.allowedRoutes[0],
			};
		}
		// A valid frozen graph may outlive current catalog membership. The static manifest remains
		// the execution allowlist, while the current catalog is authoritative only for new quotes.
		const routes = routeGraph.allowedRoutes.filter(
			(route) =>
				submissionProviders.has(route.provider) &&
				isRuntimeRouteCertified(entry.mediaKind, route.provider, environment) &&
				isStaticDispatchRoute(entry.mediaKind, route.provider, route.providerModelId),
		);
		return routes.length > 0
			? {
					kind: "RESOLVED",
					entry,
					routes,
					code: "QUOTED_ROUTE_UNAVAILABLE",
					diagnosticRoute: routeGraph.allowedRoutes[0],
				}
			: {
					kind: "UNAVAILABLE",
					code: "QUOTED_ROUTE_UNAVAILABLE",
					diagnosticRoute: routeGraph.allowedRoutes[0],
				};
	}
	const maximumCost = job.quote?.costMicros;
	const routes =
		maximumCost === undefined
			? []
			: entry.routes.filter(
					(route) =>
						submissionProviders.has(route.provider) &&
						isRuntimeRouteCertified(entry.mediaKind, route.provider, environment) &&
						isStaticDispatchRoute(entry.mediaKind, route.provider, route.providerModelId) &&
						BigInt(route.providerCostMicros) <= maximumCost,
				);
	return routes.length > 0
		? {
				kind: "RESOLVED",
				entry,
				routes,
				code: "LEGACY_QUOTE_ROUTE_UNAVAILABLE",
				diagnosticRoute: entry.routes[0],
			}
		: {
				kind: "UNAVAILABLE",
				code: "LEGACY_QUOTE_ROUTE_UNAVAILABLE",
				diagnosticRoute: entry.routes[0],
			};
}

function isRuntimeRouteCertified(
	mediaKind: "image" | "video",
	provider: ProviderKey,
	environment: Record<string, string | undefined>,
): boolean {
	if (mediaKind !== "image") return true;
	if (provider === "openrouter") {
		return environment.MEDIA_OPENROUTER_IMAGE_ROUTES_CERTIFIED === "true";
	}
	return true;
}

async function markQuotedRouteUnavailable(
	database: Prisma.TransactionClient | PrismaClient,
	input: {
		jobId: string;
		code: QuotedRouteUnavailableCode | "DISPATCH_ROUTE_MISMATCH";
		diagnosticRoute?: CatalogRoute;
	},
): Promise<void> {
	const job = await database.generationJob.findUnique({
		where: { executionEngine: "legacy", id: input.jobId },
		include: {
			attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
			reservation: { select: { id: true, amount: true, status: true } },
		},
	});
	if (!job || !["RESERVED", "DISPATCH_QUEUED"].includes(job.status)) return;
	const reservation = await getGenerationFundingReservation(
		job.id,
		database,
		job.reservation ?? null,
	);
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const jobChanged = await database.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: job.id,
			status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
		},
		data: {
			status: "NEEDS_RECONCILIATION",
			failureCode: input.code,
			version: { increment: 1 },
		},
	});
	if (jobChanged.count !== 1) return;
	const attempt = job.attempts[0];
	if (attempt?.status === "CREATED") {
		await database.generationAttempt.updateMany({
			where: { AND: { job: { executionEngine: "legacy" } }, id: attempt.id, status: "CREATED" },
			data: {
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: false,
				errorSnapshot: manualReconciliationErrorSnapshot(attempt.errorSnapshot, input.code),
				nextReconcileAt: null,
			},
		});
	} else if (!attempt && input.diagnosticRoute) {
		await database.generationAttempt.create({
			data: {
				jobId: job.id,
				attemptNumber: 1,
				provider: input.diagnosticRoute.provider,
				providerModelId: input.diagnosticRoute.providerModelId,
				status: "NEEDS_RECONCILIATION",
				uncertainSubmission: false,
				requestSnapshot: {
					catalogRoute: input.diagnosticRoute.provider,
					routeUnavailable: true,
				} as Prisma.InputJsonValue,
				errorSnapshot: manualReconciliationErrorSnapshot({}, input.code),
			},
		});
	}
	await database.auditLog.create({
		data: {
			action: "MEDIA_DISPATCH_ROUTE_UNAVAILABLE",
			targetType: "GENERATION_JOB",
			targetId: job.id,
			metadata: {
				code: input.code,
				...fundingReservationAuditMetadata(reservation, true),
				pageAdmin: true,
			},
		},
	});
}

async function requeueDispatchBlockedByKillSwitch(
	tx: Prisma.TransactionClient,
	job: { id: string; version: number; status: string },
): Promise<boolean> {
	const changed = await tx.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: job.id,
			version: job.version,
			status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
		},
		data: { version: { increment: 1 } },
	});
	if (changed.count !== 1) return false;
	const version = job.version + 1;
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-dispatch-kill-switch:${job.id}:${version}` },
		create: {
			eventType: "GENERATION_DISPATCH",
			aggregateType: "GENERATION_JOB",
			aggregateId: job.id,
			dedupeKey: `generation-dispatch-kill-switch:${job.id}:${version}`,
			payload: { jobId: job.id, version },
		},
		update: {},
	});
	return true;
}

async function isMediaGenerationDisabled(
	database: Pick<PrismaClient, "runtimeConfigOverride">,
	productKey: string,
	environment: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (!isEzPicProductEnvironmentEnabled(productKey, environment)) return true;
	return Boolean(
		await database.runtimeConfigOverride.findFirst({
			where: {
				active: true,
				value: { equals: false },
				OR: [
					{ configKey: "media.generation.enabled" },
					{ configKey: `media.model.${productKey}.enabled` },
				],
			},
			select: { id: true },
		}),
	);
}

async function guestRuntimeEnabled(
	database: Pick<Prisma.TransactionClient, "runtimeConfigOverride">,
	environment: Record<string, string | undefined>,
	promotionPeriod: string,
): Promise<boolean> {
	const override = await resolveGuestRuntimeConfigOverride(database);
	const config = getGuestMediaConfig(environment, override);
	return config.enabled && config.promotionPeriod === promotionPeriod;
}

async function guestDispatchChecksPass(
	tx: Prisma.TransactionClient,
	job: {
		id: string;
		ownerId: string;
		productKey: string;
		serviceClass: string;
		status: string;
		guestTrialId: string | null;
		creditsReserved: bigint;
		createdAt: Date;
		dispatchEligibleAt: Date | null;
		quote: { costMicros: bigint };
	},
	trial: {
		id: string;
		ownerId: string | null;
		promotionPeriod: string;
		eligibility: string;
		riskState: string;
		frozenQuotedRiskMicros: bigint;
		sponsorCredits: bigint;
		currentJobId: string | null;
		consumedJobId: string | null;
		expiresAt: Date;
		linkedAt: Date | null;
		providerBoundaryAt: Date | null;
		linkIntents: Array<{ state: string }>;
	},
	environment: Record<string, string | undefined>,
	now: Date,
): Promise<boolean> {
	const config = getGuestMediaConfig(environment, true);
	if (
		job.serviceClass !== "GUEST_SLOW" ||
		job.status !== "DISPATCH_QUEUED" ||
		job.productKey !== config.productKey ||
		job.guestTrialId !== trial.id ||
		job.ownerId !== trial.ownerId ||
		job.creditsReserved <= 0n ||
		job.creditsReserved !== trial.sponsorCredits ||
		job.quote.costMicros !== trial.frozenQuotedRiskMicros ||
		trial.currentJobId !== job.id ||
		trial.consumedJobId !== null ||
		trial.eligibility !== "IN_FLIGHT" ||
		trial.riskState !== "HELD" ||
		trial.providerBoundaryAt !== null ||
		trial.expiresAt <= now ||
		(job.dispatchEligibleAt !== null && job.dispatchEligibleAt > now) ||
		!(await guestRuntimeEnabled(tx, environment, trial.promotionPeriod))
	) {
		return false;
	}
	const risk = await tx.guestRiskBudgetBucket.findUnique({
		where: {
			promotionPeriod_subjectHash: {
				promotionPeriod: trial.promotionPeriod,
				subjectHash: "global",
			},
		},
	});
	if (
		!risk ||
		risk.expiresAt <= now ||
		risk.reservedMicros < trial.frozenQuotedRiskMicros ||
		(risk.hardLimitMicros !== null &&
			risk.reservedMicros + risk.consumedMicros > risk.hardLimitMicros) ||
		(config.riskBudgetMicros !== null &&
			risk.reservedMicros + risk.consumedMicros > config.riskBudgetMicros)
	) {
		return false;
	}
	const globalBudget = mediaDailyProviderCostBudgetMicros(environment);
	// An explicitly uncapped guest promotion has no aggregate spend gate. Registered
	// generation retains its own daily budget; quotes and guest cost accounting remain intact.
	if (
		globalBudget !== undefined &&
		(config.riskBudgetMicros !== null || risk.hardLimitMicros !== null)
	) {
		const utcDay = now.toISOString().slice(0, 10);
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:global-daily-provider-budget:${utcDay}`}, 0))`;
		if (
			(await getCommittedGlobalDailyGenerationCost({ now }, tx)) + trial.frozenQuotedRiskMicros >
			globalBudget
		) {
			return false;
		}
	}
	return true;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function legacyOutputsFromResponseSnapshot(value: unknown): ProviderOutput[] {
	const record = objectRecord(value);
	return Array.isArray(record?.outputs) ? (record.outputs as ProviderOutput[]) : [];
}

function safeResponseSnapshot(
	value: unknown,
	outputCountOverride?: number,
	identity?: ProviderAttemptIdentity,
): Prisma.InputJsonValue {
	const record = objectRecord(value);
	const providerTerminalEvidence = identity
		? readProviderTerminalEvidence(record?.providerTerminalEvidence, identity)
		: null;
	const outputCount =
		outputCountOverride ??
		(Array.isArray(record?.outputs)
			? record.outputs.length
			: typeof record?.outputCount === "number" &&
				  Number.isSafeInteger(record.outputCount) &&
				  record.outputCount >= 0
				? record.outputCount
				: 0);
	return {
		providerCharged: record?.providerCharged === true,
		outputCount,
		...(providerTerminalEvidence ? { providerTerminalEvidence } : {}),
	};
}

function mediaKindForJob(productKey: string): "image" | "video" {
	const entry = getCatalogEntry(productKey as ProductModelKey);
	if (!entry) throw new Error("Catalog product is unavailable for output transfer");
	return entry.mediaKind;
}

function outputTransferEnvelopeInput(envelope: OutputTransferEnvelope): Prisma.InputJsonValue {
	const outputs: Prisma.InputJsonObject[] = envelope.outputs.map((output) =>
		output.kind === "remote-url"
			? { kind: output.kind, url: output.url }
			: { kind: output.kind, mimeType: output.mimeType, data: output.data },
	);
	return { version: envelope.version, outputs };
}

type AttemptState =
	| "CREATED"
	| "SUBMISSION_UNCERTAIN"
	| "SUBMITTED"
	| "RUNNING"
	| "NEEDS_RECONCILIATION"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELED";
type JobState =
	| "RESERVED"
	| "DISPATCH_QUEUED"
	| "SUBMITTING"
	| "PROVIDER_PENDING"
	| "PROVIDER_RUNNING"
	| "NEEDS_RECONCILIATION"
	| "FINALIZING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELED";

async function completeProviderWebhookEvent(
	tx: Prisma.TransactionClient,
	claim: { eventId: string; processingToken: string },
	failureReason?: string,
): Promise<void> {
	await tx.providerWebhookEvent.updateMany({
		where: { id: claim.eventId, processingToken: claim.processingToken },
		data: {
			status: "PROCESSED",
			...(failureReason ? { failureReason } : {}),
			processedAt: new Date(),
			processingToken: null,
			processingLeasedUntil: null,
		},
	});
}

async function moveAttemptToManualReconciliation(
	tx: Prisma.TransactionClient,
	input: {
		attempt: { id: string; jobId: string; status: string; errorSnapshot: unknown };
		jobStatus: string;
		code: string;
		attemptStatuses: readonly AttemptState[];
		jobStatuses: readonly JobState[];
		action: string;
		uncertainSubmission: boolean;
		reconcileLeaseToken?: string;
	},
): Promise<boolean> {
	if (!input.attemptStatuses.includes(input.attempt.status as AttemptState)) return false;
	if (!input.jobStatuses.includes(input.jobStatus as JobState)) return false;
	const reservation = await getGenerationFundingReservation(input.attempt.jobId, tx);
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const jobChanged = await tx.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: input.attempt.jobId,
			status: { in: [...input.jobStatuses] },
		},
		data: {
			status: "NEEDS_RECONCILIATION",
			failureCode: safeRecoveryCode(input.code),
			version: { increment: 1 },
		},
	});
	if (jobChanged.count !== 1) return false;
	const attemptChanged = await tx.generationAttempt.updateMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			id: input.attempt.id,
			status: { in: [...input.attemptStatuses] },
			...(input.reconcileLeaseToken ? { reconcileLeaseToken: input.reconcileLeaseToken } : {}),
		},
		data: {
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: input.uncertainSubmission,
			errorSnapshot: manualReconciliationErrorSnapshot(input.attempt.errorSnapshot, input.code),
			reconcileLeaseToken: null,
			reconcileLeasedUntil: null,
			nextReconcileAt: null,
		},
	});
	if (attemptChanged.count !== 1) {
		throw new Error("MANUAL_RECONCILIATION_ATTEMPT_STATE_CONFLICT");
	}
	await tx.auditLog.create({
		data: {
			action: input.action,
			targetType: "GENERATION_ATTEMPT",
			targetId: input.attempt.id,
			metadata: {
				jobId: input.attempt.jobId,
				code: safeRecoveryCode(input.code),
				...fundingReservationAuditMetadata(reservation, true),
				pageAdmin: true,
			},
		},
	});
	return true;
}

async function recoverManualProviderSuccess(
	tx: Prisma.TransactionClient,
	input: {
		attempt: {
			id: string;
			jobId: string;
			status: string;
			progress: number | null;
			provider: string;
			providerTaskId: string | null;
			providerCostMicros: bigint | null;
			responseSnapshot: unknown;
		};
		job: { status: string };
		result: {
			progress: number | null;
			providerCostMicros: number | null;
			providerCharged: boolean;
			outputs: ProviderOutput[];
		};
		envelope: OutputTransferEnvelope;
		providerEvent?: {
			canonicalTime: Date;
			occurredAt?: Date;
			receivedAt: Date;
			sequence?: bigint;
		};
	},
): Promise<void> {
	if (
		input.attempt.status !== "NEEDS_RECONCILIATION" ||
		input.job.status !== "NEEDS_RECONCILIATION"
	) {
		throw new Error("MANUAL_RECOVERY_STATE_CONFLICT");
	}
	const reservation = await getGenerationFundingReservation(input.attempt.jobId, tx);
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	await tx.generationAttemptTransferEnvelope.upsert({
		where: { attemptId: input.attempt.id },
		create: { attemptId: input.attempt.id, payload: outputTransferEnvelopeInput(input.envelope) },
		update: { payload: outputTransferEnvelopeInput(input.envelope) },
	});
	const attemptChanged = await tx.generationAttempt.updateMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			id: input.attempt.id,
			status: "NEEDS_RECONCILIATION",
		},
		data: {
			status: "SUCCEEDED",
			progress:
				input.result.progress === null
					? input.attempt.progress
					: Math.max(input.attempt.progress ?? 0, Math.min(100, Math.round(input.result.progress))),
			providerCostMicros: providerCostForResult(input.result, input.attempt),
			responseSnapshot: responseSnapshotForResult(
				input.result,
				input.attempt,
			) as Prisma.InputJsonValue,
			uncertainSubmission: false,
			errorSnapshot: {},
			...(input.providerEvent
				? {
						lastProviderEventAt: input.providerEvent.canonicalTime,
						lastProviderOccurredAt: input.providerEvent.occurredAt,
						lastProviderReceivedAt: input.providerEvent.receivedAt,
						lastProviderSequence: input.providerEvent.sequence,
					}
				: {}),
			reconcileLeaseToken: null,
			reconcileLeasedUntil: null,
			nextReconcileAt: null,
			completedAt: new Date(),
		},
	});
	if (attemptChanged.count !== 1) throw new Error("MANUAL_RECOVERY_ATTEMPT_STATE_CONFLICT");
	const jobChanged = await tx.generationJob.updateMany({
		where: { executionEngine: "legacy", id: input.attempt.jobId, status: "NEEDS_RECONCILIATION" },
		data: {
			status: "FINALIZING",
			failureCode: null,
			finalizationStage: null,
			finalizationErrorCode: null,
			nextFinalizeAt: null,
			version: { increment: 1 },
		},
	});
	if (jobChanged.count !== 1) throw new Error("MANUAL_RECOVERY_JOB_STATE_CONFLICT");
	await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-finalize:${input.attempt.jobId}:${input.attempt.id}` },
		create: {
			eventType: "GENERATION_FINALIZE",
			aggregateType: "GENERATION_JOB",
			aggregateId: input.attempt.jobId,
			dedupeKey: `generation-finalize:${input.attempt.jobId}:${input.attempt.id}`,
			payload: { jobId: input.attempt.jobId },
		},
		update: {},
	});
	await tx.auditLog.create({
		data: {
			action: "MEDIA_PROVIDER_SUCCESS_RECOVERED",
			targetType: "GENERATION_ATTEMPT",
			targetId: input.attempt.id,
			metadata: {
				jobId: input.attempt.jobId,
				...fundingReservationAuditMetadata(reservation),
				outputCount: input.envelope.outputs.length,
				pageAdmin: true,
			},
		},
	});
}

async function transitionTerminalSuccessWithoutMedia(
	tx: Prisma.TransactionClient,
	input: {
		attemptId: string;
		jobId: string;
		errorSnapshot: unknown;
		responseSnapshot: Prisma.InputJsonValue;
		reconcileLeaseToken?: string;
		attemptData?: Prisma.GenerationAttemptUpdateManyMutationInput;
		reasonCode?: string;
	},
): Promise<void> {
	const reasonCode = safeRecoveryCode(input.reasonCode ?? "TERMINAL_SUCCESS_WITHOUT_MEDIA");
	const reservation = await getGenerationFundingReservation(input.jobId, tx);
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const attemptChanged = await tx.generationAttempt.updateMany({
		where: {
			AND: { job: { executionEngine: "legacy" } },
			id: input.attemptId,
			status: { in: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING", "SUCCEEDED"] },
			...(input.reconcileLeaseToken ? { reconcileLeaseToken: input.reconcileLeaseToken } : {}),
		},
		data: {
			...(input.attemptData ?? {}),
			status: "NEEDS_RECONCILIATION",
			uncertainSubmission: true,
			errorSnapshot: manualReconciliationErrorSnapshot(input.errorSnapshot, reasonCode),
			responseSnapshot: input.responseSnapshot,
			reconcileLeaseToken: null,
			reconcileLeasedUntil: null,
			nextReconcileAt: null,
			completedAt: new Date(),
		},
	});
	if (attemptChanged.count !== 1) return;
	const jobChanged = await tx.generationJob.updateMany({
		where: {
			executionEngine: "legacy",
			id: input.jobId,
			status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING", "FINALIZING"] },
		},
		data: {
			status: "NEEDS_RECONCILIATION",
			failureCode: reasonCode,
			version: { increment: 1 },
		},
	});
	if (jobChanged.count !== 1) throw new Error("UNCERTAIN_JOB_STATE_CONFLICT");
	await tx.auditLog.create({
		data: {
			action: "MEDIA_TERMINAL_SUCCESS_WITHOUT_MEDIA",
			targetType: "GENERATION_ATTEMPT",
			targetId: input.attemptId,
			metadata: {
				jobId: input.jobId,
				...fundingReservationAuditMetadata(reservation, true),
				code: reasonCode,
				pageAdmin: true,
			},
		},
	});
}

function preSendAttemptState(
	input: {
		attemptId: string;
		attemptNumber: number;
		jobId: string;
		provider: string;
		providerModelId: string;
		inputSnapshot: unknown;
	},
	now: Date,
): Prisma.GenerationAttemptUpdateInput {
	const requestFingerprint = createHash("sha256")
		.update(
			canonicalJson({
				version: 1,
				attemptId: input.attemptId,
				attemptNumber: input.attemptNumber,
				jobId: input.jobId,
				provider: input.provider,
				providerModelId: input.providerModelId,
				inputSnapshot: input.inputSnapshot,
			}),
		)
		.digest("hex");
	return {
		status: "SUBMISSION_UNCERTAIN",
		uncertainSubmission: true,
		submittedAt: now,
		nextReconcileAt: new Date(now.getTime() + 30_000),
		requestSnapshot: {
			attemptNumber: input.attemptNumber,
			catalogRoute: input.provider,
			provider: input.provider,
			providerModelId: input.providerModelId,
			requestFingerprint,
			submissionPhase: "pre_send",
		} as Prisma.InputJsonValue,
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Provider request fingerprint is not JSON-safe");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.filter((key) => record[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("Provider request fingerprint is not JSON-safe");
}

function safeUncertainRecoveryEvidence(
	provider: string,
	evidence: UncertainSubmissionEvidence,
): Prisma.GenerationAttemptUpdateInput {
	const providerTaskId = boundedString(evidence.providerTaskId, 512);
	const reconciliationEndpoints = safeReconciliationEndpoints(provider, providerTaskId, evidence);
	const submissionToken = boundedString(evidence.submissionToken, 256);
	return {
		...(providerTaskId ? { providerTaskId } : {}),
		...reconciliationEndpoints,
		...(submissionToken ? { submissionToken } : {}),
		errorSnapshot: {
			classification: evidence.classification,
			phase: evidence.phase,
			...(evidence.statusCode !== undefined ? { statusCode: evidence.statusCode } : {}),
			...(evidence.providerStatus ? { providerStatus: evidence.providerStatus } : {}),
			...(evidence.providerIdempotencySupported !== undefined
				? { providerIdempotencySupported: evidence.providerIdempotencySupported }
				: {}),
		} as Prisma.InputJsonValue,
	};
}

function reconciliationErrorSnapshot(existing: unknown, code: string): Prisma.InputJsonValue {
	return {
		...allowlistedUncertaintyEvidence(existing),
		lastReconciliationCode: safeRecoveryCode(code),
	};
}

function manualReconciliationErrorSnapshot(existing: unknown, code: string): Prisma.InputJsonValue {
	return {
		...allowlistedUncertaintyEvidence(existing),
		code: safeRecoveryCode(code),
		retryable: false,
		manualResolution: true,
	};
}

function allowlistedUncertaintyEvidence(
	existing: unknown,
): Record<string, string | number | boolean> {
	const record = objectRecord(existing);
	if (!record) return {};
	const evidence: Record<string, string | number | boolean> = {};
	if (
		record.classification === "ambiguous_http" ||
		record.classification === "malformed_2xx" ||
		record.classification === "transport"
	) {
		evidence.classification = record.classification;
	}
	if (record.phase === "pre_send" || record.phase === "post_send") evidence.phase = record.phase;
	if (
		typeof record.statusCode === "number" &&
		Number.isInteger(record.statusCode) &&
		record.statusCode >= 100 &&
		record.statusCode <= 599
	) {
		evidence.statusCode = record.statusCode;
	}
	if (
		record.providerStatus === "UNKNOWN" ||
		record.providerStatus === "QUEUED" ||
		record.providerStatus === "RUNNING" ||
		record.providerStatus === "SUCCEEDED" ||
		record.providerStatus === "FAILED" ||
		record.providerStatus === "CANCELED"
	) {
		evidence.providerStatus = record.providerStatus;
	}
	if (typeof record.providerIdempotencySupported === "boolean") {
		evidence.providerIdempotencySupported = record.providerIdempotencySupported;
	}
	return evidence;
}

function safeRecoveryCode(value: string): string {
	return /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : "RECONCILIATION_RETRY";
}

function boundedString(value: string | undefined, maximumLength: number): string | undefined {
	return value && value.length <= maximumLength ? value : undefined;
}

function safeReconciliationEndpoints(
	provider: string,
	providerTaskId: string | undefined,
	endpoints: { statusUrl?: string; resultUrl?: string },
): { providerStatusUrl: string | null; providerResultUrl: string | null } {
	return {
		providerStatusUrl:
			safeProviderEndpoint(provider, "status", endpoints.statusUrl, providerTaskId) ?? null,
		providerResultUrl:
			safeProviderEndpoint(provider, "result", endpoints.resultUrl, providerTaskId) ?? null,
	};
}

function safeProviderEndpoint(
	provider: string,
	kind: "status" | "result",
	value: string | undefined,
	providerTaskId: string | undefined,
): string | undefined {
	const bounded = boundedString(value, 1_024);
	if (!bounded || bounded !== bounded.trim()) return undefined;
	if (provider === "kie") {
		if (kind !== "status" || !providerTaskId) return undefined;
		const expected = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`;
		return bounded === expected ? expected : undefined;
	}
	// Fal returns provider endpoints for both polling and result retrieval. Other adapters
	// reconstruct their official API URL from the task ID and must not persist a remote URL.
	if (provider !== "fal") return undefined;
	if (rawUrlAuthority(bounded)?.toLowerCase() !== "queue.fal.run") {
		return undefined;
	}
	let endpoint: URL;
	try {
		endpoint = new URL(bounded);
	} catch {
		return undefined;
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.port ||
		endpoint.search ||
		endpoint.hash
	) {
		return undefined;
	}
	if (endpoint.hostname !== "queue.fal.run") return undefined;
	return endpoint.toString();
}

function rawUrlAuthority(value: string): string | undefined {
	const schemeSeparator = value.indexOf("://");
	if (schemeSeparator === -1) return undefined;
	const authorityStart = schemeSeparator + 3;
	const authorityEnd = value.slice(authorityStart).search(/[/?#]/u);
	return authorityEnd === -1
		? value.slice(authorityStart)
		: value.slice(authorityStart, authorityStart + authorityEnd);
}

function createSafetyAdapter(environment: NodeJS.ProcessEnv) {
	return createConfiguredImageSafetyAdapter(environment);
}

function webhookStatus(envelope: Prisma.JsonValue) {
	const rawStatus =
		typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)
			? envelope.status
			: undefined;
	const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : "unknown";
	if (["succeeded", "successful", "completed"].includes(status)) return "SUCCEEDED" as const;
	if (["failed", "error"].includes(status)) return "FAILED" as const;
	if (["canceled", "cancelled"].includes(status)) return "CANCELED" as const;
	if (["running", "processing", "starting"].includes(status)) return "RUNNING" as const;
	if (["queued", "pending"].includes(status)) return "QUEUED" as const;
	return "UNKNOWN" as const;
}
