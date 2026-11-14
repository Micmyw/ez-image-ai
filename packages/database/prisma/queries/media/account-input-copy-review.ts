import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Prisma } from "../../generated/client";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";

type Tx = Prisma.TransactionClient;
type Asset = Prisma.MediaAssetGetPayload<{ include: { moderationResults: true } }>;
export interface AccountInputCopyReviewPolicy {
	provider: string;
	ruleVersion: string;
	policyVersion: string;
}

const proofSchema = z
	.object({
		schemaVersion: z.literal(1),
		method: z.literal("immutable-target-full-sha256-v1"),
		transform: z.literal("none"),
		promotionId: z.string().min(1),
		leaseToken: z.string().min(1),
		sourceAssetId: z.string().min(1),
		sourceObjectKey: z.string().min(1),
		targetAssetId: z.string().min(1),
		targetObjectKey: z.string().min(1),
		checksum: z.string().regex(/^[a-f0-9]{64}$/),
		bytes: z.number().int().positive().safe(),
		mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		storageEtag: z.string().min(1).nullable(),
		storageVersionId: z.string().min(1).nullable(),
	})
	.strict();

/** Server-only attestation emitted after the immutable storage adapter's full readback. */
export type AccountInputCopyReadbackProof = z.infer<typeof proofSchema>;

const normalSeeapiApproval = z
	.object({
		decision: z.literal("ALLOW"),
		evidence: z
			.object({
				requestId: z.string().min(1),
				models: z.tuple([z.literal("nsfw-filter-2")]),
				operations: z.literal(1),
				scores: z.record(z.string(), z.number()),
				seeapi: z
					.object({
						taskId: z.string().min(1),
						flagged: z.literal(false),
						nsfw: z.tuple([]),
						specialCare: z.tuple([]),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

function sourceSnapshot(source: Asset, policy: AccountInputCopyReviewPolicy, now: Date) {
	const evidence = source.moderationResults[0];
	const raw = normalSeeapiApproval.safeParse(evidence?.rawEnvelope);
	if (
		policy.provider !== "seeapi" ||
		source.verificationProvider !== policy.provider ||
		source.ownerType !== "USER" ||
		source.kind !== "INPUT" ||
		source.retentionClass !== "GUEST_TRIAL" ||
		source.verificationEngine !== "legacy" ||
		!source.finalizedAt ||
		source.watermarkVersion !== null ||
		source.watermarkedAt !== null ||
		source.verificationGeneration !== 1 ||
		source.verificationSubmissionUncertain !== false ||
		source.verificationLeaseToken !== null ||
		source.verificationLeasedUntil !== null ||
		source.verificationNextAttemptAt !== null ||
		source.verificationExhaustedAt !== null ||
		source.verificationLastErrorCode !== null ||
		!evidence ||
		evidence.status !== "APPROVED" ||
		evidence.reasonCode !== "NO_POLICY_MATCH" ||
		!evidence.providerTaskId ||
		!raw.success ||
		raw.data.evidence.requestId !== evidence.providerTaskId ||
		raw.data.evidence.seeapi.taskId !== evidence.providerTaskId ||
		!hasCurrentApprovedMediaAssetEvidence(source, { ...policy, now })
	)
		return null;
	// finalizedAt is an immutable identity component, not a cross-runtime clock
	// ordering proof. Only authorization deadlines are compared with database time.
	return {
		source: {
			assetId: source.id,
			ownerId: source.ownerId,
			objectKey: source.objectKey,
			checksum: source.checksum,
			bytes: source.byteSize.toString(),
			mimeType: source.mimeType,
			storageEtag: source.storageEtag,
			storageVersionId: source.storageVersionId,
			finalizedAt: source.finalizedAt.toISOString(),
		},
		evidence: {
			id: evidence.id,
			createdAt: evidence.createdAt.toISOString(),
			verificationGeneration: evidence.verificationGeneration,
			attemptNumber: evidence.attemptNumber,
			provider: evidence.provider,
			providerTaskId: evidence.providerTaskId,
			ruleVersion: evidence.ruleVersion,
			policyVersion: evidence.policyVersion,
			validUntil: evidence.validUntil!.toISOString(),
		},
	};
}

async function reusableSource(
	source: Asset,
	policy: AccountInputCopyReviewPolicy | undefined,
	now: Date,
	tx: Tx,
) {
	if (!policy) return null;
	const snapshot = sourceSnapshot(source, policy, now);
	if (!snapshot) return null;
	// Polls do not add verdicts. Any earlier verdict, failure, bypass, administrator
	// action or previous generation keeps this copy on the normal review path.
	const [row] = await tx.$queryRaw<
		Array<{ count: number }>
	>`SELECT count(*)::int AS "count" FROM "asset_moderation_result" WHERE "assetId"=${source.id}`;
	return row?.count === 1 ? snapshot : null;
}

type CopyIdentity = {
	promotionId: string;
	leaseToken: string;
	source: Asset;
	target: { assetId: string; ownerId: string; objectKey: string };
	policy?: AccountInputCopyReviewPolicy;
	now: Date;
};

/** Called under source verification/asset locks, before any storage I/O. */
export async function freezeAccountInputCopyReview(input: CopyIdentity, tx: Tx) {
	const snapshot = await reusableSource(input.source, input.policy, input.now, tx);
	if (!snapshot) return;
	const payload = {
		schemaVersion: 1,
		promotionId: input.promotionId,
		leaseToken: input.leaseToken,
		target: input.target,
		...snapshot,
	};
	await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload","status","processedAt") VALUES (${randomUUID()},'ACCOUNT_INPUT_COPY_REVIEW_SOURCE','ACCOUNT_INPUT_COPY',${input.promotionId},${`account-input-copy-review-source:${input.promotionId}:${input.leaseToken}`},${JSON.stringify(payload)}::jsonb,'PROCESSED',${input.now})`;
}

/** Missing/old/uncertain proofs never grant approval: the caller queues ordinary review. */
export async function inheritAccountInputCopyReview(
	input: CopyIdentity & {
		proof?: AccountInputCopyReadbackProof;
		uncertainWriter: boolean;
		storageEtag?: string;
		storageVersionId?: string;
	},
	tx: Tx,
): Promise<boolean> {
	if (input.uncertainWriter) return false;
	const proof = proofSchema.safeParse(input.proof);
	if (!proof.success) return false;
	const p = proof.data;
	if (
		p.promotionId !== input.promotionId ||
		p.leaseToken !== input.leaseToken ||
		p.sourceAssetId !== input.source.id ||
		p.sourceObjectKey !== input.source.objectKey ||
		p.targetAssetId !== input.target.assetId ||
		p.targetObjectKey !== input.target.objectKey ||
		p.sourceAssetId === p.targetAssetId ||
		p.sourceObjectKey === p.targetObjectKey ||
		!p.targetObjectKey.startsWith(
			`users/${input.target.ownerId}/assets/${input.target.assetId}/versions/`,
		) ||
		p.checksum !== input.source.checksum ||
		BigInt(p.bytes) !== input.source.byteSize ||
		p.mimeType !== input.source.mimeType ||
		p.storageEtag !== (input.storageEtag ?? null) ||
		p.storageVersionId !== (input.storageVersionId ?? null)
	)
		return false;
	const snapshot = await reusableSource(input.source, input.policy, input.now, tx);
	if (!snapshot) return false;
	const [frozen] = await tx.$queryRaw<
		Array<{ id: string; payload: unknown }>
	>`SELECT "id","payload" FROM "outbox_event" WHERE "dedupeKey"=${`account-input-copy-review-source:${input.promotionId}:${input.leaseToken}`} AND "eventType"='ACCOUNT_INPUT_COPY_REVIEW_SOURCE'`;
	const expected = {
		schemaVersion: 1,
		promotionId: input.promotionId,
		leaseToken: input.leaseToken,
		target: input.target,
		...snapshot,
	};
	// PostgreSQL jsonb reorders keys; compare the normalized JSON values, not strings.
	if (!frozen || !sameJson(frozen.payload, expected)) return false;
	const receiptId = randomUUID();
	const receipt = {
		...p,
		sourceReviewReceiptId: frozen.id,
		source: snapshot.source,
		sourceEvidence: snapshot.evidence,
		targetOwnerId: input.target.ownerId,
		committedAt: input.now.toISOString(),
	};
	await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload","status","processedAt") VALUES (${receiptId},'ACCOUNT_INPUT_COPY_READBACK','MEDIA_ASSET',${input.target.assetId},${`account-input-copy-readback:${input.target.assetId}`},${JSON.stringify(receipt)}::jsonb,'PROCESSED',${input.now})`;
	// This is derived approval, not a new SeeAPI task for the target. Never attach
	// the source provider task to the target callback/polling identity.
	const rawEnvelope = {
		decision: "ALLOW",
		provenance: "IMMUTABLE_ACCOUNT_INPUT_COPY_V1",
		receiptId,
		receipt,
	};
	await tx.$executeRaw`INSERT INTO "asset_moderation_result" ("id","assetId","assetChecksum","verificationGeneration","attemptNumber","evidenceKind","provider","providerTaskId","ruleVersion","policyVersion","status","reasonCode","categories","rawEnvelope","validUntil","createdAt") VALUES (${randomUUID()},${input.target.assetId},${p.checksum},1,1,'INPUT',${snapshot.evidence.provider},NULL,${snapshot.evidence.ruleVersion},${snapshot.evidence.policyVersion},'APPROVED','IMMUTABLE_ACCOUNT_INPUT_COPY_V1','{}'::jsonb,${JSON.stringify(rawEnvelope)}::jsonb,${new Date(snapshot.evidence.validUntil)},${input.now})`;
	await tx.$executeRaw`UPDATE "media_asset" SET "status"='READY',"verificationAttemptCount"=1,"verificationProvider"=${snapshot.evidence.provider},"verificationProviderTaskId"=NULL,"verificationRuleVersion"=${snapshot.evidence.ruleVersion},"verificationPolicyVersion"=${snapshot.evidence.policyVersion},"verificationValidUntil"=${new Date(snapshot.evidence.validUntil)},"verificationDeadlineAt"=NULL,"updatedAt"=${input.now} WHERE "id"=${input.target.assetId} AND "status"='VERIFYING'`;
	return true;
}

function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const a = Object.keys(left),
		b = Object.keys(right);
	return (
		a.length === b.length &&
		a.every(
			(key) =>
				Object.hasOwn(right, key) &&
				sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
		)
	);
}
