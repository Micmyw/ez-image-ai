import { createHash } from "node:crypto";

import {
	FalProviderAdapter,
	GeminiProviderAdapter,
	getCatalogEntry,
	KieProviderAdapter,
	MediaProviderRegistry,
	ReplicateProviderAdapter,
	SightengineSafetyAdapter,
	TestMediaSafetyAdapter,
	type MediaProviderAdapter,
	type MediaProviderRegistry as ProviderRegistry,
	type ProviderExecutionInput,
	type ProviderKey,
	type ProviderOutput,
	type RetrieveOnlyMediaProviderAdapter,
	chooseCatalogRoute,
} from "@repo/ai";
import {
	claimOutboxBatch,
	completeOutboxEvent,
	releaseOutboxEvent,
	settleCredits,
} from "@repo/database";
import type { Prisma } from "@repo/database";
import { db } from "@repo/database/client";
import type { PrismaClient } from "@repo/database/generated-client";
import {
	abortMultipartUpload,
	createAssetObjectKey,
	createSignedReadUrl,
	deleteObject,
	detectMediaType,
	headObject,
	inspectPrivateMediaObject,
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
	options: { beforeSynchronousCommit?: () => Promise<void> } = {},
): DispatchStore {
	return {
		async claimDispatch(payload) {
			return database.$transaction(async (tx) => {
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
				const rawInput = job.inputSnapshot as unknown as ProviderExecutionInput & {
					sourceAssetId?: string;
				};
				let input: ProviderExecutionInput = rawInput;
				if (rawInput.sourceAssetId) {
					const binding = await tx.generationJobAsset.findFirst({
						where: { jobId: job.id, assetId: rawInput.sourceAssetId, role: "INPUT" },
						include: { asset: true },
					});
					if (!binding || binding.asset.status !== "READY")
						throw new Error("Input asset is not ready");
					const transferUrl = await createSignedReadUrl({
						bucket: "media",
						key: binding.asset.objectKey,
						expiresIn: 600,
					});
					const { sourceAssetId: _, ...withoutId } = rawInput;
					input = {
						...withoutId,
						sourceAsset: { assetId: binding.asset.id, transferUrl },
					} as ProviderExecutionInput;
				}
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
	storage: Pick<StorageCleanupDependencies, "deleteObject" | "abortMultipartUpload"> = {
		deleteObject: (objectKey) => deleteObject({ bucket: "media", key: objectKey }),
		abortMultipartUpload: (objectKey, uploadId) =>
			abortMultipartUpload({ bucket: "media", key: objectKey, uploadId }),
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
						},
					},
				});
				if (input.uploadSessionId && input.reservationStatus) {
					await tx.storageUsageReservation.updateMany({
						where: {
							referenceKey: `media-upload:${input.uploadSessionId}`,
							status: "ACTIVE",
						},
						data: { status: input.reservationStatus, releasedAt: new Date() },
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
			let asset = await database.mediaAsset.findUnique({ where: { id: assetId } });
			if (!asset) throw new Error("Media asset not found");
			const hasLegacyReverificationMarker =
				asset.status === "VERIFYING" && asset.finalizedAt === null && asset.deletedAt === null
					? Boolean(
							await database.auditLog.findFirst({
								where: {
									action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
									targetType: "MEDIA_ASSET",
									targetId: assetId,
								},
								select: { id: true },
							}),
						)
					: false;
			const isLegacyReverification =
				verificationOptions.allowQuarantinedReverification &&
				asset.finalizedAt === null &&
				asset.deletedAt === null &&
				(asset.status === "QUARANTINED" || hasLegacyReverificationMarker);
			if (asset.status === "QUARANTINED" && !isLegacyReverification) return;
			if (hasLegacyReverificationMarker && !isLegacyReverification) {
				return;
			}
			if (isLegacyReverification) {
				if (asset.status === "QUARANTINED") {
					const claimed = await database.$transaction(async (tx) => {
						const changed = await tx.mediaAsset.updateMany({
							where: {
								id: assetId,
								status: "QUARANTINED",
								finalizedAt: null,
								deletedAt: null,
							},
							data: { status: "VERIFYING" },
						});
						if (changed.count !== 1) return false;
						await tx.auditLog.create({
							data: {
								action: "MEDIA_ASSET_LEGACY_REVERIFICATION_STARTED",
								targetType: "MEDIA_ASSET",
								targetId: assetId,
								before: { status: "QUARANTINED" },
								after: { status: "VERIFYING" },
								metadata: { source: "immutable-upload-migration" },
							},
						});
						return true;
					});
					if (!claimed) return;
				}
				try {
					const inspected = await (options.inspectPrivateMediaObject ?? inspectPrivateMediaObject)({
						bucket: "media",
						key: asset.objectKey,
						contentType: asset.mimeType as
							| "image/jpeg"
							| "image/png"
							| "image/webp"
							| "video/mp4"
							| "video/webm"
							| "video/quicktime",
						contentLength: Number(asset.byteSize),
					});
					const refreshedAt = new Date();
					const refreshed = await database.mediaAsset.updateMany({
						where: { id: assetId, status: "VERIFYING", finalizedAt: null, deletedAt: null },
						data: {
							checksum: inspected.sha256,
							storageEtag: inspected.etag,
							storageVersionId: inspected.versionId,
							finalizedAt: refreshedAt,
						},
					});
					if (refreshed.count !== 1) return;
					asset = {
						...asset,
						checksum: inspected.sha256,
						storageEtag: inspected.etag,
						storageVersionId: inspected.versionId,
						finalizedAt: refreshedAt,
						status: "VERIFYING",
					};
				} catch (error) {
					if (!isDeterministicLegacyInspectionFailure(error)) throw error;
					await recordUploadVerification(database, assetId, "legacy-upload-validation", {
						decision: "REJECT",
						reasonCode: "LEGACY_UPLOAD_INSPECTION_FAILED",
						ruleVersion: "2026-08-23.1",
					});
					return;
				}
			}
			if (asset.status !== "VERIFYING") return;

			const location = { bucket: "media" as const, key: asset.objectKey };
			const [metadata, header] = await Promise.all([
				(options.headObject ?? headObject)(location),
				(options.readMediaHeader ?? readMediaHeader)(location),
			]);
			const detectedType = detectMediaType(header);
			if (
				metadata.contentLength !== Number(asset.byteSize) ||
				metadata.contentType !== asset.mimeType ||
				detectedType !== asset.mimeType
			) {
				await recordUploadVerification(database, asset.id, "upload-validation", {
					decision: "REJECT",
					reasonCode: "UPLOAD_METADATA_MISMATCH",
					ruleVersion: "2026-08-14.1",
				});
				return;
			}

			const assetUrl = await (options.createSignedReadUrl ?? createSignedReadUrl)({
				...location,
				expiresIn: 300,
			});
			const decision = asset.mimeType.startsWith("image/")
				? await safety.moderateImage({ assetUrl, ruleVersion: "2026-08-14.1" })
				: await moderateVideoSynchronously(safety, assetUrl);
			if (decision.decision === "ERROR") throw new Error("Media moderation requires retry");
			await recordUploadVerification(database, asset.id, moderationProvider, decision);
		},
	};
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

export function createDatabaseSettlementStore(database: PrismaClient): SettlementStore {
	return {
		async claimSettlement(payload) {
			const job = await database.generationJob.findFirst({
				where: { id: payload.jobId, status: { in: ["FINALIZING", "CANCELED"] } },
				include: {
					reservation: true,
					assets: { where: { role: "OUTPUT", asset: { status: "READY" } } },
					attempts: true,
				},
			});
			if (!job?.reservation) return null;
			if (job.reservation.status !== "ACTIVE") {
				await database.generationJob.updateMany({
					where: { id: job.id, status: "FINALIZING" },
					data: {
						status: job.assets.length > 0 ? "SUCCEEDED" : "FAILED",
						failureCode: job.assets.length > 0 ? null : "NO_USABLE_OUTPUT",
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
					job.status === "CANCELED" || job.failureCode === "SUBMISSION_REJECTED_CONFIRMED"
						? 0n
						: job.creditsReserved,
				readyOutputCount: job.assets.length,
				failureCode: job.failureCode,
				providerCostMicros: job.attempts.reduce(
					(total, attempt) => total + (attempt.providerCostMicros ?? 0n),
					0n,
				),
			};
		},
		async settle(claim) {
			await settleCredits(
				{
					reservationId: claim.reservationId,
					amount: claim.chargeCredits,
					referenceKey: `settle:${claim.jobId}`,
				},
				database,
			);
			await database.generationJob.updateMany({
				where: { id: claim.jobId, status: "FINALIZING" },
				data: {
					status: claim.readyOutputCount > 0 ? "SUCCEEDED" : "FAILED",
					failureCode:
						claim.readyOutputCount > 0
							? null
							: claim.failureCode === "SUBMISSION_REJECTED_CONFIRMED"
								? claim.failureCode
								: "NO_USABLE_OUTPUT",
					terminalAt: new Date(),
					version: { increment: 1 },
				},
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
			return binding
				? { assetId: binding.assetId, approved: binding.asset.status === "READY" }
				: null;
		},
		async recordFinalization(claim, results) {
			await database.$transaction(async (tx) => {
				for (const [position, result] of results.entries()) {
					await tx.generationJobAsset.upsert({
						where: {
							jobId_assetId_role: { jobId: claim.jobId, assetId: result.assetId, role: "OUTPUT" },
						},
						create: { jobId: claim.jobId, assetId: result.assetId, role: "OUTPUT", position },
						update: { position },
					});
				}
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
			});
		},
		async recordFinalizationRetry(claim, failure) {
			await database.$transaction(async (tx) => {
				const job = await tx.generationJob.findUniqueOrThrow({ where: { id: claim.jobId } });
				if (job.status !== "FINALIZING") return;
				const retryCount = job.finalizationRetryCount + 1;
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
			});
		},
	};
}

export const databaseFinalizationStore: FinalizationStore = createDatabaseFinalizationStore(db);

export function createFinalizationDependencies(
	environment = process.env,
	options: {
		store?: FinalizationStore;
		safety?: SightengineSafetyAdapter | TestMediaSafetyAdapter;
	} = {},
): FinalizationDependencies {
	const safety = options.safety ?? createSafetyAdapter(environment);
	const store = options.store ?? databaseFinalizationStore;
	return {
		store,
		async persistCandidate(claim, candidate) {
			const existing = await store.findPersistedCandidate(claim.jobId, candidate.key);
			if (existing) return existing;
			const assetId = createHash("sha256")
				.update(`${claim.jobId}:${candidate.key}`)
				.digest("base64url")
				.slice(0, 32);
			const mimeType = expectedOutputMimeType(claim.mediaKind, candidate.output);
			const objectKey = createAssetObjectKey(claim.ownerId, assetId, mimeType);
			let asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
			if (!asset) {
				let transferred;
				try {
					transferred =
						candidate.output.kind === "inline-base64"
							? await putPrivateMediaObject({
									bucket: "media",
									key: objectKey,
									contentType: mimeType,
									body: Buffer.from(candidate.output.data, "base64"),
								})
							: await streamRemoteObjectToStorage({
									bucket: "media",
									key: objectKey,
									sourceUrl: candidate.output.url,
									allowedHosts: providerCdnAllowlist(environment),
									expectedContentType: mimeType,
								});
				} catch {
					throw { code: "STORAGE_TRANSFER_RETRYABLE", stage: "TRANSFER", retryable: true };
				}
				asset = await db.mediaAsset.create({
					data: {
						id: assetId,
						ownerType: "USER",
						ownerId: claim.ownerId,
						kind: "OUTPUT",
						status: "VERIFYING",
						objectKey,
						mimeType,
						byteSize: BigInt(transferred.bytes),
						checksum: transferred.sha256,
						sourceUrl: `provider-output:${candidate.key}`,
					},
				});
			}
			const moderationUrl = await createSignedReadUrl({
				bucket: "media",
				key: objectKey,
				expiresIn: 300,
			});
			let decision;
			try {
				decision =
					claim.mediaKind === "image"
						? await safety.moderateImage({
								assetUrl: moderationUrl,
								ruleVersion: "2026-08-13.1",
							})
						: await moderateVideoSynchronously(safety, moderationUrl);
			} catch {
				throw { code: "MODERATION_RETRYABLE", stage: "MODERATION", retryable: true };
			}
			if (decision.decision === "ERROR") {
				throw { code: "MODERATION_RETRYABLE", stage: "MODERATION", retryable: true };
			}
			const approved = decision.decision === "ALLOW";
			await db.$transaction(async (tx) => {
				await tx.assetModerationResult.create({
					data: {
						assetId: asset.id,
						provider: environment.MEDIA_SAFETY_ADAPTER ?? "test",
						status: approved ? "APPROVED" : decision.decision === "REJECT" ? "REJECTED" : "REVIEW",
						categories: { reasonCode: decision.reasonCode, ruleVersion: decision.ruleVersion },
						rawEnvelope: { decision: decision.decision },
					},
				});
				await tx.mediaAsset.update({
					where: { id: asset.id },
					data: { status: approved ? "READY" : "QUARANTINED" },
				});
			});
			return { assetId: asset.id, approved };
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

async function moderateVideoSynchronously(
	safety: SightengineSafetyAdapter | TestMediaSafetyAdapter,
	assetUrl: string,
) {
	const submitted = await safety.submitVideo({ assetUrl, ruleVersion: "2026-08-13.1" });
	return safety.retrieveVideo({
		moderationTaskId: submitted.moderationTaskId,
		ruleVersion: submitted.ruleVersion,
	});
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

async function recordUploadVerification(
	database: PrismaClient,
	assetId: string,
	provider: string,
	decision: {
		decision: "ALLOW" | "REJECT" | "REVIEW" | "ERROR";
		reasonCode: string;
		ruleVersion: string;
	},
): Promise<void> {
	if (decision.decision === "ERROR") throw new Error("Media moderation requires retry");
	await database.$transaction(async (tx) => {
		await tx.assetModerationResult.upsert({
			where: { assetId_provider: { assetId, provider } },
			create: {
				assetId,
				provider,
				status:
					decision.decision === "ALLOW"
						? "APPROVED"
						: decision.decision === "REJECT"
							? "REJECTED"
							: "REVIEW",
				categories: { reasonCode: decision.reasonCode, ruleVersion: decision.ruleVersion },
				rawEnvelope: { decision: decision.decision },
			},
			update: {
				status:
					decision.decision === "ALLOW"
						? "APPROVED"
						: decision.decision === "REJECT"
							? "REJECTED"
							: "REVIEW",
				categories: { reasonCode: decision.reasonCode, ruleVersion: decision.ruleVersion },
				rawEnvelope: { decision: decision.decision },
			},
		});
		await tx.mediaAsset.updateMany({
			where: { id: assetId, status: "VERIFYING" },
			data: { status: decision.decision === "ALLOW" ? "READY" : "QUARANTINED" },
		});
	});
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
