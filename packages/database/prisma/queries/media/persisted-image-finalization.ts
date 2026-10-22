import { createHash } from "node:crypto";

import type { GenerationJob, Prisma } from "../../generated/client";
import {
	hasCurrentApprovedMediaAssetEvidence,
	type MediaAssetVerificationBoundary,
} from "./assets";

type FinalizationJob = Pick<
	GenerationJob,
	| "id"
	| "version"
	| "executionEngine"
	| "status"
	| "productKey"
	| "ownerType"
	| "ownerId"
	| "serviceClass"
	| "guestTrialId"
	| "fundingSource"
	| "failureCode"
>;

const imageExtensions: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/**
 * Complete an image's DB-only finalization after its last review. The caller
 * supplies the job already read in this transaction and checks its catalog kind.
 * No transfer envelope, storage body, remote URL or provider call crosses this
 * boundary. Any incomplete or historical state retains the full finalizer.
 */
export async function completePersistedImageFinalizationInTransaction(
	input: {
		job: FinalizationJob;
		verification: MediaAssetVerificationBoundary;
		/** Transaction-local collector; callers expose these IDs only after commit. */
		settlementEvents?: Array<{ id: string; availableAt: Date }>;
	},
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	const { job, verification } = input;
	if (
		job.executionEngine !== "legacy" ||
		job.status !== "FINALIZING" ||
		job.ownerType !== "USER" ||
		job.serviceClass === "GUEST_SLOW" ||
		job.guestTrialId !== null ||
		job.failureCode !== null ||
		!["CREDITS", "IMAGE_PASS"].includes(job.fundingSource)
	) {
		return false;
	}
	// Select the newest success before joining its envelope. A missing envelope
	// must not make an older attempt look authoritative. Project only cardinality;
	// inline image bytes can be tens of MiB and belong solely to heavy execution.
	const [attempt] = await tx.$queryRaw<
		Array<{ attemptId: string; uncertainSubmission: boolean; outputCount: number | null }>
	>`
		WITH latest_success AS (
			SELECT "id", "uncertainSubmission" FROM "generation_attempt"
			WHERE "jobId" = ${job.id} AND "status" = 'SUCCEEDED'
			ORDER BY "attemptNumber" DESC LIMIT 1
		)
		SELECT latest_success."id" AS "attemptId", latest_success."uncertainSubmission",
			CASE WHEN jsonb_typeof(envelope."payload") = 'object'
				AND envelope."payload"->'version' = '1'::jsonb
				AND jsonb_typeof(envelope."payload"->'outputs') = 'array'
			THEN jsonb_array_length(envelope."payload"->'outputs') ELSE NULL END AS "outputCount"
		FROM latest_success
		LEFT JOIN "generation_attempt_transfer_envelope" envelope
			ON envelope."attemptId" = latest_success."id"
	`;
	if (
		!attempt ||
		attempt.uncertainSubmission ||
		attempt.outputCount === null ||
		!Number.isSafeInteger(attempt.outputCount) ||
		attempt.outputCount < 1 ||
		attempt.outputCount > 4 ||
		(job.fundingSource === "IMAGE_PASS" && attempt.outputCount !== 1)
	) {
		return false;
	}
	const bindings = await tx.generationJobAsset.findMany({
		where: { jobId: job.id, role: "OUTPUT" },
		take: attempt.outputCount + 1,
		select: {
			id: true,
			assetId: true,
			assetChecksum: true,
			position: true,
			asset: {
				select: {
					id: true,
					ownerType: true,
					ownerId: true,
					kind: true,
					status: true,
					retentionClass: true,
					deleteAfter: true,
					deletedAt: true,
					objectKey: true,
					mimeType: true,
					byteSize: true,
					checksum: true,
					finalizedAt: true,
					outputTransferToken: true,
					outputTransferLeaseExpiresAt: true,
					outputStagingObjectKey: true,
					outputPromotionMultipartUploadId: true,
					sourceUrl: true,
					verificationEngine: true,
					verificationGeneration: true,
					verificationAttemptCount: true,
					verificationProvider: true,
					verificationRuleVersion: true,
					verificationPolicyVersion: true,
					verificationProviderTaskId: true,
					verificationLeaseToken: true,
					verificationLeasedUntil: true,
					verificationSubmissionUncertain: true,
					verificationValidUntil: true,
					moderationResults: {
						orderBy: [
							{ verificationGeneration: "desc" },
							{ attemptNumber: "desc" },
							{ createdAt: "desc" },
							{ id: "desc" },
						],
						take: 1,
						select: {
							assetChecksum: true,
							verificationGeneration: true,
							attemptNumber: true,
							evidenceKind: true,
							provider: true,
							providerTaskId: true,
							ruleVersion: true,
							policyVersion: true,
							status: true,
							reasonCode: true,
							validUntil: true,
						},
					},
				},
			},
		},
	});
	if (bindings.length !== attempt.outputCount) return false;
	const positions = new Map<string, { position: number; sourceUrl: string }>(
		Array.from({ length: attempt.outputCount }, (_, position) => {
			const candidateKey = `${attempt.attemptId}:${position}`;
			return [
				`asset_${createHash("sha256").update(`${job.id}:${candidateKey}`).digest("base64url").slice(0, 32)}`,
				{ position, sourceUrl: `provider-output:${candidateKey}` },
			] as const;
		}),
	);
	const seen = new Set<string>();
	for (const binding of bindings) {
		const asset = binding.asset;
		const candidate = positions.get(binding.assetId);
		const extension = imageExtensions[asset.mimeType];
		if (
			!candidate ||
			seen.has(binding.assetId) ||
			asset.id !== binding.assetId ||
			asset.sourceUrl !== candidate.sourceUrl ||
			asset.ownerType !== job.ownerType ||
			asset.ownerId !== job.ownerId ||
			asset.kind !== "OUTPUT" ||
			asset.verificationEngine !== "legacy" ||
			asset.retentionClass !== "ACCOUNT" ||
			asset.deleteAfter !== null ||
			!extension ||
			asset.objectKey !== `users/${job.ownerId}/assets/${asset.id}/original.${extension}` ||
			asset.byteSize <= 0n ||
			!asset.finalizedAt ||
			asset.outputTransferToken !== null ||
			asset.outputTransferLeaseExpiresAt !== null ||
			asset.outputStagingObjectKey !== null ||
			asset.outputPromotionMultipartUploadId !== null ||
			asset.verificationLeaseToken !== null ||
			asset.verificationLeasedUntil !== null ||
			asset.verificationSubmissionUncertain ||
			asset.verificationGeneration < 1 ||
			binding.assetChecksum !== asset.checksum ||
			!hasCurrentApprovedMediaAssetEvidence(asset, verification)
		) {
			return false;
		}
		seen.add(binding.assetId);
	}
	// All checks above are read-only. Repair deterministic positions only after
	// the entire output set has passed; settlement still independently rechecks
	// current approval and funding before any credit or terminal-state mutation.
	for (const binding of bindings) {
		const position = positions.get(binding.assetId)!.position;
		if (binding.position === position) continue;
		const changed = await tx.generationJobAsset.updateMany({
			where: {
				id: binding.id,
				jobId: job.id,
				assetId: binding.assetId,
				role: "OUTPUT",
				assetChecksum: binding.assetChecksum,
			},
			data: { position },
		});
		if (changed.count !== 1) return false;
	}
	const changed = await tx.generationJob.updateMany({
		where: {
			id: job.id,
			version: job.version,
			executionEngine: "legacy",
			status: "FINALIZING",
			productKey: job.productKey,
			ownerType: job.ownerType,
			ownerId: job.ownerId,
			serviceClass: job.serviceClass,
			guestTrialId: null,
			fundingSource: job.fundingSource,
			failureCode: null,
		},
		data: { finalizationStage: null, finalizationErrorCode: null, nextFinalizeAt: null },
	});
	if (changed.count !== 1) return false;
	const settlement = await tx.outboxEvent.upsert({
		where: { dedupeKey: `generation-settle:${job.id}` },
		create: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: job.id,
			dedupeKey: `generation-settle:${job.id}`,
			payload: { jobId: job.id, version: job.version },
		},
		update: {},
	});
	if (input.settlementEvents && ["PENDING", "LEASED"].includes(settlement.status))
		input.settlementEvents.push({ id: settlement.id, availableAt: settlement.availableAt });
	return true;
}
