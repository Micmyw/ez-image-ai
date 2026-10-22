import {
	isPermittedModerationEvidence,
	MODERATION_BYPASS_REASON,
	temporaryReferenceObjectKey,
	temporaryReferenceSchema,
	type TemporaryReference,
} from "@repo/config";
import { EZPIC_PRODUCT_KEYS, LEGACY_EZPIC_PRODUCT_KEYS } from "@repo/config";
import { maximumMediaStorageBytes } from "@repo/config/server";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { getInitialGenerationEventIds } from "./continuations";
import { reserveCreditsInTransaction } from "./credits";
import { loadCurrentGenerationAdmission } from "./generation-admission";
import {
	generationFundingSource,
	getGenerationFundingReservation,
	reserveImagePassForJobInTransaction,
} from "./image-passes";
import {
	assertQuoteModerationPermitted,
	recordNewQuoteTextModerationOutcome,
} from "./moderation-operations";
import {
	createModeratedGenerationQuoteRecord,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";
import { canTransition, type GenerationJobStatusValue } from "./state-machine";
import { effectiveMediaStorageLimit, freezeAggregateStoragePolicy } from "./storage-quota";
import { isStorageFreshReadEnabled, lockOwnerStorageUsage } from "./storage-usage-locks";
import { adoptTemporaryReference, unexpiredStorageReservations } from "./temporary-references";
import type {
	CreateGenerationJobInput,
	CreateGenerationJobResult,
	MediaTransactionClient,
} from "./types";
import { isDatabaseUniqueConflict, runReadCommitted, runSerializable } from "./types";

class SerializableAdmissionRequired extends Error {}

// Canonical text-to-image fields contain no stored-media references. Unknown
// or future fields conservatively retain the asset writers' SSI protocol.
const ASSET_FREE_TEXT_INPUT_KEYS = new Set([
	"kind",
	"prompt",
	"skuKey",
	"aspectRatio",
	"outputFormat",
	"background",
	"width",
	"height",
	"submissionFingerprint",
]);

const INITIAL_TEMPORARY_IMAGE_INPUT_KEYS = new Set([
	"kind",
	"prompt",
	"sourceAssetId",
	"skuKey",
	"aspectRatio",
	"outputFormat",
	"background",
	"strength",
	"submissionFingerprint",
	"editContext",
	"temporaryReference",
]);

function isAssetFreeTextInput(value: Prisma.JsonValue | Prisma.InputJsonValue): boolean {
	return (
		isJsonObject(value) &&
		value.kind === "text-to-image" &&
		Object.keys(value).every((key) => ASSET_FREE_TEXT_INPUT_KEYS.has(key)) &&
		(value.submissionFingerprint === undefined ||
			(typeof value.submissionFingerprint === "string" &&
				/^[a-f0-9]{64}$/.test(value.submissionFingerprint)))
	);
}

// Stored-media RC admission is limited to a canonical temporary ROOT input.
// An existing input also needs the first-review fence and state checks below.
function isInitialTemporaryImageInput(
	input: CreateGenerationJobInput,
	value: Prisma.JsonValue | Prisma.InputJsonValue,
): boolean {
	if (
		input.edit?.kind !== "ROOT" ||
		input.inputAssetIds.length !== 1 ||
		!isJsonObject(value) ||
		value.kind !== "image-to-image" ||
		typeof value.prompt !== "string" ||
		!Object.keys(value).every((key) => INITIAL_TEMPORARY_IMAGE_INPUT_KEYS.has(key)) ||
		typeof value.submissionFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.submissionFingerprint) ||
		!isJsonObject(value.editContext) ||
		Object.keys(value.editContext).length !== 2 ||
		value.editContext.kind !== "ROOT" ||
		value.editContext.rootAssetId !== input.edit.rootAssetId ||
		value.sourceAssetId !== input.edit.rootAssetId ||
		value.sourceAssetId !== input.inputAssetIds[0] ||
		["skuKey", "aspectRatio", "outputFormat", "background"].some(
			(key) => value[key] !== undefined && typeof value[key] !== "string",
		) ||
		(value.strength !== undefined &&
			(typeof value.strength !== "number" ||
				!Number.isFinite(value.strength) ||
				value.strength < 0 ||
				value.strength > 1))
	)
		return false;
	const parsed = temporaryReferenceSchema.safeParse(value.temporaryReference);
	return (
		parsed.success &&
		parsed.data.ownerId === input.ownerId &&
		parsed.data.assetId === value.sourceAssetId
	);
}

async function fenceInitialTemporaryInput(
	input: { reference: TemporaryReference; ownerId: string },
	tx: Prisma.TransactionClient,
): Promise<"READY" | "VERIFYING" | null> {
	// Owner storage and binding locks precede verification ownership. The write
	// also makes an older SSI deletion snapshot retry before it can miss the new
	// job binding; SELECT FOR UPDATE alone would not provide that MVCC fence.
	const { reference } = input;
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${reference.assetId}`}, 0))`;
	const [fenced] = await tx.$queryRaw<Array<{ status: "READY" | "VERIFYING" }>>`
		UPDATE "media_asset" SET "updatedAt" = "updatedAt"
		WHERE "id" = ${reference.assetId} AND "ownerType" = 'USER' AND "ownerId" = ${input.ownerId}
		  AND "kind" = 'INPUT' AND "retentionClass" = 'ACCOUNT'
		  AND "objectKey" = ${temporaryReferenceObjectKey(reference)}
		  AND "checksum" = ${reference.checksum} AND "byteSize" = ${BigInt(reference.bytes)}
		  AND "mimeType" = ${reference.contentType} AND "deleteAfter" = ${new Date(reference.expiresAt)}
		  AND "verificationEngine" = 'legacy' AND "deletedAt" IS NULL
		  AND "verificationGeneration" = 1 AND "verificationExhaustedAt" IS NULL
		  AND (
			("status" = 'READY' AND "verificationAttemptCount" > 0
			 AND "verificationSubmissionUncertain" = false
			 AND "verificationLeaseToken" IS NULL AND "verificationLeasedUntil" IS NULL
			 AND "verificationNextAttemptAt" IS NULL AND "verificationLastErrorCode" IS NULL)
			OR ("status" = 'VERIFYING' AND "finalizedAt" IS NOT NULL AND "verificationValidUntil" IS NULL)
		  )
		RETURNING "status"::text AS "status"
	`;
	return fenced?.status ?? null;
}

function isInitialPendingReview(
	asset: Prisma.MediaAssetGetPayload<Record<string, never>>,
	evidence: Prisma.AssetModerationResultGetPayload<Record<string, never>>[],
	input: CreateGenerationJobInput,
	now: Date,
): boolean {
	if (
		asset.status !== "VERIFYING" ||
		asset.verificationGeneration !== 1 ||
		!asset.finalizedAt ||
		!asset.verificationProvider ||
		!input.expectedAssetModerationRuleVersion ||
		!input.expectedAssetModerationPolicyVersion ||
		asset.verificationRuleVersion !== input.expectedAssetModerationRuleVersion ||
		asset.verificationPolicyVersion !== input.expectedAssetModerationPolicyVersion ||
		asset.verificationValidUntil !== null ||
		asset.verificationExhaustedAt !== null ||
		!asset.verificationDeadlineAt ||
		asset.verificationDeadlineAt <= now ||
		evidence.some(
			(item) =>
				item.status !== "PENDING" ||
				item.reasonCode !== "IMAGE_PROCESSING" ||
				item.assetId !== asset.id ||
				item.verificationGeneration !== asset.verificationGeneration ||
				item.assetChecksum !== asset.checksum ||
				item.evidenceKind !== "INPUT" ||
				item.provider !== asset.verificationProvider ||
				item.providerTaskId !== asset.verificationProviderTaskId ||
				item.ruleVersion !== asset.verificationRuleVersion ||
				item.policyVersion !== asset.verificationPolicyVersion ||
				item.validUntil !== null ||
				item.attemptNumber < 1 ||
				item.attemptNumber > asset.verificationAttemptCount,
		)
	)
		return false;
	const noLease = asset.verificationLeaseToken === null && asset.verificationLeasedUntil === null;
	const activeLease = Boolean(
		asset.verificationLeaseToken &&
		asset.verificationLeasedUntil &&
		asset.verificationLeasedUntil > now,
	);
	const submitted = Boolean(asset.verificationSubmissionToken && asset.verificationSubmittedAt);
	if (!evidence.length) {
		const unsent =
			asset.verificationProviderTaskId === null &&
			asset.verificationSubmissionToken === null &&
			asset.verificationSubmittedAt === null &&
			!asset.verificationSubmissionUncertain;
		if (asset.verificationLastErrorCode !== null || asset.verificationNextAttemptAt !== null)
			return false;
		if (asset.verificationAttemptCount === 0) return noLease && unsent;
		if (asset.verificationAttemptCount !== 1 || !activeLease) return false;
		// These are persisted first-attempt states, not proof that HTTP is still
		// running. A crashed submission stays uncertain and joins the same recovery.
		return (
			unsent ||
			(submitted &&
				(asset.verificationProviderTaskId === null
					? asset.verificationSubmissionUncertain
					: !asset.verificationSubmissionUncertain))
		);
	}
	if (!asset.verificationProviderTaskId || !submitted || asset.verificationSubmissionUncertain)
		return false;
	const latestAttempt = Math.max(...evidence.map((item) => item.attemptNumber));
	return noLease
		? latestAttempt === asset.verificationAttemptCount &&
				asset.verificationLastErrorCode === "IMAGE_PROCESSING" &&
				asset.verificationNextAttemptAt !== null
		: activeLease &&
				latestAttempt + 1 === asset.verificationAttemptCount &&
				asset.verificationLastErrorCode === null &&
				asset.verificationNextAttemptAt === null;
}

function assertPreparedSubmissionMatches(
	input: CreateGenerationJobInput,
	quote: {
		ownerType: string;
		ownerId: string;
		submittedByUserId: string;
		inputSnapshot: Prisma.JsonValue | Prisma.InputJsonValue;
	},
): void {
	const prepared = input.preparedQuote;
	if (!prepared) return;
	const expected = isJsonObject(prepared.inputSnapshot)
		? prepared.inputSnapshot.submissionFingerprint
		: undefined;
	if (
		quote.ownerType !== input.ownerType ||
		quote.ownerId !== input.ownerId ||
		quote.submittedByUserId !== input.submittedByUserId ||
		typeof expected !== "string" ||
		!/^[a-f0-9]{64}$/.test(expected) ||
		!isJsonObject(quote.inputSnapshot) ||
		quote.inputSnapshot.submissionFingerprint !== expected
	)
		throw new Error("IDEMPOTENCY_CONFLICT");
}

async function getDatabaseNow(
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<Date> {
	const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
		SELECT CURRENT_TIMESTAMP AS "now"`;
	if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return clock.now;
}

export async function getCommittedDailyGenerationCost(
	input: { ownerType: "USER" | "ORGANIZATION"; ownerId: string; now?: Date },
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<bigint> {
	const startOfDay = new Date(input.now ?? new Date());
	startOfDay.setUTCHours(0, 0, 0, 0);
	const [result] = await client.$queryRaw<Array<{ total: bigint | null }>>`
		SELECT COALESCE(SUM(quote."costMicros"), 0)::bigint AS "total"
		FROM "generation_job" job
		JOIN "generation_quote" quote ON quote."id" = job."quoteId"
		WHERE job."ownerType" = ${input.ownerType}::"OwnerType"
		  AND job."ownerId" = ${input.ownerId}
		  AND job."createdAt" >= ${startOfDay}`;
	return result?.total ?? 0n;
}

export async function getCommittedGlobalDailyGenerationCost(
	input: { now?: Date },
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<bigint> {
	const startOfDay = new Date(input.now ?? new Date());
	startOfDay.setUTCHours(0, 0, 0, 0);
	const [result] = await client.$queryRaw<Array<{ total: bigint | null }>>`
		SELECT COALESCE(SUM(quote."costMicros"), 0)::bigint AS "total"
		FROM "generation_job" job
		JOIN "generation_quote" quote ON quote."id" = job."quoteId"
		WHERE job."createdAt" >= ${startOfDay}`;
	return result?.total ?? 0n;
}

async function findExistingJob(
	input: CreateGenerationJobInput,
	client: MediaTransactionClient | Prisma.TransactionClient,
): Promise<CreateGenerationJobResult | null> {
	const existing = await client.generationJob.findUnique({
		where: {
			ownerType_ownerId_idempotencyKey: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				idempotencyKey: input.idempotencyKey,
			},
		},
		include: { reservation: true, editSession: true },
	});
	if (!existing) return null;
	const reservation =
		existing.reservation ??
		(existing.fundingSource === "IMAGE_PASS"
			? await getGenerationFundingReservation(existing.id, client, null)
			: null);
	if (!reservation) return null;
	if (
		existing.quoteId !== input.quoteId ||
		existing.submittedByUserId !== input.submittedByUserId ||
		!existingJobMatchesEdit(input, existing)
	) {
		throw new Error("IDEMPOTENCY_CONFLICT");
	}
	let committedQuote: CreateGenerationJobResult["committedQuote"];
	if (input.preparedQuote) {
		const quote = await client.generationQuote.findUnique({ where: { id: existing.quoteId } });
		if (!quote) throw new Error("Quote not found for owner");
		assertPreparedSubmissionMatches(input, quote);
		committedQuote = committedQuoteSummary(quote);
	}
	return {
		...(committedQuote ? { committedQuote } : {}),
		continuationEventIds: await getInitialGenerationEventIds(existing.id, client),
		job: {
			id: existing.id,
			status: existing.status,
			version: existing.version,
			creditsReserved: existing.creditsReserved,
		},
		reservation: {
			id: reservation.id,
			amount: reservation.amount,
			status: reservation.status,
		},
		replayed: true,
	};
}

export async function createGenerationJobTransaction(
	input: CreateGenerationJobInput,
	client: MediaTransactionClient,
): Promise<CreateGenerationJobResult> {
	if (input.ownerType !== "USER") {
		throw new Error("First-release writes support USER owners only");
	}
	if (!input.idempotencyKey.trim()) throw new Error("Idempotency key is required");
	if (input.preparedQuote) {
		if (input.preparedQuote.quoteId !== input.quoteId) throw new Error("IDEMPOTENCY_CONFLICT");
		assertPreparedSubmissionMatches(input, input.preparedQuote);
	}
	if (
		input.expectedInputAssets &&
		(input.expectedInputAssets.length !== input.inputAssetIds.length ||
			input.expectedInputAssets.some(
				(expected, position) =>
					expected.assetId !== input.inputAssetIds[position] ||
					!/^[a-f0-9]{64}$/i.test(expected.assetChecksum),
			))
	) {
		throw new Error("ASSET_CONTENT_CHANGED");
	}

	// The storage fence must reach every writer before enabling fresh temporary
	// admissions. Only a fenced normal first review, pending or approved, is reused;
	// other existing assets and edit continuations retain their SSI protocol.
	const initialTemporaryAdmission = Boolean(
		isStorageFreshReadEnabled() &&
		input.preparedQuote &&
		input.validateCurrentEligibility &&
		isImageEditProduct(input.preparedQuote.productKey) &&
		generationFundingSource(input.preparedQuote.pricingSnapshot) === "CREDITS" &&
		input.maximumGlobalDailyCostMicros === undefined &&
		isInitialTemporaryImageInput(input, input.preparedQuote.inputSnapshot),
	);
	// Global budget readers/writers must also share SSI predicate protection;
	// their advisory lock alone cannot refresh a waiting Serializable snapshot.
	let serializable =
		!initialTemporaryAdmission &&
		(input.inputAssetIds.length > 0 ||
			Boolean(input.edit) ||
			input.maximumGlobalDailyCostMicros !== undefined ||
			Boolean(
				input.preparedQuote &&
				(generationFundingSource(input.preparedQuote.pricingSnapshot) === "IMAGE_PASS" ||
					!isAssetFreeTextInput(input.preparedQuote.inputSnapshot)),
			));
	const runAdmission = async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => {
		if (serializable) return runSerializable(client, operation);
		try {
			return await runReadCommitted(client, operation);
		} catch (error) {
			if (!(error instanceof SerializableAdmissionRequired)) throw error;
			serializable = true;
			return runSerializable(client, operation);
		}
	};
	try {
		return await runAdmission(async (tx) => {
			const operationNow = await getDatabaseNow(tx);
			if (input.validateCurrentEligibility) {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerType}:${input.ownerId}:generation-concurrency`}, 0))`;
			}
			const quote = input.preparedQuote
				? await createModeratedGenerationQuoteRecord(input.preparedQuote, tx)
				: await tx.generationQuote.findUnique({ where: { id: input.quoteId } });
			if (
				!quote ||
				quote.ownerType !== input.ownerType ||
				quote.ownerId !== input.ownerId ||
				quote.submittedByUserId !== input.submittedByUserId
			) {
				throw new Error("Quote not found for owner");
			}
			if (quote.expiresAt <= operationNow) throw new Error("Quote expired");
			if (quote.credits <= 0n) throw new Error("Quote credits are invalid");
			const fundingSource = generationFundingSource(quote.pricingSnapshot);
			// Keep pass eligibility and its independent financial reservation under SSI,
			// even when no asset binding or configured global budget requires it.
			// Prepared quotes choose isolation before writing; persisted quotes restart before writes.
			if (!serializable && fundingSource === "IMAGE_PASS")
				throw new SerializableAdmissionRequired();
			if (
				quote.moderationDecision !== "ALLOW" ||
				quote.moderationRuleVersion !== input.expectedModerationRuleVersion ||
				(input.expectedModerationProvider !== undefined &&
					quote.moderationProvider !== input.expectedModerationProvider) ||
				quote.inputFingerprint !== fingerprintGenerationQuoteSecurityPayload(quote)
			) {
				throw new Error("TEXT_MODERATION_EVIDENCE_INVALID");
			}
			if (
				!serializable &&
				!isAssetFreeTextInput(quote.inputSnapshot) &&
				!(initialTemporaryAdmission && isInitialTemporaryImageInput(input, quote.inputSnapshot))
			) {
				// The authoritative quote guards isolation, including omitted asset IDs.
				// Roll back any provisional quote/audit writes before restarting.
				throw new SerializableAdmissionRequired();
			}
			await assertQuoteModerationPermitted(quote, tx);
			const replay = await findExistingJob(input, tx);
			if (replay) return replay;
			const admission =
				input.validateCurrentEligibility || fundingSource === "IMAGE_PASS"
					? await loadCurrentGenerationAdmission(
							{
								ownerId: input.ownerId,
								fundingSource,
								skuKey: isJsonObject(quote.pricingSnapshot)
									? quote.pricingSnapshot.skuKey
									: undefined,
								productKey: quote.productKey,
								costMicros: quote.costMicros,
								now: operationNow,
							},
							tx,
						)
					: undefined;
			await lockOwnerStorageUsage(input, tx);
			const maximumStorageBytes = await effectiveMediaStorageLimit(
				input,
				input.maximumStorageBytes ?? maximumMediaStorageBytes(),
				tx,
			);
			const usage = await tx.storageUsageReservation.aggregate({
				where: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					status: { in: ["ACTIVE", "COMMITTED"] },
					...unexpiredStorageReservations(operationNow),
				},
				_sum: { bytes: true },
			});
			if (maximumStorageBytes !== null && (usage._sum.bytes ?? 0n) >= maximumStorageBytes) {
				throw new Error("STORAGE_QUOTA_EXCEEDED");
			}
			if (input.maximumDailyCostMicros !== undefined) {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.ownerType}:${input.ownerId}:media-daily-budget`}, 0))`;
			}
			if (input.maximumDailyCostMicros !== undefined) {
				const committed = await getCommittedDailyGenerationCost(
					{ ownerType: input.ownerType, ownerId: input.ownerId, now: operationNow },
					tx,
				);
				if (committed + quote.costMicros > input.maximumDailyCostMicros) {
					throw new Error("BUDGET_EXCEEDED");
				}
			}
			if (input.maximumGlobalDailyCostMicros !== undefined) {
				if (input.maximumGlobalDailyCostMicros <= 0n) {
					throw new Error("Global daily Provider budget must be positive");
				}
				const budgetNow = operationNow;
				const utcDay = budgetNow.toISOString().slice(0, 10);
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media:global-daily-provider-budget:${utcDay}`}, 0))`;
				const globallyCommitted = await getCommittedGlobalDailyGenerationCost(
					{ now: budgetNow },
					tx,
				);
				if (globallyCommitted + quote.costMicros > input.maximumGlobalDailyCostMicros) {
					throw new Error("GLOBAL_DAILY_BUDGET_EXCEEDED");
				}
			}
			await lockMediaAssetGenerationBindings(input.inputAssetIds, tx);
			const temporaryValue = isJsonObject(quote.inputSnapshot)
				? quote.inputSnapshot.temporaryReference
				: undefined;
			const adoptedTemporaryReference =
				temporaryValue === undefined
					? null
					: await adoptTemporaryReference(
							{
								value: temporaryValue,
								ownerId: input.ownerId,
								assetIds: input.inputAssetIds,
								now: operationNow,
								expectedRuleVersion: input.expectedAssetModerationRuleVersion,
								expectedPolicyVersion: input.expectedAssetModerationPolicyVersion,
							},
							tx,
						);
			const temporaryReference = adoptedTemporaryReference?.reference ?? null;
			// A newly created input retains its original INSERT + review-event path.
			// Reuse must fence the complete immutable tuple after taking verification
			// ownership, then independently re-read current asset/evidence below.
			const fencedTemporaryInputStatus =
				!serializable &&
				initialTemporaryAdmission &&
				temporaryReference &&
				!adoptedTemporaryReference?.createdVerificationEventId
					? await fenceInitialTemporaryInput(
							{ reference: temporaryReference, ownerId: input.ownerId },
							tx,
						)
					: null;
			if (
				!serializable &&
				initialTemporaryAdmission &&
				!adoptedTemporaryReference?.createdVerificationEventId &&
				!fencedTemporaryInputStatus
			)
				throw new SerializableAdmissionRequired();
			const edit = input.edit;
			if (!edit && imageEditContext(quote.inputSnapshot)) throw new Error("NOT_FOUND");
			const editBinding = edit
				? await resolveImageEditBinding({ ...input, edit }, quote, tx)
				: null;

			const inputAssets = input.inputAssetIds.length
				? await tx.mediaAsset.findMany({
						where: {
							id: { in: input.inputAssetIds },
							ownerType: "USER",
							ownerId: input.ownerId,
							status: temporaryReference ? { in: ["READY", "VERIFYING"] } : "READY",
							deletedAt: null,
							checksum: { not: null },
						},
					})
				: [];
			if (
				inputAssets.length !== new Set(input.inputAssetIds).size ||
				inputAssets.some((asset) => !asset.checksum || !/^[a-f0-9]{64}$/i.test(asset.checksum))
			) {
				throw new Error("Every input asset must be READY and owned by the user");
			}
			if (
				admission &&
				inputAssets.some(
					(asset) =>
						asset.byteSize === null || asset.byteSize > BigInt(admission.maximumInputBytes),
				)
			)
				throw new Error("INPUT_TOO_LARGE");
			if (admission && inputAssets.some((asset) => !asset.mimeType.startsWith("image/")))
				throw new Error("ASSET_NOT_READY");
			const moderationEvidence = inputAssets.length
				? await tx.assetModerationResult.findMany({
						where: {
							OR: inputAssets.map((asset) => ({
								assetId: asset.id,
								verificationGeneration: asset.verificationGeneration,
							})),
						},
						orderBy: [{ assetId: "asc" }, { attemptNumber: "desc" }, { createdAt: "desc" }],
					})
				: [];
			if (
				inputAssets.some(
					(asset) => asset.deleteAfter && asset.deleteAfter.getTime() <= operationNow.getTime(),
				)
			)
				throw new Error("TEMPORARY_REFERENCE_EXPIRED");
			const latestEvidenceByAssetId = new Map<string, (typeof moderationEvidence)[number]>();
			for (const evidence of moderationEvidence) {
				if (!latestEvidenceByAssetId.has(evidence.assetId)) {
					latestEvidenceByAssetId.set(evidence.assetId, evidence);
				}
			}
			if (
				inputAssets.some((asset) => {
					if (asset.id === temporaryReference?.assetId && asset.status === "VERIFYING")
						return false;
					const evidence = latestEvidenceByAssetId.get(asset.id);
					return (
						asset.verificationValidUntil === null ||
						asset.verificationValidUntil <= operationNow ||
						!isPermittedModerationEvidence(evidence) ||
						evidence.attemptNumber !== asset.verificationAttemptCount ||
						evidence.assetChecksum !== asset.checksum ||
						evidence.evidenceKind !== asset.kind ||
						evidence.provider !== asset.verificationProvider ||
						evidence.providerTaskId !== asset.verificationProviderTaskId ||
						evidence.ruleVersion !== asset.verificationRuleVersion ||
						evidence.policyVersion !== asset.verificationPolicyVersion ||
						evidence.validUntil === null ||
						evidence.validUntil.getTime() !== asset.verificationValidUntil.getTime() ||
						evidence.validUntil <= operationNow
					);
				})
			) {
				throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
			}
			if (
				fencedTemporaryInputStatus === "READY" &&
				(inputAssets.some(
					(asset) => latestEvidenceByAssetId.get(asset.id)?.reasonCode !== "NO_POLICY_MATCH",
				) ||
					moderationEvidence.some(
						(evidence) =>
							!["PENDING", "APPROVED"].includes(evidence.status) ||
							evidence.reasonCode.startsWith("ADMIN_") ||
							evidence.reasonCode === MODERATION_BYPASS_REASON,
					))
			)
				throw new SerializableAdmissionRequired();
			if (
				fencedTemporaryInputStatus === "VERIFYING" &&
				!isInitialPendingReview(inputAssets[0]!, moderationEvidence, input, operationNow)
			)
				throw new SerializableAdmissionRequired();
			const currentChecksumById = new Map(
				inputAssets.map((asset) => [asset.id, asset.checksum as string]),
			);
			if (
				input.expectedInputAssets?.some(
					(expected) => currentChecksumById.get(expected.assetId) !== expected.assetChecksum,
				)
			) {
				throw new Error("ASSET_CONTENT_CHANGED");
			}
			if (
				inputAssets.some(
					(asset) =>
						!(asset.id === temporaryReference?.assetId && asset.status === "VERIFYING") &&
						(asset.verificationRuleVersion !== input.expectedAssetModerationRuleVersion ||
							asset.verificationPolicyVersion !== input.expectedAssetModerationPolicyVersion),
				)
			) {
				throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
			}
			const inputChecksumById = input.expectedInputAssets
				? new Map(
						input.expectedInputAssets.map(({ assetId, assetChecksum }) => [assetId, assetChecksum]),
					)
				: currentChecksumById;

			const account = await tx.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: input.ownerType, ownerId: input.ownerId } },
			});
			if (!account && fundingSource === "CREDITS") throw new Error("Credit account not found");
			if (fundingSource === "IMAGE_PASS" && (account?.creditDebt ?? 0n) > 0n)
				throw new Error("CREDIT_DEBT_OUTSTANDING");
			const editSession =
				input.edit?.kind === "ROOT"
					? await tx.imageEditSession.create({
							data: {
								ownerType: input.ownerType,
								ownerId: input.ownerId,
								rootAssetId: input.edit.rootAssetId,
							},
						})
					: null;
			const job = await tx.generationJob.create({
				data: {
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					submittedByUserId: input.submittedByUserId,
					quoteId: quote.id,
					idempotencyKey: input.idempotencyKey,
					productKey: quote.productKey,
					catalogVersion: quote.catalogVersion,
					pricingVersion: quote.pricingVersion,
					creditsReserved: fundingSource === "IMAGE_PASS" ? 0n : quote.credits,
					fundingSource,
					inputSnapshot: generationJobInputSnapshot(quote.inputSnapshot),
					pricingSnapshot: freezeAggregateStoragePolicy(quote.pricingSnapshot, maximumStorageBytes),
					editSessionId: editSession?.id ?? editBinding?.editSessionId,
					parentJobId: editBinding?.parentJobId,
				},
			});
			const reservation =
				fundingSource === "IMAGE_PASS"
					? await reserveImagePassForJobInTransaction({ ownerId: input.ownerId, jobId: job.id }, tx)
					: await reserveCreditsInTransaction(
							{
								accountId: account!.id,
								jobId: job.id,
								amount: quote.credits,
								referenceKey: `job:${job.id}:reserve`,
							},
							tx,
						);
			if (inputAssets.length) {
				await tx.generationJobAsset.createMany({
					data: input.inputAssetIds.map((assetId, position) => ({
						jobId: job.id,
						assetId,
						assetChecksum: inputChecksumById.get(assetId)!,
						role: "INPUT",
						position,
					})),
				});
			}
			const createdJobEvent = await tx.outboxEvent.create({
				data: {
					eventType: "JOB_CREATED",
					aggregateType: "GENERATION_JOB",
					aggregateId: job.id,
					dedupeKey: `job:${job.id}:created`,
					payload: { jobId: job.id },
				},
				select: { id: true },
			});
			if (editBinding?.editSessionId) {
				await tx.imageEditSession.update({
					where: { id: editBinding.editSessionId },
					data: { updatedAt: new Date() },
				});
			}
			// The fresh transaction already owns these exact durable receipts. Re-reading
			// bindings and scanning Outbox here adds cross-owner SSI predicate conflicts.
			// Previously adopted VERIFYING assets still use their current pending events.
			const continuationEventIds = !inputAssets.some((asset) => asset.status === "VERIFYING")
				? [createdJobEvent.id]
				: adoptedTemporaryReference?.createdVerificationEventId
					? [adoptedTemporaryReference.createdVerificationEventId]
					: await getInitialGenerationEventIds(job.id, tx);
			if (input.preparedQuote) {
				// Fresh failure-free ALLOW shares the incident fence. Retried outcomes still
				// acquire its exclusive form last, after the rest of admission is complete.
				await recordNewQuoteTextModerationOutcome(
					{ quoteId: quote.id, moderation: input.preparedQuote.moderation },
					tx,
				);
			}
			if (!serializable && initialTemporaryAdmission) {
				// All owner/binding, credit and moderation locks are now held. A
				// deadline crossed during any wait rolls back the entire admission.
				const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
					SELECT clock_timestamp() AS "now"`;
				if (!clock) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
				if (quote.expiresAt <= clock.now) throw new Error("Quote expired");
				if (!temporaryReference) throw new Error("TEMPORARY_REFERENCE_INVALID");
				if (Date.parse(temporaryReference.expiresAt) <= clock.now.getTime())
					throw new Error("TEMPORARY_REFERENCE_EXPIRED");
				if (inputAssets.some((asset) => asset.deleteAfter && asset.deleteAfter <= clock.now))
					throw new Error("TEMPORARY_REFERENCE_EXPIRED");
				if (
					fencedTemporaryInputStatus === "READY" &&
					inputAssets.some(
						(asset) => !asset.verificationValidUntil || asset.verificationValidUntil <= clock.now,
					)
				)
					throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
				if (
					fencedTemporaryInputStatus === "VERIFYING" &&
					!isInitialPendingReview(inputAssets[0]!, moderationEvidence, input, clock.now)
				)
					throw new Error("ASSET_MODERATION_EVIDENCE_STALE");
			}
			return {
				...(input.preparedQuote ? { committedQuote: committedQuoteSummary(quote) } : {}),
				continuationEventIds,
				...(temporaryReference &&
				inputAssets.some(
					(asset) => asset.id === temporaryReference.assetId && asset.status === "VERIFYING",
				)
					? { verificationAssetId: temporaryReference.assetId }
					: {}),
				job: {
					id: job.id,
					status: job.status,
					version: job.version,
					creditsReserved: job.creditsReserved,
				},
				reservation: {
					id: reservation.id,
					amount: reservation.amount,
					status: reservation.status,
				},
				replayed: false,
			};
		});
	} catch (error) {
		if (isDatabaseUniqueConflict(error)) {
			const replay = await findExistingJob(input, client);
			if (replay) return replay;
			if (input.preparedQuote) {
				// A receiver from the previous rollout may have committed only its quote.
				// Reuse that immutable quote, including its original moderation evidence.
				const quote = await client.generationQuote.findUnique({ where: { id: input.quoteId } });
				if (quote) {
					assertPreparedSubmissionMatches(input, quote);
					// An accepted job may replay its frozen price. An unconsumed old quote
					// still has to match the current admission contract checked by the API.
					if (
						quote.inputFingerprint !==
						fingerprintGenerationQuoteSecurityPayload({
							...input.preparedQuote,
							expiresAt: quote.expiresAt,
						})
					)
						throw new Error("PRICE_CHANGED");
					const result = await createGenerationJobTransaction(
						{ ...input, preparedQuote: undefined },
						client,
					);
					return { ...result, committedQuote: committedQuoteSummary(quote) };
				}
			}
		}
		throw error;
	}
}

function committedQuoteSummary(quote: NonNullable<CreateGenerationJobResult["committedQuote"]>) {
	return {
		id: quote.id,
		productKey: quote.productKey,
		credits: quote.credits,
		pricingSnapshot: quote.pricingSnapshot,
		expiresAt: quote.expiresAt,
	};
}

function existingJobMatchesEdit(
	input: CreateGenerationJobInput,
	existing: {
		editSessionId: string | null;
		parentJobId: string | null;
		editSession: { ownerType: string; ownerId: string; rootAssetId: string } | null;
	},
): boolean {
	if (!input.edit) return existing.editSessionId === null && existing.parentJobId === null;
	if (
		!existing.editSessionId ||
		existing.editSession?.ownerType !== input.ownerType ||
		existing.editSession.ownerId !== input.ownerId
	) {
		return false;
	}
	if (input.edit.kind === "ROOT") {
		return (
			existing.parentJobId === null && existing.editSession.rootAssetId === input.edit.rootAssetId
		);
	}
	if (input.edit.kind === "ROOT_RETRY") {
		return (
			existing.parentJobId === null &&
			existing.editSessionId === input.edit.editSessionId &&
			existing.editSession.rootAssetId === input.edit.rootAssetId
		);
	}
	return (
		existing.parentJobId === input.edit.parentJobId &&
		existing.editSessionId === input.edit.editSessionId
	);
}

async function resolveImageEditBinding(
	input: CreateGenerationJobInput & { edit: NonNullable<CreateGenerationJobInput["edit"]> },
	quote: { productKey: string; inputSnapshot: Prisma.JsonValue },
	tx: Prisma.TransactionClient,
): Promise<{ editSessionId: string | null; parentJobId: string | null }> {
	const sourceAssetId = imageEditSourceAssetId(quote.inputSnapshot);
	const frozenEditContext = imageEditContext(quote.inputSnapshot);
	const expectedSourceAssetId =
		input.edit.kind === "CHILD" ? input.edit.sourceAssetId : input.edit.rootAssetId;
	if (
		!isImageEditProduct(quote.productKey) ||
		sourceAssetId !== expectedSourceAssetId ||
		input.inputAssetIds.length !== 1 ||
		input.inputAssetIds[0] !== expectedSourceAssetId
	) {
		throw new Error("NOT_FOUND");
	}

	if (input.edit.kind === "ROOT" || input.edit.kind === "ROOT_RETRY") {
		if (
			input.edit.kind === "ROOT"
				? frozenEditContext &&
					(frozenEditContext.kind !== "ROOT" ||
						frozenEditContext.rootAssetId !== input.edit.rootAssetId)
				: frozenEditContext?.kind !== "ROOT_RETRY" ||
					frozenEditContext.editSessionId !== input.edit.editSessionId ||
					frozenEditContext.rootAssetId !== input.edit.rootAssetId
		) {
			throw new Error("NOT_FOUND");
		}
		if (input.edit.kind === "ROOT_RETRY") {
			const session = await tx.imageEditSession.findFirst({
				where: {
					id: input.edit.editSessionId,
					ownerType: input.ownerType,
					ownerId: input.ownerId,
					rootAssetId: input.edit.rootAssetId,
				},
				select: { id: true },
			});
			if (!session) throw new Error("NOT_FOUND");
		}
		const rootAsset = await tx.mediaAsset.findFirst({
			where: {
				id: input.edit.rootAssetId,
				ownerType: "USER",
				ownerId: input.ownerId,
			},
			select: { status: true, deletedAt: true, mimeType: true },
		});
		if (!rootAsset) throw new Error("NOT_FOUND");
		if (
			(rootAsset.status !== "READY" &&
				!(
					rootAsset.status === "VERIFYING" &&
					isJsonObject(quote.inputSnapshot) &&
					quote.inputSnapshot.temporaryReference
				)) ||
			rootAsset.deletedAt !== null ||
			!rootAsset.mimeType.startsWith("image/")
		) {
			throw new Error("ASSET_NOT_READY");
		}
		return {
			editSessionId: input.edit.kind === "ROOT_RETRY" ? input.edit.editSessionId : null,
			parentJobId: null,
		};
	}
	if (
		frozenEditContext?.kind !== "CHILD" ||
		frozenEditContext.parentJobId !== input.edit.parentJobId ||
		frozenEditContext.editSessionId !== input.edit.editSessionId ||
		frozenEditContext.sourceAssetId !== input.edit.sourceAssetId
	) {
		throw new Error("NOT_FOUND");
	}

	const parent = await tx.generationJob.findFirst({
		where: {
			id: input.edit.parentJobId,
			ownerType: "USER",
			ownerId: input.ownerId,
		},
		select: {
			status: true,
			productKey: true,
			editSessionId: true,
			editSession: { select: { ownerType: true, ownerId: true } },
			assets: {
				where: { role: "OUTPUT", assetId: input.edit.sourceAssetId },
				select: {
					asset: {
						select: {
							ownerType: true,
							ownerId: true,
							status: true,
							deletedAt: true,
							mimeType: true,
							moderationResults: {
								orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
								take: 1,
								select: { status: true },
							},
						},
					},
				},
			},
		},
	});
	const output = parent?.assets[0]?.asset;
	if (
		!parent ||
		parent.status !== "SUCCEEDED" ||
		!isImageEditProduct(parent.productKey) ||
		!parent.editSessionId ||
		parent.editSessionId !== input.edit.editSessionId ||
		parent.editSession?.ownerType !== input.ownerType ||
		parent.editSession.ownerId !== input.ownerId ||
		!output ||
		output.ownerType !== input.ownerType ||
		output.ownerId !== input.ownerId ||
		output.status !== "READY" ||
		output.deletedAt !== null ||
		!output.mimeType.startsWith("image/") ||
		!isPermittedModerationEvidence(output.moderationResults[0])
	) {
		throw new Error("NOT_FOUND");
	}
	return { editSessionId: input.edit.editSessionId, parentJobId: input.edit.parentJobId };
}

type FrozenImageEditContext =
	| { kind: "ROOT"; rootAssetId: string }
	| { kind: "ROOT_RETRY"; editSessionId: string; rootAssetId: string }
	| { kind: "CHILD"; parentJobId: string; editSessionId: string; sourceAssetId: string };

function imageEditContext(inputSnapshot: Prisma.JsonValue): FrozenImageEditContext | null {
	if (!isJsonObject(inputSnapshot)) return null;
	const context = inputSnapshot.editContext;
	if (context === undefined) return null;
	if (!isJsonObject(context)) throw new Error("NOT_FOUND");
	if (context.kind === "ROOT" && typeof context.rootAssetId === "string") {
		return { kind: "ROOT", rootAssetId: context.rootAssetId };
	}
	if (
		context.kind === "ROOT_RETRY" &&
		typeof context.editSessionId === "string" &&
		context.editSessionId &&
		typeof context.rootAssetId === "string" &&
		context.rootAssetId
	) {
		return {
			kind: "ROOT_RETRY",
			editSessionId: context.editSessionId,
			rootAssetId: context.rootAssetId,
		};
	}
	if (
		context.kind === "CHILD" &&
		typeof context.parentJobId === "string" &&
		typeof context.editSessionId === "string" &&
		typeof context.sourceAssetId === "string"
	) {
		return {
			kind: "CHILD",
			parentJobId: context.parentJobId,
			editSessionId: context.editSessionId,
			sourceAssetId: context.sourceAssetId,
		};
	}
	throw new Error("NOT_FOUND");
}

function generationJobInputSnapshot(inputSnapshot: Prisma.JsonValue): Prisma.InputJsonValue {
	if (!isJsonObject(inputSnapshot)) return inputSnapshot as Prisma.InputJsonValue;
	const {
		editContext: _editContext,
		temporaryReference: _temporaryReference,
		submissionFingerprint: _submissionFingerprint,
		...generationInput
	} = inputSnapshot;
	return generationInput as Prisma.InputJsonObject;
}

function isJsonObject(value: unknown): value is Prisma.JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageEditSourceAssetId(inputSnapshot: Prisma.JsonValue): string | null {
	if (!inputSnapshot || typeof inputSnapshot !== "object" || Array.isArray(inputSnapshot))
		return null;
	const input = inputSnapshot as Record<string, unknown>;
	return input.kind === "image-to-image" && typeof input.sourceAssetId === "string"
		? input.sourceAssetId
		: null;
}

function isImageEditProduct(productKey: string): boolean {
	return [...EZPIC_PRODUCT_KEYS, ...LEGACY_EZPIC_PRODUCT_KEYS].some(
		(candidate) => candidate === productKey,
	);
}

export interface TransitionGenerationJobInput {
	jobId: string;
	expectedStatuses: GenerationJobStatusValue[];
	expectedVersion: number;
	nextStatus: GenerationJobStatusValue;
	failureCode?: string;
	failureMessage?: string;
}

export async function transitionGenerationJob(
	input: TransitionGenerationJobInput,
	client: MediaTransactionClient,
) {
	if (
		!input.expectedStatuses.some((status) => canTransition(status, input.nextStatus)) ||
		input.expectedStatuses.some((status) => !canTransition(status, input.nextStatus))
	) {
		throw new Error("Requested generation job transition is not allowed");
	}
	const terminal = ["SUCCEEDED", "FAILED", "CANCELED"].includes(input.nextStatus);
	const result = await client.generationJob.updateMany({
		where: {
			id: input.jobId,
			executionEngine: "legacy",
			status: { in: input.expectedStatuses },
			version: input.expectedVersion,
		},
		data: {
			status: input.nextStatus,
			version: { increment: 1 },
			failureCode: input.failureCode,
			failureMessage: input.failureMessage,
			terminalAt: terminal ? new Date() : undefined,
		},
	});
	return {
		applied: result.count === 1,
		job: await client.generationJob.findUnique({ where: { id: input.jobId } }),
	};
}

export async function listGenerationJobs(
	input: {
		ownerType: "USER" | "ORGANIZATION";
		ownerId: string;
		take?: number;
		cursor?: { createdAt: Date; id: string };
	},
	client: MediaTransactionClient,
) {
	const take = Math.min(Math.max(input.take ?? 20, 1), 100);
	return client.generationJob.findMany({
		where: {
			executionEngine: "legacy",
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			...(input.cursor
				? {
						OR: [
							{ createdAt: { lt: input.cursor.createdAt } },
							{ createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take,
	});
}
