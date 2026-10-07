import { createHash } from "node:crypto";

import { readVideoInternalFundingSnapshot } from "@repo/config/video-internal-funding";
import { VIDEO_MODEL_CATALOG_VERSION } from "@repo/config/video-models";
import { readVideoAudioSafetyPolicy, type VideoAudioSafetyPolicy } from "@repo/config/video-output";
import {
	readVideoVisualSafetyProfile,
	type VideoVisualSafetyProfile,
} from "@repo/config/video-safety";
import {
	readVideoTextSafetyProfile,
	type VideoTextSafetyProfile,
} from "@repo/config/video-text-safety";
import {
	VIDEO_V1_MODEL_CONTRACT_VERSION,
	VIDEO_V1_PRODUCT_KEY,
	videoV1InputSchema,
} from "@repo/config/video-v1";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { reserveCreditsInTransaction } from "./credits";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import {
	runReadCommitted,
	runSerializable,
	type MediaDatabaseClient,
	type MediaTransactionClient,
	type PaidCreditFundingPolicy,
} from "./types";
import {
	canonicalVideoTemplateJson,
	templateAdmissionData,
	assertTemplateAdmissionSnapshot,
	findTemplateRoleInputs,
	type TemplateAdmission,
} from "./video-template-admission";
import { recordVideoTemplateBusinessEvent } from "./video-template-events";
import {
	videoTemplateSceneReservationKey,
	videoTemplateSceneReservationBytes,
} from "./video-template-storage";
import {
	videoOutputStoragePolicy,
	videoOutputReservationBytes,
	videoOutputReservationKey,
	videoOwnerStorageUsage,
} from "./video-v1-storage";

const ENGINE = "video-workflow-v1";
type VideoRequest = ReturnType<typeof videoV1InputSchema.parse>;
export interface VideoPrice {
	credits: bigint;
	pricingVersion: string;
	providerCostMicros: bigint;
	moderationCostMicros: bigint;
	pricingBasis: string;
	paidFundingPolicy?: PaidCreditFundingPolicy;
	pricingDetails?: Prisma.InputJsonObject;
}
export type VideoAdmissionLimits = {
	ownerConcurrency: number;
	globalConcurrency: number;
	providerConcurrency: number;
	maximumStorageBytes: bigint;
	maximumInputBytes: number;
};

export function fingerprintVideoRequest(ownerId: string, request: VideoRequest): string {
	const parsed = videoV1InputSchema.parse(request);
	// Schema parsing determines key order; no client checksum or signed URL is accepted.
	return createHash("sha256")
		.update(JSON.stringify({ ownerId, request: parsed }))
		.digest("hex");
}

function snapshotRequest(value: Prisma.JsonValue): VideoRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("INVALID_VIDEO_QUOTE");
	const { mode, prompt, duration, sound } = value;
	if (typeof value.productKey === "string")
		return videoV1InputSchema.parse({
			productKey: value.productKey,
			mode,
			prompt,
			duration,
			sound,
			resolution: value.resolution,
			aspectRatio: value.aspectRatio,
			...(mode === "image-to-video" ? { inputAssetId: value.inputAssetId } : {}),
		});
	return videoV1InputSchema.parse(
		mode === "image-to-video"
			? { mode, prompt, duration, sound, inputAssetId: value.inputAssetId }
			: { mode, prompt, duration, sound, aspectRatio: value.aspectRatio },
	);
}

function requestProduct(request: VideoRequest) {
	return "productKey" in request ? request.productKey : VIDEO_V1_PRODUCT_KEY;
}

function requiredVisualSafetyProfile(
	profile: VideoVisualSafetyProfile,
	request: VideoRequest,
): VideoVisualSafetyProfile {
	// Legacy fallback is only for already accepted jobs. New quotes/admissions
	// must supply an explicit server-owned profile, never the mutable runtime default.
	if (!profile) throw new Error("VIDEO_SAFETY_PROFILE_REQUIRED");
	return readVideoVisualSafetyProfile({ ...request, visualSafetyProfile: profile });
}
function requiredTextSafetyProfile(profile: VideoTextSafetyProfile): VideoTextSafetyProfile {
	if (!profile) throw new Error("VIDEO_TEXT_SAFETY_PROFILE_REQUIRED");
	return readVideoTextSafetyProfile({ textSafetyProfile: profile });
}
function requiredAudioSafetyPolicy(policy: VideoAudioSafetyPolicy): VideoAudioSafetyPolicy {
	if (!policy) throw new Error("VIDEO_AUDIO_SAFETY_POLICY_REQUIRED");
	const parsed = readVideoAudioSafetyPolicy({ audioSafetyPolicy: policy });
	if (parsed.mode !== "not_requested") throw new Error("VIDEO_AUDIO_SAFETY_POLICY_CHANGED");
	return parsed;
}
function requestContract(request: VideoRequest) {
	return "productKey" in request ? VIDEO_MODEL_CATALOG_VERSION : VIDEO_V1_MODEL_CONTRACT_VERSION;
}
function videoPricingSnapshot(price: VideoPrice) {
	return {
		schemaVersion: 1,
		credits: price.credits.toString(),
		providerCostMicros: price.providerCostMicros.toString(),
		moderationCostMicros: price.moderationCostMicros.toString(),
		pricingBasis: price.pricingBasis,
		pricingVersion: price.pricingVersion,
		...(price.paidFundingPolicy
			? {
					paidFundingPolicy: {
						minimumUsdMicrosPerCredit: price.paidFundingPolicy.minimumUsdMicrosPerCredit.toString(),
					},
				}
			: {}),
		...(price.pricingDetails ? { pricingDetails: price.pricingDetails } : {}),
		settlementPolicy: {
			unitCredits: price.credits.toString(),
			requestedOutputCount: 1,
			maxCharge: price.credits.toString(),
		},
	};
}

async function findSealedInput(
	ownerId: string,
	request: VideoRequest,
	maximumInputBytes: number,
	tx: MediaDatabaseClient,
	now: Date,
) {
	if (request.mode === "text-to-video") return null;
	const asset = await tx.mediaAsset.findFirst({
		where: {
			id: request.inputAssetId,
			ownerType: "USER",
			ownerId,
			deletedAt: null,
			status: { in: ["VERIFYING", "READY"] },
			finalizedAt: { not: null },
			OR: [{ deleteAfter: null }, { deleteAfter: { gt: now } }],
		},
	});
	if (
		!asset ||
		!asset.checksum ||
		!/^[a-f0-9]{64}$/i.test(asset.checksum) ||
		!["image/jpeg", "image/png"].includes(asset.mimeType) ||
		asset.byteSize <= 0n ||
		asset.byteSize > BigInt(maximumInputBytes) ||
		!asset.width ||
		!asset.height ||
		asset.width < 1 ||
		asset.height < 1 ||
		(asset.verificationEngine !== ENGINE && asset.status !== "READY")
	)
		throw new Error("VIDEO_INPUT_NOT_AVAILABLE");
	return asset;
}

export async function createVideoQuoteRecord(
	input: {
		ownerId: string;
		request: VideoRequest;
		price: VideoPrice;
		visualSafetyProfile: VideoVisualSafetyProfile;
		textSafetyProfile: VideoTextSafetyProfile;
		audioSafetyPolicy: VideoAudioSafetyPolicy;
		maximumInputBytes: number;
		template?: TemplateAdmission;
	},
	client: MediaTransactionClient,
) {
	const request = videoV1InputSchema.parse(input.request);
	const visualSafetyProfile = requiredVisualSafetyProfile(input.visualSafetyProfile, request);
	const textSafetyProfile = requiredTextSafetyProfile(input.textSafetyProfile);
	const audioSafetyPolicy = requiredAudioSafetyPolicy(input.audioSafetyPolicy);
	if (
		input.price.credits <= 0n ||
		input.price.providerCostMicros <= 0n ||
		input.price.moderationCostMicros < 0n ||
		!input.price.pricingVersion ||
		!input.price.pricingBasis
	)
		throw new Error("VIDEO_PRICE_NOT_CONFIGURED");
	return runSerializable(client, async (tx) => {
		const now = await databaseNow(tx);
		if (request.mode === "image-to-video")
			await lockMediaAssetGenerationBindings(
				input.template
					? [input.template.request.inputs.leftAssetId, input.template.request.inputs.rightAssetId]
					: [request.inputAssetId!],
				tx,
			);
		const asset = await findSealedInput(input.ownerId, request, input.maximumInputBytes, tx, now);
		const templateData = input.template
			? await templateAdmissionData(input.ownerId, input.template, input.maximumInputBytes, tx, now)
			: {};
		const requestFingerprint = input.template
			? createHash("sha256")
					.update(
						canonicalVideoTemplateJson({
							ownerId: input.ownerId,
							request,
							...templateData,
							visualSafetyProfile,
							textSafetyProfile,
							audioSafetyPolicy,
						}),
					)
					.digest("hex")
			: fingerprintVideoRequest(input.ownerId, request);
		const quote = {
			ownerType: "USER" as const,
			ownerId: input.ownerId,
			submittedByUserId: input.ownerId,
			productKey: requestProduct(request),
			catalogVersion: requestContract(request),
			pricingVersion: input.price.pricingVersion,
			credits: input.price.credits,
			costMicros: input.price.providerCostMicros + input.price.moderationCostMicros,
			expiresAt: new Date(now.getTime() + 10 * 60_000),
			inputSnapshot: {
				...request,
				...templateData,
				visualSafetyProfile,
				textSafetyProfile,
				audioSafetyPolicy,
				outputStoragePolicy: videoOutputStoragePolicy,
				schemaVersion: 1,
				modelContractVersion: requestContract(request),
				requestFingerprint,
				inputIdentity: asset
					? {
							assetId: asset.id,
							checksum: asset.checksum,
							objectKey: asset.objectKey,
							storageEtag: asset.storageEtag,
							storageVersionId: asset.storageVersionId,
							verificationGeneration: asset.verificationGeneration,
						}
					: null,
			},
			pricingSnapshot: videoPricingSnapshot(input.price),
		};
		const record = await tx.generationQuote.create({
			data: {
				...quote,
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
				moderationDecision: "PENDING_VIDEO_WORKFLOW",
				moderationProvider: ENGINE,
				moderationRuleVersion: requestContract(request),
				moderationReasonCode: "PENDING_VIDEO_WORKFLOW",
			},
		});
		return {
			quoteId: record.id,
			credits: record.credits.toString(),
			expiresAt: record.expiresAt.toISOString(),
			requestFingerprint,
		};
	});
}

export async function findExistingVideoAdmission(
	input: {
		ownerId: string;
		idempotencyKey: string;
		request: VideoRequest;
		template?: TemplateAdmission;
	},
	tx: MediaDatabaseClient,
) {
	const job = await tx.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: "USER",
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: { videoExecution: true, reservation: true },
	});
	if (!job) return null;
	assertTemplateAdmissionSnapshot(job.inputSnapshot, input.template, false);
	if (
		job.executionEngine !== ENGINE ||
		!job.videoExecution ||
		!job.reservation ||
		(!input.template &&
			fingerprintVideoRequest(input.ownerId, snapshotRequest(job.inputSnapshot)) !==
				fingerprintVideoRequest(input.ownerId, input.request))
	)
		throw new Error("IDEMPOTENCY_CONFLICT");
	return job;
}

export async function createVideoJobRecord(
	input: {
		ownerId: string;
		quoteId: string;
		idempotencyKey: string;
		request: VideoRequest;
		price: VideoPrice;
		visualSafetyProfile: VideoVisualSafetyProfile;
		textSafetyProfile: VideoTextSafetyProfile;
		audioSafetyPolicy: VideoAudioSafetyPolicy;
		limits: VideoAdmissionLimits;
		requestReceivedAt?: Date;
		paidFundingPolicy?: PaidCreditFundingPolicy;
		template?: TemplateAdmission;
	},
	client: MediaTransactionClient,
) {
	const request = videoV1InputSchema.parse(input.request);
	if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128)
		throw new Error("INVALID_IDEMPOTENCY_KEY");
	const requiresScene = input.template?.template.schemaVersion === 1;
	for (const value of [
		input.limits.ownerConcurrency,
		input.limits.globalConcurrency,
		input.limits.providerConcurrency,
	])
		if (!Number.isSafeInteger(value) || value < 1) throw new Error("VIDEO_QUOTA_NOT_CONFIGURED");
	// Every mutable admission predicate is protected by the ordered advisory/
	// row locks below. READ COMMITTED observes the prior lock holder's commit;
	// a SERIALIZABLE snapshot taken before waiting needlessly aborts busy bursts.
	const accepted = await runReadCommitted(client, async (tx) => {
		const admissionTransactionStartedAt = new Date().toISOString();
		// Quote security fields are database-immutable. Read them before joining the
		// shared Kie queue, but defer all errors until an accepted replay is checked.
		const quote = await tx.generationQuote.findFirst({
			where: {
				id: input.quoteId,
				ownerType: "USER",
				ownerId: input.ownerId,
				submittedByUserId: input.ownerId,
			},
		});
		const providerCapacityLockRequestedAt = new Date().toISOString();
		// Provider first, then owner: the materialized dependency preserves the same
		// lock order as legacy admission in one round trip. The provider lock already
		// serializes every V1 admission, so a second global video lock is redundant.
		await tx.$executeRaw`
			WITH provider_lock AS MATERIALIZED (
				SELECT pg_advisory_xact_lock(hashtextextended('media:provider-capacity:kie', 0))
			)
			SELECT pg_advisory_xact_lock(hashtextextended(${`USER:${input.ownerId}:generation-concurrency`}, 0))
			FROM provider_lock`;
		const providerCapacityLockAcquiredAt = new Date().toISOString();
		const replay = await findExistingVideoAdmission({ ...input, request }, tx);
		if (replay) return { jobId: replay.id, replayed: true };
		if (
			!quote ||
			quote.productKey !== requestProduct(request) ||
			quote.moderationDecision !== "PENDING_VIDEO_WORKFLOW" ||
			quote.moderationProvider !== ENGINE ||
			quote.catalogVersion !== requestContract(request) ||
			quote.inputFingerprint !== fingerprintGenerationQuoteSecurityPayload(quote)
		)
			throw new Error("INVALID_VIDEO_QUOTE");
		// This must be a separate statement AFTER the advisory lock returns: a
		// statement that waits for a lock can otherwise retain its pre-wait snapshot.
		const [capacity] = await tx.$queryRaw<
			Array<{
				now: Date;
				quoteUsed: boolean;
				blocked: boolean;
				ownerCount: bigint;
				globalCount: bigint;
				legacyCount: bigint;
			}>
		>`
			SELECT clock_timestamp() AS "now",
				EXISTS(SELECT 1 FROM "generation_job" WHERE "quoteId" = ${quote.id}) AS "quoteUsed",
				EXISTS(
					SELECT 1 FROM "runtime_config_override"
					WHERE "active" = true AND "value" = 'false'::jsonb
						AND "configKey" IN ('media.generation.enabled', ${`media.model.${requestProduct(request)}.enabled`}, ${requiresScene ? `media.model.${input.template!.template.scene.productKey}.enabled` : `media.model.${requestProduct(request)}.enabled`}, ${requiresScene ? "media.model.image-nano-banana-2-lite.enabled" : `media.model.${requestProduct(request)}.enabled`})
				) AS "blocked",
				COUNT(*) FILTER (WHERE j."executionEngine" = 'video-workflow-v1'
					AND j."ownerType" = 'USER' AND j."ownerId" = ${input.ownerId}) AS "ownerCount",
				COUNT(*) FILTER (WHERE j."executionEngine" = 'video-workflow-v1') AS "globalCount",
				COUNT(*) FILTER (WHERE j."executionEngine" = 'legacy') AS "legacyCount"
			FROM "generation_job" j
			LEFT JOIN "video_execution" v ON v."jobId" = j."id"
			WHERE (j."executionEngine" = 'video-workflow-v1' AND v."stage" NOT IN ('READY', 'REJECTED', 'FAILED'))
				OR (j."executionEngine" = 'legacy' AND j."terminalAt" IS NULL
					AND j."status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED'))`;
		if (!capacity) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
		const { now } = capacity;
		if (capacity.quoteUsed) throw new Error("VIDEO_QUOTE_ALREADY_USED");
		if (quote.expiresAt <= now) throw new Error("QUOTE_EXPIRED");
		if (
			quote.pricingVersion !== input.price.pricingVersion ||
			quote.credits !== input.price.credits ||
			quote.costMicros !== input.price.providerCostMicros + input.price.moderationCostMicros ||
			quote.inputFingerprint !==
				fingerprintGenerationQuoteSecurityPayload({
					...quote,
					pricingSnapshot: videoPricingSnapshot(input.price),
				})
		)
			throw new Error("PRICE_CHANGED");
		const funding = input.price.pricingDetails?.funding;
		if (
			(funding !== undefined &&
				(!readVideoInternalFundingSnapshot(funding, input.ownerId, now) ||
					input.price.pricingDetails?.paidRevenueQualified !== false ||
					input.price.paidFundingPolicy !== undefined ||
					input.paidFundingPolicy !== undefined)) ||
			(input.price.paidFundingPolicy !== undefined &&
				input.price.paidFundingPolicy.minimumUsdMicrosPerCredit !==
					input.paidFundingPolicy?.minimumUsdMicrosPerCredit)
		)
			throw new Error("VIDEO_FUNDING_POLICY_CHANGED");
		if (
			fingerprintVideoRequest(input.ownerId, snapshotRequest(quote.inputSnapshot)) !==
			fingerprintVideoRequest(input.ownerId, request)
		)
			throw new Error("VIDEO_QUOTE_INPUT_MISMATCH");
		const snap = quote.inputSnapshot as Prisma.JsonObject;
		assertTemplateAdmissionSnapshot(snap, input.template, true);
		if (!snap.visualSafetyProfile) throw new Error("VIDEO_SAFETY_PROFILE_CHANGED");
		const visualSafetyProfile = requiredVisualSafetyProfile(input.visualSafetyProfile, request);
		if (!snap.textSafetyProfile) throw new Error("VIDEO_TEXT_SAFETY_PROFILE_CHANGED");
		const textSafetyProfile = requiredTextSafetyProfile(input.textSafetyProfile);
		if (!snap.audioSafetyPolicy) throw new Error("VIDEO_AUDIO_SAFETY_POLICY_CHANGED");
		const audioSafetyPolicy = requiredAudioSafetyPolicy(input.audioSafetyPolicy);
		// Validate the frozen profile before comparing canonical security payloads.
		// Re-quote on drift; never upgrade an existing quote to a new safety policy.
		readVideoVisualSafetyProfile(snap);
		readVideoTextSafetyProfile(snap);
		readVideoAudioSafetyPolicy(snap);
		if (
			quote.inputFingerprint !==
			fingerprintGenerationQuoteSecurityPayload({
				...quote,
				inputSnapshot: { ...snap, visualSafetyProfile, textSafetyProfile, audioSafetyPolicy },
			})
		)
			throw new Error("VIDEO_SAFETY_PROFILE_CHANGED");
		if (capacity.blocked) throw new Error("VIDEO_DISABLED");
		if (capacity.ownerCount >= BigInt(input.limits.ownerConcurrency))
			throw new Error("VIDEO_OWNER_BUSY");
		if (capacity.globalCount >= BigInt(input.limits.globalConcurrency))
			throw new Error("VIDEO_GLOBAL_BUSY");
		// Conservatively account for every live legacy job, including those not submitted yet.
		if (capacity.globalCount + capacity.legacyCount >= BigInt(input.limits.providerConcurrency))
			throw new Error("VIDEO_PROVIDER_BUSY");
		await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.ownerId }, tx);
		const outputBytes = videoOutputReservationBytes(quote.inputSnapshot);
		const sceneBytes = input.template
			? videoTemplateSceneReservationBytes(quote.inputSnapshot)
			: 0n;
		const usedBytes = await videoOwnerStorageUsage(tx, {
			ownerType: "USER",
			ownerId: input.ownerId,
		});
		if (usedBytes + outputBytes + sceneBytes > input.limits.maximumStorageBytes)
			throw new Error("STORAGE_QUOTA_EXCEEDED");
		if (request.mode === "image-to-video")
			await lockMediaAssetGenerationBindings(
				input.template
					? [input.template.request.inputs.leftAssetId, input.template.request.inputs.rightAssetId]
					: [request.inputAssetId!],
				tx,
			);
		const asset = await findSealedInput(
			input.ownerId,
			request,
			input.limits.maximumInputBytes,
			tx,
			now,
		);
		const roleInputs = input.template
			? await findTemplateRoleInputs(
					input.ownerId,
					input.template.request,
					input.limits.maximumInputBytes,
					tx,
					now,
				)
			: [];
		if (input.template) {
			const currentData = await templateAdmissionData(
				input.ownerId,
				input.template,
				input.limits.maximumInputBytes,
				tx,
				now,
			);
			if (
				canonicalVideoTemplateJson(currentData.roleInputIdentities) !==
				canonicalVideoTemplateJson(snap.roleInputIdentities)
			)
				throw new Error("ASSET_CONTENT_CHANGED");
		}
		const identity = snap.inputIdentity as Prisma.JsonObject | null;
		if (
			asset &&
			(!identity ||
				identity.assetId !== asset.id ||
				identity.checksum !== asset.checksum ||
				identity.objectKey !== asset.objectKey ||
				identity.storageEtag !== asset.storageEtag ||
				identity.storageVersionId !== asset.storageVersionId ||
				identity.verificationGeneration !== asset.verificationGeneration)
		)
			throw new Error("ASSET_CONTENT_CHANGED");
		const account = await tx.creditAccount.findUnique({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: input.ownerId } },
		});
		if (!account) throw new Error("INSUFFICIENT_CREDITS");
		const job = await tx.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: input.ownerId,
				submittedByUserId: input.ownerId,
				quoteId: quote.id,
				idempotencyKey: input.idempotencyKey,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: quote.credits,
				executionEngine: ENGINE,
				inputSnapshot: quote.inputSnapshot as Prisma.InputJsonValue,
				pricingSnapshot: quote.pricingSnapshot as Prisma.InputJsonValue,
			},
		});
		const creditReservationStartedAt = new Date().toISOString();
		await tx.storageUsageReservation.create({
			data: {
				ownerType: "USER",
				ownerId: input.ownerId,
				referenceKey: videoOutputReservationKey(job.id),
				bytes: outputBytes,
				// Non-temporary capacity counts until explicit release/commit, even
				// when this diagnostic timestamp passes during provider recovery.
				expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
			},
		});
		if (input.template) {
			if (sceneBytes > 0n)
				await tx.storageUsageReservation.create({
					data: {
						ownerType: "USER",
						ownerId: input.ownerId,
						referenceKey: videoTemplateSceneReservationKey(job.id),
						bytes: sceneBytes,
						expiresAt: new Date(now.getTime() + 86400000),
					},
				});
			await tx.videoTemplateExecution.create({
				data: {
					jobId: job.id,
					templateSnapshot: snap.videoEffectTemplate as Prisma.InputJsonValue,
					orderedRoleIdentities: snap.roleInputIdentities as Prisma.InputJsonValue,
				},
			});
		}
		await reserveCreditsInTransaction(
			{
				accountId: account.id,
				jobId: job.id,
				amount: quote.credits,
				referenceKey: `job:${job.id}:reserve`,
				paidFundingPolicy: input.paidFundingPolicy,
			},
			tx,
		);
		const creditReservationCompletedAt = new Date().toISOString();
		for (const [position, boundAsset] of [
			...new Map(
				(roleInputs.length ? roleInputs : asset ? [asset] : []).map((value) => [value.id, value]),
			).values(),
		].entries())
			await tx.generationJobAsset.create({
				data: {
					jobId: job.id,
					assetId: boundAsset.id,
					assetChecksum: boundAsset.checksum!,
					role: "INPUT",
					position,
				},
			});
		await tx.videoExecution.create({
			data: {
				jobId: job.id,
				workflowInstanceId: `video-v1-${job.id}`,
				modelContractVersion: requestContract(request),
				stage: "QUEUED",
				startState: "PENDING",
				stageData: {
					timings: {
						admissionTransactionStartedAt,
						providerCapacityLockRequestedAt,
						providerCapacityLockAcquiredAt,
						creditReservationStartedAt,
						creditReservationCompletedAt,
						...(input.requestReceivedAt
							? { requestReceivedAt: input.requestReceivedAt.toISOString() }
							: {}),
						jobReservationWrittenAt: new Date().toISOString(),
					},
				},
			},
		});
		await recordVideoTemplateBusinessEvent(tx, {
			jobId: job.id,
			event: "accepted",
			templateSnapshot: input.template?.template,
		});
		return { jobId: job.id, replayed: false };
	});
	if (!accepted.replayed) {
		// Observe the durable reservation after the transaction's COMMIT has
		// returned. A crash before this diagnostic write leaves it absent; a
		// replay must never manufacture the original reservation commit time.
		const reservedAt = new Date().toISOString();
		await client.$executeRaw`
			UPDATE "video_execution" SET "stageData" = jsonb_set(
				"stageData", '{timings}', COALESCE("stageData"->'timings', '{}'::jsonb)
					|| jsonb_build_object('jobReservedAt', ${reservedAt}::text), true
			)
			WHERE "jobId" = ${accepted.jobId}
				AND "stageData" #>> '{timings,jobReservedAt}' IS NULL`;
	}
	return accepted;
}

export async function getVideoJobRecord(ownerId: string, jobId: string, tx: MediaDatabaseClient) {
	const job = await tx.generationJob.findFirst({
		where: { id: jobId, ownerType: "USER", ownerId, executionEngine: ENGINE },
		include: { videoExecution: true, reservation: true },
	});
	if (!job?.videoExecution || !job.reservation) throw new Error("NOT_FOUND");
	return job;
}

export async function listVideoJobRecords(
	ownerId: string,
	input: { cursor?: string; limit?: number },
	tx: MediaDatabaseClient,
) {
	const limit = Math.min(20, Math.max(1, input.limit ?? 20));
	if (input.cursor) await getVideoJobRecord(ownerId, input.cursor, tx);
	const rows = await tx.generationJob.findMany({
		where: { ownerType: "USER", ownerId, executionEngine: ENGINE },
		include: { videoExecution: true, reservation: true },
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
		take: limit + 1,
	});
	return {
		rows: rows.slice(0, limit),
		nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
	};
}

async function databaseNow(tx: MediaDatabaseClient): Promise<Date> {
	const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
	if (!row) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return row.now;
}
