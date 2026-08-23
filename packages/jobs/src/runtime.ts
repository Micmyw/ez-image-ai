import { createHash } from "node:crypto";

import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	getCatalogEntry,
	KieProviderAdapter,
	MEDIA_VERIFICATION_POLICY_VERSION,
	MEDIA_VERIFICATION_RULE_VERSION,
	MediaProviderRegistry,
	ReplicateProviderAdapter,
	SightengineSafetyAdapter,
	TestMediaSafetyAdapter,
	type MediaProviderAdapter,
	type MediaProviderRegistry as ProviderRegistry,
	type ModerationDecision,
	type ProviderExecutionInput,
	type ProviderKey,
	type ProviderOutput,
	type RetrieveOnlyMediaProviderAdapter,
	chooseCatalogRoute,
} from "@repo/ai";
import {
	claimGenerationOutputTransferTransaction,
	claimOutboxBatch,
	completeGenerationOutputTransferTransaction,
	completeOutboxEvent,
	failGenerationOutputTransferTransaction,
	recordGenerationOutputPromotionMultipartTransaction,
	releaseOutboxEvent,
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
	streamRemoteObjectToStorage,
} from "@repo/storage";
import type { MediaObjectMetadata } from "@repo/storage";

import type {
	DispatchStore,
	FinalizationDependencies,
	FinalizationStore,
	OutboxStore,
	ProviderEventStore,
	ReconciliationStore,
	SettlementStore,
} from "./contracts";
import type { StorageCleanupDependencies } from "./handlers/cleanup-storage-object";
import { providerCdnAllowlist } from "./provider-output-policy";
import { dispatchRouteFor, providerQueueKey } from "./queues";

export function createProviderRegistry(environment = process.env): ProviderRegistry {
	const registry = new MediaProviderRegistry();
	if (environment.REPLICATE_API_TOKEN) {
		registry.register(
			new ReplicateProviderAdapter({
				apiToken: environment.REPLICATE_API_TOKEN,
				webhookSecret: environment.REPLICATE_WEBHOOK_SECRET,
			}),
		);
	}
	if (environment.FAL_API_KEY)
		registry.register(new FalProviderAdapter({ apiKey: environment.FAL_API_KEY }));
	if (environment.KIE_API_KEY)
		registry.register(new KieProviderAdapter({ apiKey: environment.KIE_API_KEY }));
	if (environment.GEMINI_API_KEY) {
		registry.register(new GeminiProviderAdapter({ apiKey: environment.GEMINI_API_KEY }));
	}
	return registry;
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

export async function resolveDatabaseDispatchRoute(jobId: string) {
	const job = await db.generationJob.findUnique({
		where: { id: jobId },
		include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
	});
	if (!job) throw new Error("Generation job not found");
	const entry = getCatalogEntry(job.productKey as Parameters<typeof getCatalogEntry>[0]);
	const existing = job.attempts[0];
	const route = existing
		? entry.routes.find(
				(candidate) =>
					candidate.provider === existing.provider &&
					candidate.providerModelId === existing.providerModelId,
			)
		: chooseCatalogRoute(entry.routes, deterministicFraction(job.id));
	if (!route) throw new Error("Catalog route no longer exists");
	return dispatchRouteFor(entry.mediaKind, route.provider, route.providerModelId);
}

export function createDatabaseDispatchStore(
	database: PrismaClient,
	options: {
		beforeSynchronousCommit?: () => Promise<void>;
		afterInputAuthorization?: () => Promise<void>;
		createSignedReadUrl?: typeof createSignedReadUrl;
	} = {},
): DispatchStore {
	return {
		async claimDispatch(payload) {
			return database.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generation-dispatch:${payload.jobId}`}, 0))`;
				const job = await tx.generationJob.findFirst({
					where: {
						id: payload.jobId,
						version: payload.version,
						status: { in: ["RESERVED", "DISPATCH_QUEUED"] },
					},
					include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 }, assets: true },
				});
				if (!job) return null;
				const existing = job.attempts[0];
				if (existing && existing.status !== "CREATED") return null;
				const entry = getCatalogEntry(job.productKey as Parameters<typeof getCatalogEntry>[0]);
				const route = existing
					? entry.routes.find(
							(candidate) =>
								candidate.provider === existing.provider &&
								candidate.providerModelId === existing.providerModelId,
						)
					: chooseCatalogRoute(entry.routes, deterministicFraction(job.id));
				if (!route) throw new Error("Catalog route no longer exists");
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
					const currentProvider = process.env.MEDIA_SAFETY_ADAPTER ?? "test";
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
				const changed = await tx.generationJob.updateMany({
					where: { id: job.id, version: job.version, status: job.status },
					data: { status: "SUBMITTING", version: { increment: 1 } },
				});
				if (changed.count !== 1) return null;
				return {
					attemptId: attempt.id,
					provider: route.provider,
					providerModelId: route.providerModelId,
					mediaKind: entry.mediaKind,
					queueKey: providerQueueKey(route.provider, route.providerModelId),
					input,
					webhookUrl:
						route.provider === "replicate" && process.env.NEXT_PUBLIC_SAAS_URL
							? `${process.env.NEXT_PUBLIC_SAAS_URL}/api/webhooks/ai/replicate`
							: undefined,
				};
			});
		},
		async recordSubmission(attemptId, submission) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				const terminal = submission.status === "SUCCEEDED";
				if (!submission.providerTaskId && submission.acceptance === "CERTAIN") {
					throw new Error("Certain provider submission omitted its task ID");
				}
				await tx.generationAttempt.update({
					where: { id: attempt.id },
					data: {
						providerTaskId: submission.providerTaskId,
						providerStatusUrl: submission.reconciliation.statusUrl,
						providerResultUrl: submission.reconciliation.resultUrl,
						submissionToken: submission.reconciliation.submissionToken,
						status: terminal
							? "SUCCEEDED"
							: submission.status === "RUNNING"
								? "RUNNING"
								: "SUBMITTED",
						submittedAt: new Date(),
						completedAt: terminal ? new Date() : undefined,
						responseSnapshot: submission.snapshot?.raw as Prisma.InputJsonValue | undefined,
						uncertainSubmission: submission.acceptance === "UNKNOWN",
						nextReconcileAt: new Date(Date.now() + 30_000),
					},
				});
				await tx.generationJob.updateMany({
					where: { id: attempt.jobId, status: "SUBMITTING" },
					data: { status: terminal ? "FINALIZING" : "PROVIDER_PENDING", version: { increment: 1 } },
				});
				if (terminal) {
					await tx.outboxEvent.create({
						data: {
							eventType: "GENERATION_FINALIZE",
							aggregateType: "GENERATION_JOB",
							aggregateId: attempt.jobId,
							dedupeKey: `generation-finalize:${attempt.jobId}:${attempt.id}`,
							payload: { jobId: attempt.jobId },
						},
					});
				}
			});
		},
		async recordUncertainSubmission(attemptId) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.update({
					where: { id: attemptId },
					data: {
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
		async recordSynchronousCompletion(attemptId, submission, result) {
			await database.$transaction(async (tx) => {
				const attempt = await tx.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
				if (!submission.providerTaskId) throw new Error("Synchronous submission omitted task ID");
				await tx.generationAttempt.update({
					where: { id: attemptId },
					data: {
						providerTaskId: submission.providerTaskId,
						providerStatusUrl: submission.reconciliation.statusUrl,
						providerResultUrl: submission.reconciliation.resultUrl,
						submissionToken: submission.reconciliation.submissionToken,
						status: "SUCCEEDED",
						submittedAt: new Date(),
						completedAt: new Date(),
						responseSnapshot: {
							outputs: result.outputs,
							providerCharged: result.providerCharged,
						} as Prisma.InputJsonValue,
						providerCostMicros:
							result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
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
					include: { job: { include: { attempts: true } } },
				});
				await tx.generationAttempt.update({
					where: { id: attempt.id },
					data: {
						status: "FAILED",
						errorSnapshot: {
							code: failure.code,
							message: failure.message,
							retryable: failure.retryable,
						},
						nextReconcileAt: null,
						completedAt: new Date(),
					},
				});
				const entry = getCatalogEntry(
					attempt.job.productKey as Parameters<typeof getCatalogEntry>[0],
				);
				const attemptedRoutes = new Set(
					attempt.job.attempts.map((item) => `${item.provider}:${item.providerModelId}`),
				);
				const retryRoute = failure.retryable
					? entry.routes.find(
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
				chargeCredits:
					job.status === "CANCELED" ||
					job.failureCode === "SUBMISSION_REJECTED_CONFIRMED" ||
					outputState.readyOutputCount === 0
						? 0n
						: job.creditsReserved,
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
				const chargeCredits =
					job.status === "CANCELED" ||
					job.failureCode === "SUBMISSION_REJECTED_CONFIRMED" ||
					outputState.readyOutputCount === 0
						? 0n
						: job.creditsReserved;
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
								: job.failureCode === "SUBMISSION_REJECTED_CONFIRMED"
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

export function createDatabaseFinalizationStore(database: PrismaClient): FinalizationStore {
	return {
		async claimFinalization(payload) {
			const job = await database.generationJob.findFirst({
				where: { id: payload.jobId, status: "FINALIZING" },
				include: {
					attempts: { where: { status: "SUCCEEDED" }, orderBy: { attemptNumber: "desc" }, take: 1 },
				},
			});
			const attempt = job?.attempts[0];
			if (!job || !attempt) return null;
			const snapshot = attempt.responseSnapshot as { outputs?: ProviderOutput[] } | null;
			const outputs = snapshot?.outputs?.filter(isProviderOutput) ?? [];
			return {
				jobId: job.id,
				ownerId: job.ownerId,
				mediaKind: getCatalogEntry(job.productKey as Parameters<typeof getCatalogEntry>[0])
					.mediaKind,
				candidates: outputs.map((output, index) => ({ key: `${attempt.id}:${index}`, output })),
			};
		},
		async findPersistedCandidate(jobId, candidateKey) {
			const binding = await database.generationJobAsset.findFirst({
				where: { jobId, role: "OUTPUT", asset: { sourceUrl: `provider-output:${candidateKey}` } },
				include: { asset: true },
			});
			if (!binding) return null;
			if (binding.asset.status === "READY") {
				return { assetId: binding.assetId, approved: true };
			}
			if (["QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(binding.asset.status)) {
				return { assetId: binding.assetId, approved: false };
			}
			// VERIFYING can mean either a live transfer or durable bytes awaiting
			// moderation. Returning it as persisted would let finalization settle
			// before the transfer/verification checkpoint has completed.
			return null;
		},
		async recordFinalization(claim, results, failure) {
			await runSerializable(database, async (tx) => {
				const job = await tx.generationJob.findUniqueOrThrow({ where: { id: claim.jobId } });
				if (job.status !== "FINALIZING") return;
				await bindFinalizationResults(tx, claim.jobId, results);
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
		async recordFinalizationRetry(claim, failure, results) {
			return runSerializable(database, async (tx) => {
				const job = await tx.generationJob.findUniqueOrThrow({ where: { id: claim.jobId } });
				if (job.status !== "FINALIZING") {
					return { outcome: "TERMINAL" as const, retryCount: job.finalizationRetryCount };
				}
				await bindFinalizationResults(tx, claim.jobId, results);
				const retryCount = job.finalizationRetryCount + 1;
				if (retryCount >= 5) {
					await tx.generationJob.update({
						where: { id: job.id },
						data: {
							finalizationStage: failure.stage,
							finalizationRetryCount: retryCount,
							finalizationErrorCode: failure.code,
							nextFinalizeAt: null,
						},
					});
					await queueGenerationSettlement(tx, job.id, job.version);
					return { outcome: "TERMINAL" as const, retryCount };
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
				await tx.outboxEvent.upsert({
					where: { dedupeKey: `generation-finalize-retry:${job.id}:${retryCount}` },
					create: {
						eventType: "GENERATION_FINALIZE_RETRY",
						aggregateType: "GENERATION_JOB",
						aggregateId: job.id,
						dedupeKey: `generation-finalize-retry:${job.id}:${retryCount}`,
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
	jobId: string,
	results: Array<{ assetId: string; approved: boolean }>,
): Promise<void> {
	for (const [position, result] of results.entries()) {
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
				jobId_assetId_role: { jobId, assetId: result.assetId, role: "OUTPUT" },
			},
			create: {
				jobId,
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
		...options.storage,
	};
	return {
		store,
		async persistCandidate(claim, candidate) {
			const existing = await store.findPersistedCandidate(claim.jobId, candidate.key);
			if (existing) return existing;
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
			const transfer = await claimGenerationOutputTransferTransaction(
				{
					jobId: claim.jobId,
					ownerId: claim.ownerId,
					assetId,
					objectKey,
					mimeType,
					sourceUrl: `provider-output:${candidate.key}`,
					createStagingObjectKey: (transferToken) =>
						createStagingObjectKey(claim.ownerId, assetId, transferToken, mimeType),
				},
				database,
			);
			if (transfer.outcome === "IN_PROGRESS") {
				throw {
					code: "OUTPUT_TRANSFER_IN_PROGRESS",
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
					const promoted = await storage.promoteStagedObject({
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
					const completed = await completeGenerationOutputTransferTransaction(
						{
							assetId,
							ownerId: claim.ownerId,
							transferToken: transfer.transferToken,
							bytes: BigInt(promoted.bytes),
							checksum: promoted.sha256,
							storageEtag: promoted.etag,
							storageVersionId: promoted.versionId,
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
					if (error instanceof MediaValidationError) {
						let failed;
						try {
							failed = await failGenerationOutputTransferTransaction(
								{
									assetId,
									ownerId: claim.ownerId,
									transferToken: transfer.transferToken,
									errorCode: error.code,
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
					const structured = error as { code?: unknown; stage?: unknown; retryable?: unknown };
					if (
						typeof structured.code === "string" &&
						structured.stage === "TRANSFER" &&
						structured.retryable === true
					) {
						throw error;
					}
					throw { code: "STORAGE_TRANSFER_RETRYABLE", stage: "TRANSFER", retryable: true };
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
					}>
				>`SELECT "id", "jobId", "status", "progress", "lastProviderEventAt",
				          "lastProviderOccurredAt", "lastProviderReceivedAt", "lastProviderSequence"
				   FROM "generation_attempt" WHERE "id" = ${claim.attemptId} FOR UPDATE`;
				if (!attempt) throw new Error("Provider event attempt not found");
				await options.afterAttemptLock?.({ eventId: claim.eventId, attemptId: attempt.id });
				const incoming = claim.snapshot.status;
				const incomingTerminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(incoming);
				const canonicalTime = claim.providerOccurredAt ?? claim.receivedAt;
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
					await tx.providerWebhookEvent.update({
						where: { id: claim.eventId, processingToken: claim.processingToken },
						data: {
							status: "PROCESSED",
							failureReason: "STALE_EVENT_IGNORED",
							processedAt: new Date(),
							processingToken: null,
							processingLeasedUntil: null,
						},
					});
					return;
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
						responseSnapshot: {
							outputs: result.outputs,
							providerCharged: result.providerCharged,
						} as Prisma.InputJsonValue,
						lastProviderEventAt: claim.snapshot.status === "UNKNOWN" ? undefined : canonicalTime,
						lastProviderOccurredAt:
							claim.snapshot.status === "UNKNOWN" ? undefined : claim.providerOccurredAt,
						lastProviderReceivedAt:
							claim.snapshot.status === "UNKNOWN" ? undefined : claim.receivedAt,
						lastProviderSequence: claim.providerSequence,
						completedAt: ["SUCCEEDED", "FAILED", "CANCELED"].includes(incoming)
							? new Date()
							: undefined,
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
				await tx.providerWebhookEvent.update({
					where: { id: claim.eventId, processingToken: claim.processingToken },
					data: {
						status: "PROCESSED",
						processedAt: new Date(),
						processingToken: null,
						processingLeasedUntil: null,
					},
				});
			});
		},
		async recordProviderEventFailure(claim, code) {
			await database.providerWebhookEvent.update({
				where: { id: claim.eventId, processingToken: claim.processingToken },
				data: {
					status: "FAILED",
					failureReason: code,
					processingToken: null,
					processingLeasedUntil: null,
				},
			});
		},
	};
}

export const databaseProviderEventStore: ProviderEventStore = createDatabaseProviderEventStore(db);

export function createDatabaseReconciliationStore(database: PrismaClient): ReconciliationStore {
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
				const changed = await tx.generationAttempt.updateMany({
					where: { id: lease.attemptId, reconcileLeaseToken: lease.leaseToken },
					data: {
						status:
							snapshot.status === "SUCCEEDED"
								? "SUCCEEDED"
								: snapshot.status === "FAILED"
									? "FAILED"
									: snapshot.status === "CANCELED"
										? "CANCELED"
										: snapshot.status === "RUNNING"
											? "RUNNING"
											: undefined,
						progress: result.progress,
						responseSnapshot: { outputs: result.outputs } as Prisma.InputJsonValue,
						providerCostMicros:
							result.providerCostMicros === null ? undefined : BigInt(result.providerCostMicros),
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: new Date(Date.now() + 60_000),
					},
				});
				if (changed.count !== 1) return;
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
				} else if (snapshot.status === "FAILED" || snapshot.status === "CANCELED") {
					await tx.generationJob.updateMany({
						where: {
							id: lease.jobId,
							status: { in: ["SUBMITTING", "PROVIDER_PENDING", "PROVIDER_RUNNING"] },
						},
						data: {
							status: "FINALIZING",
							failureCode: "PROVIDER_UNAVAILABLE",
							version: { increment: 1 },
						},
					});
					await tx.outboxEvent.upsert({
						where: { dedupeKey: `generation-settle:${lease.jobId}` },
						create: {
							eventType: "GENERATION_SETTLE",
							aggregateType: "GENERATION_JOB",
							aggregateId: lease.jobId,
							dedupeKey: `generation-settle:${lease.jobId}`,
							payload: { jobId: lease.jobId },
						},
						update: {},
					});
				}
			});
		},
		async releaseReconciliationLease(lease, code, retryAt) {
			await database.$transaction(async (tx) => {
				const changed = await tx.generationAttempt.updateMany({
					where: { id: lease.attemptId, reconcileLeaseToken: lease.leaseToken },
					data: {
						errorSnapshot: { code },
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
		async markUncertainForManualReconciliation(lease) {
			await database.$transaction(async (tx) => {
				const reservation = await tx.creditReservation.findUnique({
					where: { jobId: lease.jobId },
					select: { id: true, amount: true, status: true },
				});
				const changed = await tx.generationAttempt.updateMany({
					where: {
						id: lease.attemptId,
						reconcileLeaseToken: lease.leaseToken,
						status: "SUBMISSION_UNCERTAIN",
					},
					data: {
						status: "NEEDS_RECONCILIATION",
						errorSnapshot: {
							code: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
							retryable: false,
							manualResolution: true,
						},
						reconcileLeaseToken: null,
						reconcileLeasedUntil: null,
						nextReconcileAt: null,
					},
				});
				if (changed.count !== 1) return;
				const jobChanged = await tx.generationJob.updateMany({
					where: { id: lease.jobId, status: "PROVIDER_PENDING" },
					data: {
						status: "NEEDS_RECONCILIATION",
						failureCode: "SUBMISSION_UNCERTAIN_NEEDS_RECONCILIATION",
						version: { increment: 1 },
					},
				});
				if (jobChanged.count !== 1) throw new Error("UNCERTAIN_JOB_STATE_CONFLICT");
				if (!reservation || reservation.status !== "ACTIVE") {
					throw new Error("UNCERTAIN_RESERVATION_NOT_ACTIVE");
				}
				await tx.auditLog.create({
					data: {
						action: "MEDIA_SUBMISSION_NEEDS_RECONCILIATION",
						targetType: "GENERATION_ATTEMPT",
						targetId: lease.attemptId,
						metadata: {
							jobId: lease.jobId,
							repairCount: lease.repairCount,
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

function isProviderOutput(value: unknown): value is ProviderOutput {
	if (!value || typeof value !== "object") return false;
	const output = value as Record<string, unknown>;
	return (
		(output.kind === "remote-url" && typeof output.url === "string") ||
		(output.kind === "inline-base64" &&
			typeof output.mimeType === "string" &&
			typeof output.data === "string")
	);
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
