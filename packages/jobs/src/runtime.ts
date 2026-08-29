import { createHash } from "node:crypto";

import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	KieProviderAdapter,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	MediaProviderRegistry,
	createReplicateWebhookVerifier,
	ReplicateProviderAdapter,
	SightengineSafetyAdapter,
	TestMediaSafetyAdapter,
	type CatalogRoute,
	type MediaProviderAdapter,
	type MediaProviderRegistry as ProviderRegistry,
	type ModerationDecision,
	type ProviderExecutionInput,
	type ProviderKey,
	type ProviderOutput,
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
import type { ProductModelKey } from "@repo/config";
import {
	getGuestMediaConfig,
	isEzPicProductEnvironmentEnabled,
	maximumMediaStorageBytes,
	mediaDailyProviderCostBudgetMicros,
} from "@repo/config/server";
import {
	claimGenerationOutputTransferTransaction,
	claimOutboxBatch,
	completeGenerationOutputTransferTransaction,
	completeOutboxEvent,
	deriveGuestQueueEstimate,
	expireGuestJobBeforeProvider,
	expireGuestMediaTransaction,
	failGenerationOutputTransferTransaction,
	GenerationOutputStorageError,
	getCommittedGlobalDailyGenerationCost,
	recordGenerationOutputPromotionMultipartTransaction,
	releaseOutboxEvent,
	resolveGuestRuntimeConfigOverride,
	reserveGenerationOutputStorageTransaction,
	runSerializable,
	settleCreditsInTransaction,
} from "@repo/database";
import type { Prisma } from "@repo/database";
import { db } from "@repo/database/client";
import type { PrismaClient } from "@repo/database/generated-client";
import {
	abortMultipartUpload,
	assertMediaKind,
	createAssetObjectKey,
	createStagingObjectKey,
	createSignedReadUrl,
	decodeInlineBase64MediaOutput,
	deleteObject,
	detectMediaType,
	headObject,
	inspectPrivateMediaObject,
	listMultipartUploads,
	MediaValidationError,
	promoteStagedObject,
	putPrivateMediaObject,
	readMediaHeader,
	RemoteMediaPolicyError,
	streamRemoteObjectToStorage,
	GUEST_WATERMARK_VERSION,
	watermarkStagedGuestImage,
} from "@repo/storage";
import type { MediaObjectMetadata } from "@repo/storage";

import {
	DispatchAdmissionBlockedError,
	type DispatchStore,
	type FinalizationDependencies,
	type FinalizationClaim,
	type FinalizationFailure,
	type FinalizationStore,
	type GuestAdmissionDependencies,
	type GuestMediaExpiryDependencies,
	type OutboxStore,
	type ProviderCancellationStore,
	type ProviderEventStore,
	type ReconciliationStore,
	type SettlementStore,
	type UncertainSubmissionEvidence,
} from "./contracts";
import type { StorageCleanupDependencies } from "./handlers/cleanup-storage-object";
import {
	createOutputTransferEnvelope,
	providerOutputsFromTransferEnvelope,
	responseSnapshotForResult,
} from "./output-transfer-envelope";
import type { OutputTransferEnvelope } from "./output-transfer-envelope";
import { providerCdnAllowlist } from "./provider-output-policy";
import { dispatchRouteFor, providerQueueKey } from "./queues";

export interface ProviderRegistryOptions {
	includeRecoveryProviders?: boolean;
}

export function createProviderRegistry(
	environment = process.env,
	options: ProviderRegistryOptions = {},
): ProviderRegistry {
	const configuredProviders = configuredProviderKeysFromEnvironment(environment);
	const requestedProviders = options.includeRecoveryProviders
		? new Set([...configuredProviders, ...recoveryProviderKeysFromEnvironment(environment)])
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
		...configuredProviderKeysFromEnvironment(environment),
		...recoveryProviderKeysFromEnvironment(environment),
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
	return registry;
}

export function createProviderWebhookVerifierRegistry(
	environment = process.env,
): ReadonlyMap<ProviderKey, Pick<MediaProviderAdapter, "verifyWebhook">> {
	const providers = new Set([
		...configuredProviderKeysFromEnvironment(environment),
		...recoveryProviderKeysFromEnvironment(environment),
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
		where: { id: jobId },
		include: {
			attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
			quote: { select: { costMicros: true } },
		},
	});
	if (!job) throw new Error("Generation job not found");
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
	const retryDelayMs = options.retryDelayMs ?? 30_000;
	const queueCapacity = options.queueCapacity ?? 1;
	const serviceTimeMs = options.serviceTimeMs ?? 60_000;
	return {
		async admit(input) {
			return database.$transaction(
				async (tx) => {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('guest-dispatch-global', 0))`;
					const job = await tx.generationJob.findUnique({
						where: { id: input.jobId },
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
					if (
						input.now.getTime() - job.createdAt.getTime() >= 10 * 60_000 ||
						trial.expiresAt <= input.now
					) {
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
					if (job.dispatchEligibleAt && job.dispatchEligibleAt > input.now) {
						return { outcome: "BUSY" as const, retryAt: job.dispatchEligibleAt };
					}
					const active = await tx.generationJob.findFirst({
						where: {
							serviceClass: "GUEST_SLOW",
							id: { not: job.id },
							status: {
								in: [
									"DISPATCH_QUEUED",
									"SUBMITTING",
									"PROVIDER_PENDING",
									"PROVIDER_RUNNING",
									"NEEDS_RECONCILIATION",
									"FINALIZING",
								],
							},
						},
						select: { id: true },
					});
					const [oldest] = await tx.$queryRaw<Array<{ id: string }>>`
						SELECT "id"
						FROM "generation_job"
						WHERE "serviceClass" = 'GUEST_SLOW'::"GenerationServiceClass"
						  AND "status" = 'RESERVED'::"GenerationJobStatus"
						  AND ("dispatchEligibleAt" IS NULL OR "dispatchEligibleAt" <= ${input.now})
						ORDER BY "createdAt" ASC, "id" ASC
						FOR UPDATE SKIP LOCKED
						LIMIT 1
					`;
					if (active || oldest?.id !== job.id) {
						const retryAt = new Date(
							Math.min(input.now.getTime() + retryDelayMs, trial.expiresAt.getTime() - 1),
						);
						const queueDepth = await tx.generationJob.count({
							where: {
								serviceClass: "GUEST_SLOW",
								id: { not: job.id },
								status: {
									in: [
										"RESERVED",
										"DISPATCH_QUEUED",
										"SUBMITTING",
										"PROVIDER_PENDING",
										"PROVIDER_RUNNING",
										"NEEDS_RECONCILIATION",
										"FINALIZING",
									],
								},
							},
						});
						const estimate = deriveGuestQueueEstimate({
							now: input.now,
							queueDepth,
							queueCapacity,
							serviceTimeMs,
							immutableExpiry: trial.expiresAt,
						});
						if (!estimate) {
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
						await updateGuestQueueEstimate(tx, job.id, trial.id, retryAt, estimate);
						return { outcome: "BUSY" as const, retryAt };
					}
					const changed = await tx.generationJob.updateMany({
						where: {
							id: job.id,
							version: job.version,
							status: "RESERVED",
							serviceClass: "GUEST_SLOW",
						},
						data: { status: "DISPATCH_QUEUED", version: { increment: 1 } },
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

async function updateGuestQueueEstimate(
	tx: Prisma.TransactionClient,
	jobId: string,
	trialId: string,
	retryAt: Date,
	estimate: { projectedDispatchAt: Date; estimateExpiresAt: Date },
): Promise<void> {
	await tx.generationJob.update({
		where: { id: jobId },
		data: { dispatchEligibleAt: retryAt },
	});
	await tx.guestMediaTrial.update({
		where: { id: trialId },
		data: estimate,
	});
}

export function createDatabaseDispatchStore(
	database: PrismaClient,
	options: DispatchRuntimeOptions = {},
): DispatchStore {
	const environment = options.environment ?? process.env;
	const enabledProviders =
		options.enabledProviders ?? locallyExecutableProviderKeysFromEnvironment(environment);
	return {
		async claimDispatch(payload) {
			if (environment.MEDIA_GENERATION_ENABLED !== "true") {
				throw new DispatchAdmissionBlockedError();
			}
			const claim = await database.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-dispatch:${payload.jobId}`}, 0))`;
				const job = await tx.generationJob.findFirst({
					where: {
						id: payload.jobId,
						version: payload.version,
						status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
					},
					include: {
						attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
						assets: true,
						quote: { select: { costMicros: true } },
						guestTrial: { include: { linkIntents: { select: { state: true } } } },
					},
				});
				if (!job) return null;
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
				if (isGuest && existing) return null;
				if (existing && existing.status !== "CREATED") return null;
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
				const resolution = quotedExecutableRoutes(job, enabledProviders);
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
				const rawInput = job.inputSnapshot as unknown as ProviderExecutionInput & {
					sourceAssetId?: string;
				};
				let input: ProviderExecutionInput = rawInput;
				if (rawInput.sourceAssetId) {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${rawInput.sourceAssetId}`}, 0))`;
					const binding = await tx.generationJobAsset.findFirst({
						where: { jobId: job.id, assetId: rawInput.sourceAssetId, role: "INPUT" },
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
					if (!binding || binding.asset.status !== "READY") {
						throw new Error("Input asset is not ready");
					}
					if (!binding.asset.checksum || binding.assetChecksum !== binding.asset.checksum) {
						throw new Error("Input asset checksum no longer matches job binding");
					}
					const currentProvider = environment.MEDIA_SAFETY_ADAPTER ?? "test";
					const evidence = binding.asset.moderationResults[0];
					const verificationValidUntil = binding.asset.verificationValidUntil;
					const now = new Date();
					if (
						!verificationValidUntil ||
						verificationValidUntil <= now ||
						binding.asset.verificationProvider !== currentProvider ||
						binding.asset.verificationRuleVersion !== MEDIA_VERIFICATION_RULE_VERSION ||
						binding.asset.verificationPolicyVersion !== MEDIA_VERIFICATION_POLICY_VERSION ||
						evidence?.status !== "APPROVED" ||
						evidence.verificationGeneration !== binding.asset.verificationGeneration ||
						evidence.attemptNumber !== binding.asset.verificationAttemptCount ||
						evidence.assetChecksum !== binding.asset.checksum ||
						evidence.evidenceKind !== binding.asset.kind ||
						evidence.provider !== binding.asset.verificationProvider ||
						evidence.providerTaskId !== binding.asset.verificationProviderTaskId ||
						evidence.ruleVersion !== binding.asset.verificationRuleVersion ||
						evidence.policyVersion !== binding.asset.verificationPolicyVersion ||
						!evidence.validUntil ||
						evidence.validUntil.getTime() !== verificationValidUntil.getTime() ||
						evidence.validUntil <= now
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
					where: { id: job.id, version: job.version, status: job.status },
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
				await tx.generationAttempt.update({
					where: { id: attempt.id },
					data: preSendAttemptState(
						{
							attemptId: attempt.id,
							attemptNumber: attempt.attemptNumber,
							jobId: job.id,
							provider: route.provider,
							providerModelId: route.providerModelId,
							inputSnapshot: job.inputSnapshot,
						},
						now,
					),
				});
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
							: undefined,
				};
			});
			if (claim === dispatchAdmissionBlocked) throw new DispatchAdmissionBlockedError();
			return claim;
		},
		async recordSubmissionStarted(attemptId) {
			const attempt = await database.generationAttempt.findUniqueOrThrow({
				where: { id: attemptId },
				include: { job: { select: { inputSnapshot: true } } },
			});
			await database.generationAttempt.update({
				where: { id: attemptId },
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
		},
		async recordSubmission(attemptId, submission) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				if (submission.outcome !== "accepted") {
					throw new Error("Only accepted provider submissions may be recorded as submitted");
				}
				const providerTaskId = boundedString(submission.providerTaskId, 512);
				if (!providerTaskId) {
					throw new Error("Accepted provider submission omitted its task ID");
				}
				const terminal = submission.status === "SUCCEEDED";
				const submissionToken = boundedString(submission.reconciliation.submissionToken, 256);
				const reconciliationEndpoints = safeReconciliationEndpoints(
					attempt.provider,
					submission.reconciliation,
				);
				await tx.generationAttempt.update({
					where: { id: attempt.id },
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
						nextReconcileAt: terminal ? null : new Date(Date.now() + 30_000),
					},
				});
				await tx.generationJob.updateMany({
					where: { id: attempt.jobId, status: "SUBMITTING" },
					data: {
						status: terminal ? "FINALIZING" : "PROVIDER_PENDING",
						version: { increment: 1 },
					},
				});
				if (terminal) {
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
				}
			});
		},
		async recordUncertainSubmission(attemptId, evidence) {
			await database.$transaction(async (tx) => {
				const existing = await tx.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				const recovery = safeUncertainRecoveryEvidence(existing.provider, evidence);
				const attempt = await tx.generationAttempt.update({
					where: { id: attemptId },
					data: {
						...recovery,
						status: "SUBMISSION_UNCERTAIN",
						uncertainSubmission: true,
						submittedAt: new Date(),
						nextReconcileAt: new Date(Date.now() + 30_000),
					},
				});
				const changed = await tx.generationJob.updateMany({
					where: { id: attempt.jobId, status: "SUBMITTING" },
					data: { status: "PROVIDER_PENDING", version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new Error("Uncertain submission job state changed");
			});
		},
		async recordProviderAdapterUnavailable(attemptId) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUnique({
					where: { id: attemptId },
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
		async recordSynchronousCompletion(attemptId, submission, result) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { id: attemptId },
					include: { job: { select: { productKey: true } } },
				});
				if (submission.outcome !== "accepted") {
					throw new Error("Only accepted provider submissions may complete synchronously");
				}
				const providerTaskId = boundedString(submission.providerTaskId, 512);
				if (!providerTaskId) throw new Error("Synchronous submission omitted task ID");
				const submissionToken = boundedString(submission.reconciliation.submissionToken, 256);
				const reconciliationEndpoints = safeReconciliationEndpoints(
					attempt.provider,
					submission.reconciliation,
				);
				const envelope = createOutputTransferEnvelope(
					mediaKindForJob(attempt.job.productKey),
					result.outputs,
				);
				if (!envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result),
						attemptData: {
							providerTaskId,
							...reconciliationEndpoints,
							...(submissionToken ? { submissionToken } : {}),
							providerCostMicros:
								result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
							submittedAt: new Date(),
						},
					});
					return;
				}
				await tx.generationAttemptTransferEnvelope.upsert({
					where: { attemptId },
					create: { attemptId, payload: outputTransferEnvelopeInput(envelope) },
					update: { payload: outputTransferEnvelopeInput(envelope) },
				});
				await tx.generationAttempt.update({
					where: { id: attemptId },
					data: {
						providerTaskId,
						...reconciliationEndpoints,
						...(submissionToken ? { submissionToken } : {}),
						status: "SUCCEEDED",
						submittedAt: new Date(),
						completedAt: new Date(),
						responseSnapshot: responseSnapshotForResult(result) as Prisma.InputJsonValue,
						providerCostMicros:
							result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
						uncertainSubmission: false,
						errorSnapshot: {},
						nextReconcileAt: null,
					},
				});
				const changed = await tx.generationJob.updateMany({
					where: { id: attempt.jobId, status: "SUBMITTING" },
					data: { status: "FINALIZING", version: { increment: 1 } },
				});
				if (changed.count !== 1) throw new Error("Synchronous completion job state changed");
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
				await options.beforeSynchronousCommit?.();
			});
		},
		async recordRejectedSubmission(attemptId, failure) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUniqueOrThrow({
					where: { id: attemptId },
					include: {
						job: { include: { attempts: true, quote: { select: { costMicros: true } } } },
					},
				});
				await tx.generationAttempt.update({
					where: { id: attempt.id },
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
				const resolution = quotedExecutableRoutes(attempt.job, enabledProviders);
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
						where: { id: attempt.jobId, status: "SUBMITTING", version: attempt.job.version },
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
					where: { id: attempt.jobId, status: "SUBMITTING", version: attempt.job.version },
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

export const databaseOutboxStore: OutboxStore = {
	claimBatch: ({ workerId, limit, leaseSeconds }) =>
		claimOutboxBatch({ workerId, limit, leaseSeconds }, db),
	async complete(id, workerId, leaseToken) {
		await completeOutboxEvent(id, workerId, leaseToken, db);
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
					input.storageReservationReferenceKey !== `generation-output:${input.assetId}`
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

interface VerifyUploadRuntimeOptions {
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
	safety?: SightengineSafetyAdapter | TestMediaSafetyAdapter;
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
	evidenceTtlMs: 24 * 60 * 60 * 1_000,
	processingPollMs: 15_000,
} as const;

interface MediaVerificationClaim {
	assetId: string;
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
	forceObjectInspection: boolean;
	leaseToken: string;
}

export function createDatabaseVerifyUploadDependencies(
	database: PrismaClient,
	options: VerifyUploadRuntimeOptions = {},
) {
	const safety = options.safety ?? createSafetyAdapter(process.env);
	const moderationProvider =
		options.moderationProvider ?? process.env.MEDIA_SAFETY_ADAPTER ?? "test";
	return {
		async verify(
			assetId: string,
			verificationOptions = { allowQuarantinedReverification: false },
		): Promise<void> {
			const claim = await claimMediaVerification(database, {
				assetId,
				provider: moderationProvider,
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				allowQuarantinedReverification: verificationOptions.allowQuarantinedReverification === true,
			});
			if (!claim) return;

			let checksum = claim.checksum;
			let storageEtag = claim.storageEtag;
			let storageVersionId = claim.storageVersionId;
			let finalizedAt = claim.finalizedAt;
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
						await completeMediaVerification(database, claim, {
							decision: "REJECT",
							reasonCode: "LEGACY_UPLOAD_CHECKSUM_MISMATCH",
							ruleVersion: claim.ruleVersion,
							checksum,
							storageEtag,
							storageVersionId,
							finalizedAt,
						});
						return;
					}
					checksum = inspected.sha256;
					storageEtag = inspected.etag;
					storageVersionId = inspected.versionId;
					finalizedAt = new Date();
				}

				const location = { bucket: "media" as const, key: claim.objectKey };
				const [metadata, header] = await Promise.all([
					(options.headObject ?? headObject)(location),
					(options.readMediaHeader ?? readMediaHeader)(location),
				]);
				const detectedType = detectMediaType(header);
				if (
					metadata.contentLength !== Number(claim.byteSize) ||
					metadata.contentType !== claim.mimeType ||
					detectedType !== claim.mimeType
				) {
					await completeMediaVerification(database, claim, {
						decision: "REJECT",
						reasonCode: "UPLOAD_METADATA_MISMATCH",
						ruleVersion: claim.ruleVersion,
						checksum,
						storageEtag,
						storageVersionId,
						finalizedAt,
					});
					return;
				}

				const assetUrl = await (options.createSignedReadUrl ?? createSignedReadUrl)({
					...location,
					expiresIn: 300,
				});
				let decision: ModerationDecision;
				if (claim.mimeType.startsWith("image/")) {
					decision = await safety.moderateImage({ assetUrl, ruleVersion: claim.ruleVersion });
				} else {
					let providerTaskId = claim.providerTaskId;
					if (!providerTaskId) {
						const submissionToken = await beginMediaVerificationSubmission(database, claim);
						if (!submissionToken) return;
						const submitted = await safety.submitVideo({
							assetUrl,
							ruleVersion: claim.ruleVersion,
							idempotencyKey: submissionToken,
						});
						await options.afterVideoSubmission?.(submitted);
						if (submitted.idempotency.key !== submissionToken) {
							await failUncertainMediaVerification(
								database,
								claim,
								"VIDEO_SUBMISSION_IDEMPOTENCY_MISMATCH",
								checksum,
								submitted.moderationTaskId,
							);
							return;
						}
						providerTaskId = submitted.moderationTaskId;
						const binding = await bindMediaVerificationProviderTask(
							database,
							claim,
							providerTaskId,
							submissionToken,
						);
						if (binding === "LOST") {
							await failUncertainMediaVerification(
								database,
								claim,
								"VIDEO_SUBMISSION_RESULT_NOT_BOUND",
								checksum,
								providerTaskId,
							);
							return;
						}
						if (binding === "BOUND_LEASE_EXPIRED") {
							return;
						}
					}
					decision = await safety.retrieveVideo({
						moderationTaskId: providerTaskId,
						ruleVersion: claim.ruleVersion,
					});
					if (decision.decision === "REVIEW" && decision.reasonCode === "VIDEO_PROCESSING") {
						await failMediaVerification(database, claim, "VIDEO_PROCESSING", "PENDING", checksum);
						return;
					}
				}
				if (decision.decision === "ERROR") {
					await failMediaVerification(database, claim, decision.reasonCode, "ERROR", checksum);
					return;
				}
				await completeMediaVerification(database, claim, {
					...decision,
					checksum,
					storageEtag,
					storageVersionId,
					finalizedAt,
				});
			} catch (error) {
				options.onVerificationError?.(error);
				if (isDeterministicLegacyInspectionFailure(error)) {
					await completeMediaVerification(database, claim, {
						decision: "REJECT",
						reasonCode: "UPLOAD_INSPECTION_FAILED",
						ruleVersion: claim.ruleVersion,
						checksum,
						storageEtag,
						storageVersionId,
						finalizedAt,
					});
					return;
				}
				await failMediaVerificationFromError(
					database,
					claim,
					verificationErrorCode(error),
					checksum,
				);
			}
		},
	};
}

async function appendVerificationEvidence(
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
		status: "PENDING" | "APPROVED" | "REJECTED" | "REVIEW" | "ERROR";
		reasonCode: string;
		rawEnvelope: Prisma.InputJsonValue;
		validUntil?: Date | null;
	},
): Promise<void> {
	const existing = await tx.assetModerationResult.findFirst({
		where: {
			assetId: input.assetId,
			verificationGeneration: input.verificationGeneration,
			attemptNumber: input.attemptNumber,
		},
		select: { id: true },
	});
	if (existing) return;
	await tx.assetModerationResult.create({
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
			categories: { reasonCode: input.reasonCode },
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
	},
): Promise<void> {
	const bindings = await tx.generationJobAsset.findMany({
		where: {
			assetId: input.assetId,
			OR: [
				{
					role: "INPUT",
					job: { status: { in: ["RESERVED", "DISPATCH_QUEUED"] } },
				},
				{ role: "OUTPUT", job: { status: "FINALIZING" } },
			],
		},
		include: { job: true },
		orderBy: [{ jobId: "asc" }, { role: "asc" }],
	});
	for (const binding of bindings) {
		if (binding.role === "OUTPUT") {
			const completedFinalizationScan = await tx.outboxEvent.findUnique({
				where: { dedupeKey: `generation-settle:${binding.jobId}` },
				select: { id: true },
			});
			if (!completedFinalizationScan) continue;
			await tx.outboxEvent.upsert({
				where: {
					dedupeKey: `generation-settle-after-output-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
				},
				create: {
					eventType: "GENERATION_SETTLE",
					aggregateType: "GENERATION_JOB",
					aggregateId: binding.jobId,
					dedupeKey: `generation-settle-after-output-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
					payload: { jobId: binding.jobId, version: binding.job.version },
				},
				update: {},
			});
			continue;
		}
		if (input.approved) {
			await tx.outboxEvent.upsert({
				where: {
					dedupeKey: `generation-dispatch-after-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
				},
				create: {
					eventType: "GENERATION_DISPATCH",
					aggregateType: "GENERATION_JOB",
					aggregateId: binding.jobId,
					dedupeKey: `generation-dispatch-after-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
					payload: { jobId: binding.jobId, version: binding.job.version },
				},
				update: {},
			});
			continue;
		}
		const changed = await tx.generationJob.updateMany({
			where: {
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
		await tx.outboxEvent.upsert({
			where: {
				dedupeKey: `generation-settle-after-input-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
			},
			create: {
				eventType: "GENERATION_SETTLE",
				aggregateType: "GENERATION_JOB",
				aggregateId: binding.jobId,
				dedupeKey: `generation-settle-after-input-verification:${binding.jobId}:${input.assetId}:g${input.verificationGeneration}`,
				payload: { jobId: binding.jobId, version: binding.job.version + 1 },
			},
			update: {},
		});
	}
}

async function claimMediaVerification(
	database: PrismaClient,
	input: {
		assetId: string;
		provider: string;
		ruleVersion: string;
		policyVersion: string;
		allowQuarantinedReverification: boolean;
	},
): Promise<MediaVerificationClaim | null> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${input.assetId}`}, 0))`;
		let asset = await tx.mediaAsset.findUnique({ where: { id: input.assetId } });
		if (!asset) throw new Error("Media asset not found");
		const now = new Date();
		const hasLegacyReverificationMarker =
			asset.status === "VERIFYING" &&
			Boolean(
				await tx.auditLog.findFirst({
					where: {
						action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
						targetType: "MEDIA_ASSET",
						targetId: asset.id,
					},
					select: { id: true },
				}),
			);
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
				where: { id: asset.id },
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
						now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs,
					),
					verificationExhaustedAt: null,
					verificationValidUntil: null,
					verificationSubmissionToken: null,
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
			asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
		}
		if (asset.status !== "VERIFYING" || asset.deletedAt !== null) return null;
		if (asset.verificationLeasedUntil && asset.verificationLeasedUntil > now) return null;

		if (asset.verificationSubmissionUncertain && !asset.verificationProviderTaskId) {
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
				where: { id: asset.id },
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
			await resolveJobsWaitingForMediaVerification(tx, {
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
				where: { id: asset.id },
				data: {
					verificationAttemptCount: attemptNumber,
					verificationLeaseToken: null,
					verificationLeasedUntil: null,
					verificationLastErrorCode: "VERIFICATION_LEASE_EXPIRED",
				},
			});
			asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
		}
		if (asset.verificationNextAttemptAt && asset.verificationNextAttemptAt > now) return null;

		if (
			(asset.verificationProvider && asset.verificationProvider !== input.provider) ||
			(asset.verificationRuleVersion && asset.verificationRuleVersion !== input.ruleVersion) ||
			(asset.verificationPolicyVersion && asset.verificationPolicyVersion !== input.policyVersion)
		) {
			const generation = Math.max(asset.verificationGeneration + 1, 1);
			await tx.mediaAsset.update({
				where: { id: asset.id },
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
						now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs,
					),
					verificationExhaustedAt: null,
					verificationValidUntil: null,
					verificationSubmissionToken: null,
					verificationSubmissionUncertain: false,
					verificationSubmittedAt: null,
					verificationLastErrorCode: null,
				},
			});
			asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
		}

		const deadlineAt =
			asset.verificationDeadlineAt ??
			new Date(now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.deadlineMs);
		if (deadlineAt <= now) {
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
				where: { id: asset.id },
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
			await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				approved: false,
				failureCode: "ASSET_VERIFICATION_DEADLINE_EXCEEDED",
			});
			return null;
		}

		const failureCount = await tx.assetModerationResult.count({
			where: {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				status: "ERROR",
			},
		});
		if (failureCount >= MEDIA_VERIFICATION_RETRY_POLICY.maxTransientFailures) {
			await tx.mediaAsset.update({
				where: { id: asset.id },
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
			await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: Math.max(asset.verificationGeneration, 1),
				approved: false,
				failureCode: "ASSET_VERIFICATION_FAILED",
			});
			return null;
		}
		const generation = Math.max(asset.verificationGeneration, 1);
		const attemptNumber = asset.verificationAttemptCount + 1;
		const leaseToken = crypto.randomUUID();
		const claimed = await tx.mediaAsset.update({
			where: { id: asset.id },
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
			forceObjectInspection: isAuthorizedLegacyReverification || hasLegacyReverificationMarker,
			leaseToken,
		};
	});
}

async function beginMediaVerificationSubmission(
	database: PrismaClient,
	claim: MediaVerificationClaim,
): Promise<string | null> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationLeaseToken: claim.leaseToken,
				verificationLeasedUntil: { gt: new Date() },
				verificationProviderTaskId: null,
				verificationSubmissionUncertain: false,
			},
		});
		if (!asset) return null;
		const submissionToken = asset.verificationSubmissionToken ?? crypto.randomUUID();
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				verificationSubmissionToken: submissionToken,
				verificationSubmissionUncertain: true,
				verificationSubmittedAt: new Date(),
			},
		});
		return submissionToken;
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
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationLeaseToken: claim.leaseToken,
				verificationSubmissionToken: submissionToken,
				verificationSubmissionUncertain: true,
				OR: [{ verificationProviderTaskId: null }, { verificationProviderTaskId: providerTaskId }],
			},
		});
		if (!asset) return "LOST";
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				verificationProviderTaskId: providerTaskId,
				verificationSubmissionUncertain: false,
			},
		});
		return asset.verificationLeasedUntil && asset.verificationLeasedUntil > new Date()
			? "BOUND_ACTIVE"
			: "BOUND_LEASE_EXPIRED";
	});
}

async function completeMediaVerification(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	input: ModerationDecision & {
		checksum: string | null;
		storageEtag: string | null;
		storageVersionId: string | null;
		finalizedAt: Date | null;
	},
): Promise<boolean> {
	if (!input.checksum || !/^[a-f0-9]{64}$/i.test(input.checksum)) {
		await failMediaVerification(database, claim, "CHECKSUM_UNAVAILABLE", "ERROR", null);
		return false;
	}
	if (input.ruleVersion !== claim.ruleVersion) {
		await failMediaVerification(
			database,
			claim,
			"VERIFICATION_RULE_VERSION_MISMATCH",
			"ERROR",
			input.checksum,
		);
		return false;
	}
	const approvedChecksum = input.checksum;
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		const now = new Date();
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationLeaseToken: claim.leaseToken,
				verificationLeasedUntil: { gt: now },
			},
		});
		if (!asset) return false;
		const status =
			input.decision === "ALLOW" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "REVIEW";
		const verificationValidUntil =
			input.decision === "ALLOW"
				? new Date(now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.evidenceTtlMs)
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
			rawEnvelope: { decision: input.decision },
			validUntil: verificationValidUntil,
		});
		await tx.mediaAsset.update({
			where: { id: asset.id },
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
				verificationLastErrorCode: null,
			},
		});
		await resolveJobsWaitingForMediaVerification(tx, {
			assetId: asset.id,
			verificationGeneration: claim.generation,
			approved: input.decision === "ALLOW",
			failureCode:
				input.decision === "REJECT"
					? "INPUT_REVERIFICATION_REJECTED"
					: "INPUT_REVERIFICATION_REVIEW_REQUIRED",
		});
		return true;
	});
}

async function failMediaVerification(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	status: "PENDING" | "ERROR",
	checksum: string | null,
): Promise<boolean> {
	return database.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${claim.assetId}`}, 0))`;
		const now = new Date();
		const asset = await tx.mediaAsset.findFirst({
			where: {
				id: claim.assetId,
				status: "VERIFYING",
				verificationGeneration: claim.generation,
				verificationLeaseToken: claim.leaseToken,
				verificationLeasedUntil: { gt: now },
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
			providerTaskId: asset.verificationProviderTaskId,
			ruleVersion: claim.ruleVersion,
			policyVersion: claim.policyVersion,
			status,
			reasonCode,
			rawEnvelope: { decision: status },
		});
		const failureCount = await tx.assetModerationResult.count({
			where: {
				assetId: asset.id,
				verificationGeneration: claim.generation,
				status: "ERROR",
			},
		});
		const exhausted =
			claim.deadlineAt <= now ||
			(status === "ERROR" && failureCount >= MEDIA_VERIFICATION_RETRY_POLICY.maxTransientFailures);
		const retryAt = exhausted
			? null
			: status === "PENDING"
				? new Date(now.getTime() + MEDIA_VERIFICATION_RETRY_POLICY.processingPollMs)
				: new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.max(failureCount - 1, 0)));
		await tx.mediaAsset.update({
			where: { id: asset.id },
			data: {
				status: exhausted ? "VERIFICATION_FAILED" : "VERIFYING",
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: retryAt,
				verificationExhaustedAt: exhausted ? now : null,
				verificationLastErrorCode: reasonCode,
			},
		});
		if (exhausted) {
			await resolveJobsWaitingForMediaVerification(tx, {
				assetId: asset.id,
				verificationGeneration: claim.generation,
				approved: false,
				failureCode:
					claim.deadlineAt <= now
						? "INPUT_REVERIFICATION_DEADLINE_EXCEEDED"
						: "INPUT_REVERIFICATION_FAILED",
			});
		}
		if (retryAt) {
			await tx.outboxEvent.upsert({
				where: {
					dedupeKey: `media-asset-verify:${asset.id}:g${claim.generation}:a${claim.attemptNumber + 1}`,
				},
				create: {
					eventType: "MEDIA_ASSET_VERIFY",
					aggregateType: "MEDIA_ASSET",
					aggregateId: asset.id,
					dedupeKey: `media-asset-verify:${asset.id}:g${claim.generation}:a${claim.attemptNumber + 1}`,
					payload: { assetId: asset.id },
					availableAt: retryAt,
				},
				update: {},
			});
		}
		return true;
	});
}

async function failMediaVerificationFromError(
	database: PrismaClient,
	claim: MediaVerificationClaim,
	reasonCode: string,
	checksum: string | null,
): Promise<boolean> {
	const current = await database.mediaAsset.findUnique({
		where: { id: claim.assetId },
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
		const asset = await tx.mediaAsset.findFirst({
			where: {
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
			where: { id: asset.id },
			data: {
				status: "VERIFICATION_FAILED",
				verificationLeaseToken: null,
				verificationLeasedUntil: null,
				verificationNextAttemptAt: null,
				verificationExhaustedAt: now,
				verificationLastErrorCode: reasonCode,
			},
		});
		await resolveJobsWaitingForMediaVerification(tx, {
			assetId: asset.id,
			verificationGeneration: claim.generation,
			approved: false,
			failureCode: "ASSET_VERIFICATION_SUBMISSION_UNCERTAIN",
		});
		return true;
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
		kind: "INPUT" | "OUTPUT";
		status: string;
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
			status: string;
			validUntil: Date | null;
		}>;
	};
}

function evaluateSettlementOutputs(
	bindings: SettlementOutputBindingSnapshot[],
	now: Date,
	moderationProvider: string,
): { readyOutputCount: number; waitingForVerification: boolean } {
	let readyOutputCount = 0;
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
		if (asset.status !== "READY") continue;
		const evidence = asset.moderationResults[0];
		const validUntil = asset.verificationValidUntil;
		const authorized =
			asset.deletedAt === null &&
			Boolean(asset.checksum) &&
			binding.assetChecksum === asset.checksum &&
			asset.verificationProvider === moderationProvider &&
			asset.verificationRuleVersion === MEDIA_VERIFICATION_RULE_VERSION &&
			asset.verificationPolicyVersion === MEDIA_VERIFICATION_POLICY_VERSION &&
			Boolean(validUntil && validUntil > now) &&
			evidence?.status === "APPROVED" &&
			evidence.assetChecksum === asset.checksum &&
			evidence.verificationGeneration === asset.verificationGeneration &&
			evidence.attemptNumber === asset.verificationAttemptCount &&
			evidence.evidenceKind === asset.kind &&
			evidence.provider === asset.verificationProvider &&
			evidence.providerTaskId === asset.verificationProviderTaskId &&
			evidence.ruleVersion === asset.verificationRuleVersion &&
			evidence.policyVersion === asset.verificationPolicyVersion &&
			Boolean(evidence.validUntil && validUntil) &&
			evidence.validUntil?.getTime() === validUntil?.getTime() &&
			Boolean(evidence.validUntil && evidence.validUntil > now);
		if (authorized) readyOutputCount += 1;
		else waitingForVerification = true;
	}
	return { readyOutputCount, waitingForVerification };
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

export function createDatabaseSettlementStore(database: PrismaClient): SettlementStore {
	return {
		async claimSettlement(payload) {
			const job = await database.generationJob.findFirst({
				where: { id: payload.jobId, status: { in: ["FINALIZING", "CANCELED"] } },
				include: {
					reservation: true,
					assets: settlementOutputInclude,
					attempts: true,
				},
			});
			if (!job?.reservation) return null;
			const outputState = evaluateSettlementOutputs(
				job.assets,
				new Date(),
				process.env.MEDIA_SAFETY_ADAPTER ?? "test",
			);
			if (outputState.waitingForVerification) return null;
			if (job.reservation.status !== "ACTIVE") {
				await database.generationJob.updateMany({
					where: { id: job.id, status: "FINALIZING" },
					data: {
						status: outputState.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
						failureCode: outputState.readyOutputCount > 0 ? null : "NO_USABLE_OUTPUT",
						terminalAt: new Date(),
					},
				});
				return null;
			}
			return {
				jobId: job.id,
				reservationId: job.reservation.id,
				reservedCredits: job.creditsReserved,
				chargeCredits: calculateSettlementCharge({
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
			await runSerializable(database, async (tx) => {
				let job = await tx.generationJob.findFirst({
					where: { id: claim.jobId, status: { in: ["FINALIZING", "CANCELED"] } },
					include: { reservation: true, assets: settlementOutputInclude },
				});
				if (!job?.reservation) return;
				for (const assetId of [...new Set(job.assets.map((binding) => binding.assetId))].sort()) {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${assetId}`}, 0))`;
				}
				job = await tx.generationJob.findFirst({
					where: { id: claim.jobId, status: { in: ["FINALIZING", "CANCELED"] } },
					include: { reservation: true, assets: settlementOutputInclude },
				});
				if (!job?.reservation) return;
				const outputState = evaluateSettlementOutputs(
					job.assets,
					new Date(),
					process.env.MEDIA_SAFETY_ADAPTER ?? "test",
				);
				if (outputState.waitingForVerification) return;
				const chargeCredits = calculateSettlementCharge({
					status: job.status,
					failureCode: job.failureCode,
					readyOutputCount: outputState.readyOutputCount,
					reservedCredits: job.creditsReserved,
					pricingSnapshot: job.pricingSnapshot,
				});
				await settleCreditsInTransaction(
					{
						reservationId: job.reservation.id,
						amount: chargeCredits,
						referenceKey: `settle:${job.id}`,
					},
					tx,
				);
				await tx.generationJob.updateMany({
					where: { id: job.id, status: "FINALIZING" },
					data: {
						status: outputState.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
						failureCode:
							outputState.readyOutputCount > 0
								? null
								: job.failureCode === "SUBMISSION_REJECTED_CONFIRMED" ||
									  job.failureCode === GUEST_OUTPUT_CARDINALITY_INVALID_CODE
									? job.failureCode
									: "NO_USABLE_OUTPUT",
						terminalAt: new Date(),
						version: { increment: 1 },
					},
				});
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
					where: { id: claim.attemptId },
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

export function createDatabaseFinalizationStore(database: PrismaClient): FinalizationStore {
	return {
		async claimFinalization(payload) {
			return database.$transaction(async (tx) => {
				const job = await tx.generationJob.findFirst({
					where: { id: payload.jobId, status: "FINALIZING" },
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
				if (job.serviceClass === "GUEST_SLOW" && (!job.guestTrial || mediaKind !== "image")) {
					throw new Error("GUEST_FINALIZATION_CONTEXT_INVALID");
				}
				let outputs = providerOutputsFromTransferEnvelope(
					mediaKind,
					attempt.transferEnvelope?.payload,
				);
				if (attempt.transferEnvelope && outputs.length === 0) {
					if (job.serviceClass === "GUEST_SLOW") {
						await transitionGuestOutputCardinalityFailure(tx, {
							attemptId: attempt.id,
							jobId: job.id,
							jobVersion: job.version,
							previousFailureCode: job.failureCode,
							outputCount: 0,
						});
						return null;
					}
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: job.id,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: safeResponseSnapshot(attempt.responseSnapshot),
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
						if (job.serviceClass === "GUEST_SLOW") {
							await transitionGuestOutputCardinalityFailure(tx, {
								attemptId: attempt.id,
								jobId: job.id,
								jobVersion: job.version,
								previousFailureCode: job.failureCode,
								outputCount: 0,
							});
							return null;
						}
						await transitionTerminalSuccessWithoutMedia(tx, {
							attemptId: attempt.id,
							jobId: job.id,
							errorSnapshot: attempt.errorSnapshot,
							responseSnapshot: safeResponseSnapshot(attempt.responseSnapshot),
							reasonCode: "LEGACY_OUTPUT_PROMOTION_FAILED",
						});
						return null;
					}
					await tx.generationAttemptTransferEnvelope.create({
						data: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(promoted) },
					});
					await tx.generationAttempt.update({
						where: { id: attempt.id },
						data: {
							responseSnapshot: safeResponseSnapshot(
								attempt.responseSnapshot,
								promoted.outputs.length,
							),
						},
					});
					outputs = providerOutputsFromTransferEnvelope(mediaKind, promoted);
				}
				if (job.serviceClass === "GUEST_SLOW" && outputs.length !== 1) {
					await transitionGuestOutputCardinalityFailure(tx, {
						attemptId: attempt.id,
						jobId: job.id,
						jobVersion: job.version,
						previousFailureCode: job.failureCode,
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
				where: { jobId, role: "OUTPUT", asset: { sourceUrl: `provider-output:${candidateKey}` } },
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
		async recordFinalization(claim, results, failure) {
			await runSerializable(database, async (tx) => {
				const job = await tx.generationJob.findUniqueOrThrow({ where: { id: claim.jobId } });
				if (job.status !== "FINALIZING") return;
				await bindFinalizationResults(tx, claim, results);
				await tx.generationJob.update({
					where: { id: job.id },
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
					SELECT "id" FROM "generation_job" WHERE "id" = ${claim.jobId} FOR UPDATE
				`;
				if (locked.length !== 1) return { outcome: "TERMINAL" as const, retryCount: 0 };
				const job = await tx.generationJob.findUniqueOrThrow({ where: { id: claim.jobId } });
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
					return {
						outcome: "RETRY_SCHEDULED" as const,
						retryCount: job.finalizationRetryCount,
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
					await tx.generationJob.update({
						where: { id: job.id },
						data: {
							finalizationStage: failure.stage,
							finalizationRetryCount: transferRetryCount,
							finalizationErrorCode: failure.code,
							nextFinalizeAt: wait.availableAt,
						},
					});
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-finalize-transfer-wait:${job.id}:${wait.key}` },
						create: {
							eventType: "GENERATION_FINALIZE_RETRY",
							aggregateType: "GENERATION_JOB",
							aggregateId: job.id,
							dedupeKey: `generation-finalize-transfer-wait:${job.id}:${wait.key}`,
							payload: { jobId: job.id, version: job.version },
							availableAt: wait.availableAt,
						},
						update: {},
					});
					return { outcome: "RETRY_SCHEDULED" as const, retryCount: transferRetryCount };
				}
				const retryCount =
					job.finalizationStage === failure.stage ? job.finalizationRetryCount + 1 : 1;
				if (
					failure.stage === "TRANSFER" &&
					retryCount >= OUTPUT_TRANSFER_MAX_FINALIZATION_ATTEMPTS &&
					(await terminalizeExhaustedOutputTransfer(tx, claim, failure))
				) {
					const nextFinalizeAt = new Date();
					await tx.generationJob.update({
						where: { id: job.id },
						data: {
							finalizationStage: failure.stage,
							finalizationRetryCount: retryCount,
							finalizationErrorCode: OUTPUT_TRANSFER_EXHAUSTED_CODE,
							nextFinalizeAt,
						},
					});
					const retryDedupeKey = `generation-finalize-after-transfer-exhaustion:${job.id}:${failure.assetId}:${failure.transferToken}`;
					await tx.outboxEvent.upsert({
						where: { dedupeKey: retryDedupeKey },
						create: {
							eventType: "GENERATION_FINALIZE_RETRY",
							aggregateType: "GENERATION_JOB",
							aggregateId: job.id,
							dedupeKey: retryDedupeKey,
							payload: { jobId: job.id, version: job.version },
							availableAt: nextFinalizeAt,
						},
						update: {},
					});
					return { outcome: "RETRY_SCHEDULED" as const, retryCount };
				}
				const nextFinalizeAt = new Date(Date.now() + Math.min(60, 2 ** retryCount) * 60_000);
				await tx.generationJob.update({
					where: { id: job.id },
					data: {
						finalizationStage: failure.stage,
						finalizationRetryCount: retryCount,
						finalizationErrorCode: failure.code,
						nextFinalizeAt,
					},
				});
				const retryDedupeKey = `generation-finalize-retry:${job.id}:${failure.stage.toLowerCase()}:${retryCount}`;
				await tx.outboxEvent.upsert({
					where: { dedupeKey: retryDedupeKey },
					create: {
						eventType: "GENERATION_FINALIZE_RETRY",
						aggregateType: "GENERATION_JOB",
						aggregateId: job.id,
						dedupeKey: retryDedupeKey,
						payload: { jobId: job.id, version: job.version },
						availableAt: nextFinalizeAt,
					},
					update: {},
				});
				return { outcome: "RETRY_SCHEDULED" as const, retryCount };
			});
		},
	};
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
			where: { id: result.assetId },
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

async function transitionGuestOutputCardinalityFailure(
	tx: Prisma.TransactionClient,
	input: {
		attemptId: string;
		jobId: string;
		jobVersion: number;
		previousFailureCode: string | null;
		outputCount: number;
	},
): Promise<void> {
	await tx.generationAttempt.updateMany({
		where: { id: input.attemptId, status: "SUCCEEDED" },
		data: {
			errorSnapshot: {
				code: GUEST_OUTPUT_CARDINALITY_INVALID_CODE,
				outputCount: input.outputCount,
			},
		},
	});
	const changed = await tx.generationJob.updateMany({
		where: {
			id: input.jobId,
			status: "FINALIZING",
			failureCode: input.previousFailureCode,
		},
		data: {
			failureCode: GUEST_OUTPUT_CARDINALITY_INVALID_CODE,
			version: { increment: 1 },
		},
	});
	const settlementVersion = input.jobVersion + (changed.count === 1 ? 1 : 0);
	await queueGenerationSettlement(tx, input.jobId, settlementVersion);
	if (changed.count !== 1) return;
	await tx.auditLog.create({
		data: {
			action: "MEDIA_GUEST_OUTPUT_CARDINALITY_REJECTED",
			targetType: "GENERATION_ATTEMPT",
			targetId: input.attemptId,
			metadata: {
				jobId: input.jobId,
				code: GUEST_OUTPUT_CARDINALITY_INVALID_CODE,
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

export function createFinalizationDependencies(
	environment = process.env,
	options: {
		store?: FinalizationStore;
		safety?: SightengineSafetyAdapter | TestMediaSafetyAdapter;
		database?: PrismaClient;
		verification?: { verify(assetId: string): Promise<void> };
		storage?: Partial<{
			putPrivateMediaObject: typeof putPrivateMediaObject;
			streamRemoteObjectToStorage: typeof streamRemoteObjectToStorage;
			promoteStagedObject: typeof promoteStagedObject;
			watermarkStagedGuestImage: typeof watermarkStagedGuestImage;
		}>;
	} = {},
): FinalizationDependencies {
	const database = options.database ?? db;
	const safety = options.safety ?? createSafetyAdapter(environment);
	const store = options.store ?? createDatabaseFinalizationStore(database);
	const verification =
		options.verification ??
		createDatabaseVerifyUploadDependencies(database, {
			safety,
			moderationProvider: environment.MEDIA_SAFETY_ADAPTER ?? "test",
		});
	const storage = {
		putPrivateMediaObject,
		streamRemoteObjectToStorage,
		promoteStagedObject,
		watermarkStagedGuestImage,
		...options.storage,
	};
	return {
		store,
		async persistCandidate(claim, candidate) {
			const existing = await store.findPersistedCandidate(claim.jobId, candidate.key);
			if (existing) return existing;
			if (claim.guest && claim.guest.deleteAfter <= new Date()) {
				throw {
					code: "GUEST_RETENTION_EXPIRED",
					stage: "TRANSFER",
					retryable: false,
				};
			}
			let inlineBody: Buffer | null = null;
			const mimeType =
				candidate.output.kind === "inline-base64"
					? (() => {
							const decoded = decodeInlineBase64MediaOutput(candidate.output);
							assertMediaKind(decoded.contentType, claim.mediaKind);
							inlineBody = decoded.body;
							return decoded.contentType;
						})()
					: expectedOutputMimeType(claim.mediaKind, candidate.output);
			const assetId = `asset_${createHash("sha256")
				.update(`${claim.jobId}:${candidate.key}`)
				.digest("base64url")
				.slice(0, 32)}`;
			const objectKey = createAssetObjectKey(claim.ownerId, assetId, mimeType);
			const sourceUrl = `provider-output:${candidate.key}`;
			const placeholder = await database.mediaAsset.findUnique({ where: { id: assetId } });
			if (
				placeholder?.ownerType === "USER" &&
				placeholder.ownerId === claim.ownerId &&
				placeholder.sourceUrl === sourceUrl &&
				isOutputTransferExhaustedPlaceholder(placeholder)
			) {
				throw {
					code: OUTPUT_TRANSFER_EXHAUSTED_CODE,
					stage: "TRANSFER",
					retryable: false,
				};
			}
			const transfer = await claimGenerationOutputTransferTransaction(
				{
					jobId: claim.jobId,
					ownerId: claim.ownerId,
					assetId,
					objectKey,
					mimeType,
					sourceUrl,
					...(claim.guest ? { guest: { deleteAfter: claim.guest.deleteAfter } } : {}),
					createStagingObjectKey: (transferToken) =>
						createStagingObjectKey(claim.ownerId, assetId, transferToken, mimeType),
				},
				database,
			);
			if (transfer.outcome === "IN_PROGRESS") {
				throw {
					code: OUTPUT_TRANSFER_IN_PROGRESS_CODE,
					stage: "TRANSFER",
					retryable: true,
				};
			}

			let completedAsset = transfer.asset;
			if (transfer.outcome === "CLAIMED") {
				try {
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
								sourceUrl: (candidate.output as Extract<ProviderOutput, { kind: "remote-url" }>)
									.url,
								allowedHosts: providerCdnAllowlist(environment),
								expectedContentType: mimeType,
								expectedMediaKind: claim.mediaKind,
							});
					const reserved = await reserveGenerationOutputStorageTransaction(
						{
							assetId,
							ownerId: claim.ownerId,
							transferToken: transfer.transferToken,
							bytes: BigInt(staged.bytes),
							maximumStorageBytes: maximumMediaStorageBytes(environment),
						},
						database,
					);
					if (reserved.outcome === "STALE") {
						throw {
							code: "OUTPUT_TRANSFER_FENCE_LOST",
							stage: "TRANSFER",
							retryable: true,
						};
					}
					const promoted = claim.guest
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
					if (claim.guest) {
						const resizedReservation = await reserveGenerationOutputStorageTransaction(
							{
								assetId,
								ownerId: claim.ownerId,
								transferToken: transfer.transferToken,
								bytes: BigInt(promoted.bytes),
								maximumStorageBytes: maximumMediaStorageBytes(environment),
							},
							database,
						);
						if (resizedReservation.outcome === "STALE") {
							throw {
								code: "OUTPUT_TRANSFER_FENCE_LOST",
								stage: "TRANSFER",
								retryable: true,
							};
						}
					}
					const completed = await completeGenerationOutputTransferTransaction(
						{
							assetId,
							ownerId: claim.ownerId,
							transferToken: transfer.transferToken,
							bytes: BigInt(promoted.bytes),
							checksum: promoted.sha256,
							storageEtag: promoted.etag ?? null,
							storageVersionId: promoted.versionId ?? null,
							...(claim.guest && "cleanStagingDeletedAt" in promoted
								? {
										guestWatermark: {
											version: GUEST_WATERMARK_VERSION,
											watermarkedAt: promoted.cleanStagingDeletedAt,
											cleanStagingDeletedAt: promoted.cleanStagingDeletedAt,
											deleteAfter: claim.guest.deleteAfter,
										},
									}
								: {}),
						},
						database,
					);
					if (completed.outcome === "STALE") {
						throw {
							code: "OUTPUT_TRANSFER_FENCE_LOST",
							stage: "TRANSFER",
							retryable: true,
						};
					}
					completedAsset = completed.asset;
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

			if (completedAsset.status === "READY") return { assetId, approved: true };
			if (["QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(completedAsset.status)) {
				return { assetId, approved: false };
			}
			await verification.verify(assetId);
			const asset = await database.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
			if (asset.status === "VERIFYING") {
				throw { code: "MODERATION_RETRYABLE", stage: "MODERATION", retryable: true };
			}
			return { assetId, approved: asset.status === "READY" };
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
						OR: [
							{ status: "RECEIVED" },
							{ status: "PROCESSING", processingLeasedUntil: { lte: new Date() } },
						],
					},
				});
				if (!event?.providerTaskId) return null;
				const processingToken = crypto.randomUUID();
				const claimed = await tx.providerWebhookEvent.updateMany({
					where: { id: event.id, status: event.status, processingToken: event.processingToken },
					data: {
						status: "PROCESSING",
						processingToken,
						processingLeasedUntil: new Date(Date.now() + 60_000),
					},
				});
				if (claimed.count !== 1) return null;
				const attempt = await tx.generationAttempt.findFirst({
					where: { provider: event.provider, providerTaskId: event.providerTaskId },
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
					}>
				>`SELECT "id", "jobId", "status", "progress", "lastProviderEventAt",
						          "lastProviderOccurredAt", "lastProviderReceivedAt", "lastProviderSequence", "errorSnapshot"
					   FROM "generation_attempt" WHERE "id" = ${claim.attemptId} FOR UPDATE`;
				if (!attempt) throw new Error("Provider event attempt not found");
				await options.afterAttemptLock?.({ eventId: claim.eventId, attemptId: attempt.id });
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { id: attempt.jobId },
					select: { productKey: true, status: true },
				});
				const incoming = claim.snapshot.status;
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
				if (incoming === "SUCCEEDED" && !envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result),
						attemptData: {
							progress:
								result.progress === null
									? attempt.progress
									: Math.max(attempt.progress ?? 0, Math.min(100, Math.round(result.progress))),
							providerCostMicros:
								result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
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
					where: { id: attempt.id },
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
						providerCostMicros:
							result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
						responseSnapshot: responseSnapshotForResult(result) as Prisma.InputJsonValue,
						uncertainSubmission: incomingTerminal ? false : undefined,
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
							id: attempt.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: { status: "FINALIZING", version: { increment: 1 } },
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
						where: { id: attempt.jobId, status: "PROVIDER_PENDING" },
						data: { status: "PROVIDER_RUNNING", version: { increment: 1 } },
					});
				}
				await completeProviderWebhookEvent(tx, claim);
			});
		},
		async markProviderRecoveryUnavailable(claim) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUnique({
					where: { id: claim.attemptId },
					select: { id: true, jobId: true, status: true, errorSnapshot: true },
				});
				if (!attempt) {
					await completeProviderWebhookEvent(tx, claim, "PROVIDER_RECOVERY_UNAVAILABLE");
					return;
				}
				const job = await tx.generationJob.findUniqueOrThrow({
					where: { id: attempt.jobId },
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
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUnique({
					where: { id: claim.attemptId },
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

export interface ReconciliationRuntimeOptions {
	afterAttemptRead?: () => Promise<void>;
	afterAttemptUpdate?: () => Promise<void>;
}

export function createDatabaseReconciliationStore(
	database: PrismaClient,
	options: ReconciliationRuntimeOptions = {},
): ReconciliationStore {
	return {
		async claimStale({ limit, leaseSeconds, now }) {
			const leasedUntil = new Date(now.getTime() + leaseSeconds * 1_000);
			return database.$queryRaw`
			WITH claimable AS (
				SELECT "id" FROM "generation_attempt"
			WHERE ("providerTaskId" IS NOT NULL OR "uncertainSubmission" = true)
			  AND "status" IN ('SUBMISSION_UNCERTAIN', 'SUBMITTED', 'RUNNING')
				  AND ("nextReconcileAt" IS NULL OR "nextReconcileAt" <= ${now})
				  AND ("reconcileLeasedUntil" IS NULL OR "reconcileLeasedUntil" <= ${now})
				ORDER BY "updatedAt", "id" FOR UPDATE SKIP LOCKED LIMIT ${limit}
			)
			UPDATE "generation_attempt" attempt
			SET "reconcileLeaseToken" = gen_random_uuid()::text,
			    "reconcileLeasedUntil" = ${leasedUntil},
			    "reconciliationCount" = attempt."reconciliationCount" + 1
			FROM claimable WHERE attempt."id" = claimable."id"
			RETURNING attempt."jobId", attempt."id" AS "attemptId", attempt."provider",
			          attempt."providerTaskId", attempt."providerStatusUrl" AS "statusUrl",
			          attempt."providerResultUrl" AS "resultUrl",
			          attempt."reconcileLeaseToken" AS "leaseToken",
			          GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (${now} - attempt."updatedAt")) / 60))::int AS "staleAgeMinutes",
			          attempt."reconciliationCount" AS "repairCount"`;
		},
		async recordReconciled(lease, snapshot, result) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findFirst({
					where: { id: lease.attemptId, reconcileLeaseToken: lease.leaseToken },
					include: { job: { select: { productKey: true, status: true } } },
				});
				await options.afterAttemptRead?.();
				if (!attempt) return;
				if (
					attempt.status === "NEEDS_RECONCILIATION" ||
					attempt.job.status === "NEEDS_RECONCILIATION"
				) {
					await tx.generationAttempt.updateMany({
						where: { id: attempt.id, reconcileLeaseToken: lease.leaseToken },
						data: { reconcileLeaseToken: null, reconcileLeasedUntil: null, nextReconcileAt: null },
					});
					return;
				}
				const terminalFailure = snapshot.status === "FAILED" || snapshot.status === "CANCELED";
				const envelope =
					snapshot.status === "SUCCEEDED"
						? createOutputTransferEnvelope(mediaKindForJob(attempt.job.productKey), result.outputs)
						: null;
				if (snapshot.status === "SUCCEEDED" && !envelope) {
					await transitionTerminalSuccessWithoutMedia(tx, {
						attemptId: attempt.id,
						jobId: attempt.jobId,
						errorSnapshot: attempt.errorSnapshot,
						responseSnapshot: responseSnapshotForResult(result),
						reconcileLeaseToken: lease.leaseToken,
						attemptData: {
							progress: result.progress,
							providerCostMicros:
								result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
						},
					});
					return;
				}
				if (envelope) {
					await tx.generationAttemptTransferEnvelope.upsert({
						where: { attemptId: attempt.id },
						create: { attemptId: attempt.id, payload: outputTransferEnvelopeInput(envelope) },
						update: { payload: outputTransferEnvelopeInput(envelope) },
					});
				}
				const changed = await tx.generationAttempt.updateMany({
					where: { id: attempt.id, reconcileLeaseToken: lease.leaseToken },
					data: {
						status:
							snapshot.status === "SUCCEEDED"
								? "SUCCEEDED"
								: terminalFailure
									? "NEEDS_RECONCILIATION"
									: snapshot.status === "RUNNING"
										? "RUNNING"
										: undefined,
						progress: result.progress,
						responseSnapshot: responseSnapshotForResult(result) as Prisma.InputJsonValue,
						providerCostMicros:
							result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
						uncertainSubmission: terminalFailure
							? true
							: snapshot.status === "SUCCEEDED"
								? false
								: undefined,
						errorSnapshot: terminalFailure
							? manualReconciliationErrorSnapshot(
									attempt.errorSnapshot,
									"RECONCILIATION_TERMINAL_UNVERIFIED",
								)
							: undefined,
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt:
							terminalFailure || snapshot.status === "SUCCEEDED"
								? null
								: new Date(Date.now() + 60_000),
					},
				});
				if (changed.count !== 1) return;
				await options.afterAttemptUpdate?.();
				if (snapshot.status === "SUCCEEDED") {
					await tx.generationJob.updateMany({
						where: {
							id: lease.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: { status: "FINALIZING", version: { increment: 1 } },
					});
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-finalize:${lease.jobId}:${lease.attemptId}` },
						create: {
							eventType: "GENERATION_FINALIZE",
							aggregateType: "GENERATION_JOB",
							aggregateId: lease.jobId,
							dedupeKey: `generation-finalize:${lease.jobId}:${lease.attemptId}`,
							payload: { jobId: lease.jobId },
						},
						update: {},
					});
				} else if (terminalFailure) {
					const reservation = await tx.creditReservation.findUnique({
						where: { jobId: lease.jobId },
						select: { id: true, amount: true, status: true },
					});
					if (!reservation || reservation.status !== "ACTIVE") {
						throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
					}
					const jobChanged = await tx.generationJob.updateMany({
						where: {
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
								reservationId: reservation.id,
								reservedCredits: reservation.amount.toString(),
								creditsFrozen: true,
								pageAdmin: true,
							},
						},
					});
				}
			});
		},
		async releaseReconciliationLease(lease, code, retryAt) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findFirst({
					where: { id: lease.attemptId, reconcileLeaseToken: lease.leaseToken },
					select: { errorSnapshot: true },
				});
				if (!attempt) return;
				const changed = await tx.generationAttempt.updateMany({
					where: { id: lease.attemptId, reconcileLeaseToken: lease.leaseToken },
					data: {
						errorSnapshot: reconciliationErrorSnapshot(attempt.errorSnapshot, code),
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: retryAt,
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
				const attempt = await tx.generationAttempt.findFirst({
					where: {
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
						status: { in: ["SUBMISSION_UNCERTAIN", "SUBMITTED", "RUNNING"] },
					},
					select: { errorSnapshot: true },
				});
				if (!attempt) return;
				const reservation = await tx.creditReservation.findUnique({
					where: { jobId: lease.jobId },
					select: { id: true, amount: true, status: true },
				});
				const changed = await tx.generationAttempt.updateMany({
					where: {
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
							reservationId: reservation.id,
							reservedCredits: reservation.amount.toString(),
							creditsFrozen: true,
							pageAdmin: true,
						},
					},
				});
			});
		},
	};
}
export const databaseReconciliationStore: ReconciliationStore =
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
): QuotedRouteResolution {
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
		const routes = routeGraph.allowedRoutes.filter(
			(route) =>
				enabledProviders.has(route.provider) &&
				isStaticDispatchRoute(entry.mediaKind, route.provider, route.providerModelId) &&
				entry.routes.some(
					(candidate) =>
						candidate.provider === route.provider &&
						candidate.providerModelId === route.providerModelId,
				),
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
						enabledProviders.has(route.provider) &&
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

async function markQuotedRouteUnavailable(
	database: Prisma.TransactionClient | PrismaClient,
	input: {
		jobId: string;
		code: QuotedRouteUnavailableCode | "DISPATCH_ROUTE_MISMATCH";
		diagnosticRoute?: CatalogRoute;
	},
): Promise<void> {
	const job = await database.generationJob.findUnique({
		where: { id: input.jobId },
		include: {
			attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
			reservation: { select: { id: true, amount: true, status: true } },
		},
	});
	if (!job || !["RESERVED", "DISPATCH_QUEUED"].includes(job.status)) return;
	if (!job.reservation || job.reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const jobChanged = await database.generationJob.updateMany({
		where: { id: job.id, status: { in: ["RESERVED", "DISPATCH_QUEUED"] } },
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
			where: { id: attempt.id, status: "CREATED" },
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
				reservationId: job.reservation.id,
				reservedCredits: job.reservation.amount.toString(),
				creditsFrozen: true,
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
	if (
		job.serviceClass !== "GUEST_SLOW" ||
		job.status !== "DISPATCH_QUEUED" ||
		job.productKey !== "image-fast" ||
		job.guestTrialId !== trial.id ||
		job.ownerId !== trial.ownerId ||
		job.creditsReserved !== 4n ||
		job.quote.costMicros !== trial.frozenQuotedRiskMicros ||
		trial.sponsorCredits !== 4n ||
		trial.currentJobId !== job.id ||
		trial.consumedJobId !== null ||
		trial.eligibility !== "IN_FLIGHT" ||
		trial.riskState !== "HELD" ||
		trial.providerBoundaryAt !== null ||
		trial.expiresAt <= now ||
		now.getTime() - job.createdAt.getTime() >= 10 * 60_000 ||
		(job.dispatchEligibleAt !== null && job.dispatchEligibleAt > now) ||
		!(await guestRuntimeEnabled(tx, environment, trial.promotionPeriod))
	) {
		return false;
	}
	const config = getGuestMediaConfig(environment, true);
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
		risk.reservedMicros + risk.consumedMicros > risk.hardLimitMicros ||
		risk.reservedMicros + risk.consumedMicros > config.riskBudgetMicros
	) {
		return false;
	}
	const active = await tx.generationJob.findFirst({
		where: {
			serviceClass: "GUEST_SLOW",
			id: { not: job.id },
			status: {
				in: [
					"DISPATCH_QUEUED",
					"SUBMITTING",
					"PROVIDER_PENDING",
					"PROVIDER_RUNNING",
					"NEEDS_RECONCILIATION",
					"FINALIZING",
				],
			},
		},
		select: { id: true },
	});
	if (active) return false;
	const globalBudget = mediaDailyProviderCostBudgetMicros(environment);
	if (globalBudget !== undefined) {
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

function safeResponseSnapshot(value: unknown, outputCountOverride?: number): Prisma.InputJsonValue {
	const record = objectRecord(value);
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
	const reservation = await tx.creditReservation.findUnique({
		where: { jobId: input.attempt.jobId },
		select: { id: true, amount: true, status: true },
	});
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const jobChanged = await tx.generationJob.updateMany({
		where: {
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
				reservationId: reservation.id,
				reservedCredits: reservation.amount.toString(),
				creditsFrozen: true,
				pageAdmin: true,
			},
		},
	});
	return true;
}

async function recoverManualProviderSuccess(
	tx: Prisma.TransactionClient,
	input: {
		attempt: { id: string; jobId: string; status: string; progress: number | null };
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
	const reservation = await tx.creditReservation.findUnique({
		where: { jobId: input.attempt.jobId },
		select: { id: true, amount: true, status: true },
	});
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	await tx.generationAttemptTransferEnvelope.upsert({
		where: { attemptId: input.attempt.id },
		create: { attemptId: input.attempt.id, payload: outputTransferEnvelopeInput(input.envelope) },
		update: { payload: outputTransferEnvelopeInput(input.envelope) },
	});
	const attemptChanged = await tx.generationAttempt.updateMany({
		where: { id: input.attempt.id, status: "NEEDS_RECONCILIATION" },
		data: {
			status: "SUCCEEDED",
			progress:
				input.result.progress === null
					? input.attempt.progress
					: Math.max(input.attempt.progress ?? 0, Math.min(100, Math.round(input.result.progress))),
			providerCostMicros:
				input.result.providerCostMicros === null
					? undefined
					: BigInt(input.result.providerCostMicros),
			responseSnapshot: responseSnapshotForResult(input.result) as Prisma.InputJsonValue,
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
		where: { id: input.attempt.jobId, status: "NEEDS_RECONCILIATION" },
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
				reservationId: reservation.id,
				reservedCredits: reservation.amount.toString(),
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
	const reservation = await tx.creditReservation.findUnique({
		where: { jobId: input.jobId },
		select: { id: true, amount: true, status: true },
	});
	if (!reservation || reservation.status !== "ACTIVE") {
		throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
	}
	const attemptChanged = await tx.generationAttempt.updateMany({
		where: {
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
				reservationId: reservation.id,
				reservedCredits: reservation.amount.toString(),
				code: reasonCode,
				creditsFrozen: true,
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
	const reconciliationEndpoints = safeReconciliationEndpoints(provider, evidence);
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
	endpoints: { statusUrl?: string; resultUrl?: string },
): { providerStatusUrl: string | null; providerResultUrl: string | null } {
	return {
		providerStatusUrl: safeProviderEndpoint(provider, endpoints.statusUrl) ?? null,
		providerResultUrl: safeProviderEndpoint(provider, endpoints.resultUrl) ?? null,
	};
}

function safeProviderEndpoint(provider: string, value: string | undefined): string | undefined {
	// Fal is the only adapter that returns and later consumes provider-provided endpoints.
	// The remaining adapters reconstruct their official API URL from the task ID instead.
	if (provider !== "fal") return undefined;
	const bounded = boundedString(value, 1_024);
	if (
		!bounded ||
		bounded !== bounded.trim() ||
		rawUrlAuthority(bounded)?.toLowerCase() !== "queue.fal.run"
	) {
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

function expectedOutputMimeType(
	mediaKind: "image" | "video",
	output: ProviderOutput,
): "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/webm" | "video/quicktime" {
	if (output.kind === "inline-base64") {
		if (["image/jpeg", "image/png", "image/webp"].includes(output.mimeType)) {
			return output.mimeType as "image/jpeg" | "image/png" | "image/webp";
		}
		throw new Error("Unsupported inline image type");
	}
	return mediaKind === "image" ? "image/png" : "video/mp4";
}

function createSafetyAdapter(environment: NodeJS.ProcessEnv) {
	return environment.MEDIA_SAFETY_ADAPTER === "sightengine" &&
		environment.SIGHTENGINE_API_USER &&
		environment.SIGHTENGINE_API_SECRET
		? new SightengineSafetyAdapter({
				apiUser: environment.SIGHTENGINE_API_USER,
				apiSecret: environment.SIGHTENGINE_API_SECRET,
			})
		: new TestMediaSafetyAdapter(environment.NODE_ENV === "test" ? "ALLOW" : "ERROR");
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
