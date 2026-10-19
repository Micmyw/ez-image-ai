import { randomUUID } from "node:crypto";

import { getImageProductSelectionContract, resolvePlanEntitlement } from "@repo/config";
import { maximumMediaStorageBytes } from "@repo/config/server";
import { z } from "zod";

import type { Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";
import { findEffectivePaidSubscription } from "./billing";
import { effectiveMediaStorageLimit } from "./storage-quota";
import { lockOwnerStorageUsage } from "./storage-usage-locks";
import { unexpiredStorageReservations } from "./temporary-references";
import { runReadCommitted, type MediaTransactionClient } from "./types";

const INTENT = "ACCOUNT_INPUT_COPY_INTENT";
const sourceSchema = z.object({
	assetId: z.string().min(1),
	ownerId: z.string().min(1),
	objectKey: z.string().min(1),
	checksum: z.string().regex(/^[a-f0-9]{64}$/i),
	bytes: z.number().int().positive().safe(),
	mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});
const intentSchema = z
	.object({
		schemaVersion: z.literal(1),
		draftId: z.string().min(1),
		ownerId: z.string().min(1),
		phase: z.enum(["PENDING", "COPYING", "VERIFYING", "READY", "FAILED", "EXPIRED", "CLEANED"]),
		source: sourceSchema,
		target: z.object({
			assetId: z.string().min(1),
			objectKey: z.string().min(1),
			ownerId: z.string().min(1),
		}),
		expiresAt: z.iso.datetime(),
		leaseToken: z.string().optional(),
		leasedUntil: z.iso.datetime().optional(),
		committedLeaseToken: z.string().optional(),
		multipartUploadId: z.string().min(1).optional(),
		uncertainWriter: z.boolean(),
		sequence: z.number().int().nonnegative(),
		orphanPasses: z.number().int().nonnegative(),
		reasonCode: z.string().optional(),
	})
	.strict();
type Intent = z.infer<typeof intentSchema>;
type Tx = Prisma.TransactionClient;
type ReadClient = Pick<Tx, "$queryRaw">;
type Asset = Prisma.MediaAssetGetPayload<{ include: { moderationResults: true } }>;
export interface AccountInputCopyStatus {
	promotionId: string;
	status: "COPYING" | "VERIFYING" | "READY" | "FAILED" | "EXPIRED";
	reasonCode?: string;
}
export interface AccountInputCopyClaim {
	promotionId: string;
	leaseToken: string;
	source: Pick<Intent["source"], "assetId" | "objectKey" | "checksum" | "bytes" | "mimeType">;
	target: Intent["target"];
	multipartUploadId?: string;
}
export function parseAccountInputCopyIntent(value: unknown): Intent {
	const result = intentSchema.safeParse(value);
	if (
		!result.success ||
		result.data.ownerId !== result.data.target.ownerId ||
		result.data.source.assetId === result.data.target.assetId ||
		result.data.source.objectKey === result.data.target.objectKey
	)
		throw new Error("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	return result.data;
}
export function accountInputCopyObjectKey(
	owner: string,
	asset: string,
	version: string,
	mime: string,
) {
	if (![owner, asset, version].every((id) => /^[A-Za-z0-9_-]+$/.test(id)))
		throw new Error("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	const extension = (
		{ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as Record<string, string>
	)[mime];
	if (!extension) throw new Error("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	return `users/${owner}/assets/${asset}/versions/${version}/original.${extension}`;
}
async function clock(tx: ReadClient) {
	const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!row) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
	return row.now;
}
async function readIntent(id: string, tx: Tx, locked = false) {
	const rows = locked
		? await tx.$queryRaw<
				Array<{ id: string; payload: unknown }>
			>`SELECT "id","payload" FROM "outbox_event" WHERE "id"=${id} AND "eventType"=${INTENT} FOR UPDATE`
		: await tx.$queryRaw<
				Array<{ id: string; payload: unknown }>
			>`SELECT "id","payload" FROM "outbox_event" WHERE "id"=${id} AND "eventType"=${INTENT}`;
	const row = rows[0];
	return row?.id && row.payload
		? { id: row.id, intent: parseAccountInputCopyIntent(row.payload) }
		: null;
}
async function save(id: string, intent: Intent, tx: Tx) {
	await tx.$executeRaw`UPDATE "outbox_event" SET "payload"=${JSON.stringify(intent)}::jsonb WHERE "id"=${id} AND "eventType"=${INTENT}`;
}
async function asset(id: string, tx: ReadClient): Promise<Asset | null> {
	const [row] = await tx.$queryRaw<Asset[]>`SELECT * FROM "media_asset" WHERE "id"=${id}`;
	if (!row) return null;
	const moderationResults = await tx.$queryRaw<
		Asset["moderationResults"]
	>`SELECT * FROM "asset_moderation_result" WHERE "assetId"=${id} ORDER BY "verificationGeneration" DESC,"attemptNumber" DESC,"createdAt" DESC,"id" DESC LIMIT 1`;
	return { ...row, moderationResults };
}
function approved(value: Asset, now: Date) {
	return hasCurrentApprovedMediaAssetEvidence(value, {
		provider: value.verificationProvider ?? "",
		ruleVersion: value.verificationRuleVersion ?? "",
		policyVersion: value.verificationPolicyVersion ?? "",
		now,
	});
}
function awaitingContentReview(value: Asset) {
	const evidence = value.moderationResults[0];
	return (
		value.verificationEngine === "legacy" &&
		value.status === "QUARANTINED" &&
		value.deletedAt === null &&
		value.kind === "INPUT" &&
		Boolean(value.checksum && /^[a-f0-9]{64}$/i.test(value.checksum)) &&
		value.verificationGeneration > 0 &&
		value.verificationAttemptCount > 0 &&
		Boolean(value.verificationProvider) &&
		Boolean(value.verificationRuleVersion) &&
		Boolean(value.verificationPolicyVersion) &&
		value.verificationValidUntil === null &&
		evidence?.status === "REVIEW" &&
		evidence.assetChecksum === value.checksum &&
		evidence.verificationGeneration === value.verificationGeneration &&
		evidence.attemptNumber === value.verificationAttemptCount &&
		evidence.evidenceKind === value.kind &&
		evidence.provider === value.verificationProvider &&
		evidence.providerTaskId === value.verificationProviderTaskId &&
		evidence.ruleVersion === value.verificationRuleVersion &&
		evidence.policyVersion === value.verificationPolicyVersion &&
		evidence.validUntil === null
	);
}
function targetMatches(value: Asset, p: Intent) {
	return (
		value.id === p.target.assetId &&
		value.ownerType === "USER" &&
		value.ownerId === p.ownerId &&
		value.kind === "INPUT" &&
		value.objectKey === p.target.objectKey &&
		value.retentionClass === "ACCOUNT" &&
		value.deleteAfter === null &&
		value.mimeType === p.source.mimeType &&
		value.byteSize === BigInt(p.source.bytes) &&
		(value.status === "UPLOADING" || value.checksum === p.source.checksum)
	);
}
function sourceMatches(value: Asset, p: Intent) {
	return (
		value.id === p.source.assetId &&
		value.ownerType === "USER" &&
		value.ownerId === p.source.ownerId &&
		value.kind === "INPUT" &&
		value.retentionClass === "GUEST_TRIAL" &&
		value.objectKey === p.source.objectKey &&
		value.checksum === p.source.checksum &&
		value.byteSize === BigInt(p.source.bytes) &&
		value.mimeType === p.source.mimeType
	);
}
async function hasClaimedDraftBinding(p: Intent, now: Date, tx: Tx): Promise<boolean> {
	const [binding] = await tx.$queryRaw<
		Array<{ id: string }>
	>`SELECT draft."id" FROM "generation_draft" draft JOIN "user" owner ON owner."id"=draft."ownerId" WHERE draft."id"=${p.draftId} AND draft."ownerId"=${p.ownerId} AND draft."submittedByUserId"=${p.ownerId} AND draft."assetId"=${p.source.assetId} AND draft."status"='SUBMITTED' AND draft."expiresAt">${now} AND owner."isAnonymous" IS NOT TRUE`;
	return Boolean(binding);
}
async function enqueue(id: string, intent: Intent, orphan: boolean, tx: Tx) {
	const event = orphan ? "ACCOUNT_INPUT_COPY_ORPHAN_CHECK" : "ACCOUNT_INPUT_COPY_REQUESTED";
	await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload") VALUES (${randomUUID()},${event},'ACCOUNT_INPUT_COPY',${id},${`${event}:${id}:${intent.sequence}`},${JSON.stringify({ promotionId: id })}::jsonb) ON CONFLICT ("dedupeKey") DO NOTHING`;
}
/** Mirrors draft claim lock ordering; all locks end before storage I/O. */
async function lockCopy(id: string, tx: Tx) {
	const initial = await readIntent(id, tx);
	if (!initial) return null;
	await tx.$queryRaw`SELECT "id" FROM "generation_draft" WHERE "id"=${initial.intent.draftId} FOR UPDATE`;
	await lockOwnerStorageUsage({ ownerType: "USER", ownerId: initial.intent.ownerId }, tx);
	await lockMediaAssetGenerationBindings(
		[initial.intent.source.assetId, initial.intent.target.assetId],
		tx,
	);
	await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id"=${initial.intent.source.assetId} OR "id"=${initial.intent.target.assetId} ORDER BY "id" FOR UPDATE`;
	return readIntent(id, tx, true);
}
function terminal(intent: Intent) {
	return ["FAILED", "EXPIRED", "CLEANED"].includes(intent.phase);
}
async function tombstone(id: string, intent: Intent, reason: string, tx: Tx, expired = false) {
	// A granted writer can still be outside the database when its lease expires.
	// A delete pass is not evidence that its final conditional write has finished.
	if (intent.phase === "COPYING") intent.uncertainWriter = true;
	intent.phase = expired ? "EXPIRED" : "FAILED";
	intent.reasonCode = reason;
	delete intent.leaseToken;
	delete intent.leasedUntil;
	intent.sequence++;
	await tx.$executeRaw`UPDATE "media_asset" SET "status"='DELETED',"deletedAt"=COALESCE("deletedAt",CURRENT_TIMESTAMP),"verificationValidUntil"=NULL,"verificationLeaseToken"=NULL,"verificationLeasedUntil"=NULL,"verificationNextAttemptAt"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=${intent.target.assetId} AND "ownerId"=${intent.ownerId} AND "objectKey"=${intent.target.objectKey}`;
	await save(id, intent, tx);
	await enqueue(id, intent, true, tx);
}

/** Called after the registered draft's exclusive claim, inside that same transaction. */
export async function createAccountInputCopyInTransaction(
	input: {
		draftId: string;
		previousOwnerId: string;
		nextOwnerId: string;
		assetId: string;
	},
	tx: Tx,
): Promise<boolean> {
	if (process.env.ACCOUNT_INPUT_COPY_ENABLED !== "true") return false;
	const source = await asset(input.assetId, tx);
	if (!source || source.retentionClass !== "GUEST_TRIAL") return false;
	const now = await clock(tx);
	const [draft] = await tx.$queryRaw<
		Array<{ id: string; productKey: string; expiresAt: Date }>
	>`SELECT "id","productKey","expiresAt" FROM "generation_draft" WHERE "id"=${input.draftId} AND "assetId"=${input.assetId} AND "ownerId"=${input.nextOwnerId} AND "submittedByUserId"=${input.nextOwnerId} AND "status"='SUBMITTED'`;
	const [owner] = await tx.$queryRaw<
		Array<{ id: string }>
	>`SELECT "id" FROM "user" WHERE "id"=${input.nextOwnerId} AND "isAnonymous" IS NOT TRUE`;
	const [busy] = await tx.$queryRaw<
		Array<{ blocked: boolean }>
	>`SELECT EXISTS(SELECT 1 FROM "guest_media_trial" WHERE "sourceDraftId"=${input.draftId} OR "sourceAssetId"=${source.id}) OR EXISTS(SELECT 1 FROM "generation_job_asset" WHERE "assetId"=${source.id}) OR EXISTS(SELECT 1 FROM "generation_draft" WHERE "assetId"=${source.id} AND "id"<>${input.draftId} AND "status" IN ('ACTIVE','SUBMITTED') AND "expiresAt">${now}) AS "blocked"`;
	if (
		!draft ||
		!owner ||
		busy?.blocked ||
		source.ownerId !== input.previousOwnerId ||
		source.kind !== "INPUT" ||
		source.deletedAt ||
		!["READY", "VERIFYING"].includes(source.status) ||
		!source.checksum ||
		!/^[a-f0-9]{64}$/i.test(source.checksum) ||
		source.byteSize <= 0n ||
		!source.deleteAfter ||
		source.deleteAfter <= now ||
		draft.expiresAt <= now
	)
		throw new Error("DRAFT_UNAVAILABLE");
	const dedupe = `account-input-copy:v1:${input.draftId}`;
	const [existing] = await tx.$queryRaw<
		Array<{ id: string; payload: unknown }>
	>`SELECT "id","payload" FROM "outbox_event" WHERE "dedupeKey"=${dedupe}`;
	if (existing?.id) {
		const old = parseAccountInputCopyIntent(existing.payload);
		if (old.ownerId !== input.nextOwnerId || old.source.assetId !== source.id || terminal(old))
			throw new Error("DRAFT_UNAVAILABLE");
		return true;
	}
	await lockOwnerStorageUsage({ ownerType: "USER", ownerId: input.nextOwnerId }, tx);
	const paid = await findEffectivePaidSubscription(
		{ ownerType: "USER", ownerId: input.nextOwnerId, now },
		tx,
	);
	const entitlement = resolvePlanEntitlement(paid?.plan.metadata, paid?.plan.name);
	const maximumInputBytes = Math.min(
		entitlement.maximumInputBytes,
		getImageProductSelectionContract(draft.productKey)?.maximumInputBytes ??
			entitlement.maximumInputBytes,
	);
	if (source.byteSize > BigInt(maximumInputBytes)) throw new Error("INPUT_TOO_LARGE");
	const limit = await effectiveMediaStorageLimit(
		{ ownerType: "USER", ownerId: input.nextOwnerId },
		maximumMediaStorageBytes(),
		tx,
		now,
	);
	const usage = await tx.storageUsageReservation.aggregate({
		where: {
			ownerType: "USER",
			ownerId: input.nextOwnerId,
			status: { in: ["ACTIVE", "COMMITTED"] },
			...unexpiredStorageReservations(now),
		},
		_sum: { bytes: true },
	});
	if (limit !== null && (usage._sum.bytes ?? 0n) + source.byteSize > limit)
		throw new Error("STORAGE_QUOTA_EXCEEDED");
	const targetId = randomUUID(),
		promotionId = randomUUID();
	const mime = sourceSchema.shape.mimeType.parse(source.mimeType);
	const objectKey = accountInputCopyObjectKey(input.nextOwnerId, targetId, randomUUID(), mime);
	const intent: Intent = {
		schemaVersion: 1,
		draftId: input.draftId,
		ownerId: input.nextOwnerId,
		phase: "PENDING",
		source: {
			assetId: source.id,
			ownerId: source.ownerId,
			objectKey: source.objectKey,
			checksum: source.checksum,
			bytes: Number(source.byteSize),
			mimeType: mime,
		},
		target: { assetId: targetId, objectKey, ownerId: input.nextOwnerId },
		expiresAt: new Date(
			Math.min(source.deleteAfter.getTime(), draft.expiresAt.getTime()),
		).toISOString(),
		uncertainWriter: false,
		sequence: 0,
		orphanPasses: 0,
	};
	await tx.$executeRaw`INSERT INTO "media_asset" ("id","ownerType","ownerId","kind","status","retentionClass","objectKey","mimeType","byteSize","updatedAt") VALUES (${targetId},'USER',${input.nextOwnerId},'INPUT','UPLOADING','ACCOUNT',${objectKey},${mime},${source.byteSize},CURRENT_TIMESTAMP)`;
	await tx.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: input.nextOwnerId,
			bytes: source.byteSize,
			referenceKey: `account-input-copy:${targetId}`,
			expiresAt: new Date(intent.expiresAt),
		},
	});
	// A domain journal record, not a delivered task or physical-completion receipt.
	await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload","status","processedAt") VALUES (${promotionId},${INTENT},'GENERATION_DRAFT',${input.draftId},${dedupe},${JSON.stringify(intent)}::jsonb,'PROCESSED',${now})`;
	// Resolve copy targets through the existing unique dedupe index. Ordinary
	// media verification must not scan all historical Outbox payloads.
	await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload","status","processedAt") VALUES (${randomUUID()},'ACCOUNT_INPUT_COPY_TARGET','MEDIA_ASSET',${targetId},${`account-input-copy-target:${targetId}`},${JSON.stringify({ promotionId })}::jsonb,'PROCESSED',${now})`;
	await enqueue(promotionId, intent, false, tx);
	return true;
}

export async function claimAccountInputCopy(
	input: { promotionId: string },
	client: MediaTransactionClient,
): Promise<AccountInputCopyClaim | null> {
	return runReadCommitted(client, async (tx) => {
		const row = await lockCopy(input.promotionId, tx);
		if (!row) return null;
		const p = row.intent,
			now = await clock(tx);
		if (terminal(p) || ["READY", "VERIFYING"].includes(p.phase)) return null;
		if (Date.parse(p.expiresAt) <= now.getTime()) {
			if (p.phase === "COPYING") p.uncertainWriter = true;
			await tombstone(row.id, p, "ACCOUNT_INPUT_COPY_EXPIRED", tx, true);
			return null;
		}
		if (p.leaseToken && p.leasedUntil && Date.parse(p.leasedUntil) > now.getTime()) return null;
		if (p.leaseToken) p.uncertainWriter = true;
		if (!(await hasClaimedDraftBinding(p, now, tx))) {
			await tombstone(row.id, p, "ACCOUNT_INPUT_COPY_UNAVAILABLE", tx);
			return null;
		}
		const source = await asset(p.source.assetId, tx);
		if (
			!source ||
			!sourceMatches(source, p) ||
			source.deletedAt ||
			["DELETED", "VERIFICATION_FAILED"].includes(source.status) ||
			(source.status === "QUARANTINED" && !awaitingContentReview(source))
		) {
			await tombstone(row.id, p, "ACCOUNT_INPUT_COPY_UNAVAILABLE", tx);
			return null;
		}
		if (!source.deleteAfter || source.deleteAfter <= now) {
			await tombstone(row.id, p, "ACCOUNT_INPUT_COPY_EXPIRED", tx, true);
			return null;
		}
		if (!approved(source, now)) return null;
		p.phase = "COPYING";
		p.leaseToken = randomUUID();
		p.leasedUntil = new Date(now.getTime() + 120_000).toISOString();
		await save(row.id, p, tx);
		return {
			promotionId: row.id,
			leaseToken: p.leaseToken,
			source: p.source,
			target: p.target,
			...(p.multipartUploadId ? { multipartUploadId: p.multipartUploadId } : {}),
		};
	});
}
function assertLease(p: Intent, token: string, now: Date) {
	if (
		p.phase !== "COPYING" ||
		p.leaseToken !== token ||
		!p.leasedUntil ||
		Date.parse(p.leasedUntil) <= now.getTime()
	)
		throw new Error("ACCOUNT_INPUT_COPY_LEASE_LOST");
}
export async function registerAccountInputCopyMultipart(
	input: { promotionId: string; leaseToken: string; multipartUploadId: string },
	client: MediaTransactionClient,
) {
	await runReadCommitted(client, async (tx) => {
		const row = await readIntent(input.promotionId, tx, true);
		if (!row) throw new Error("ACCOUNT_INPUT_COPY_UNAVAILABLE");
		assertLease(row.intent, input.leaseToken, await clock(tx));
		if (row.intent.multipartUploadId && row.intent.multipartUploadId !== input.multipartUploadId)
			throw new Error("ACCOUNT_INPUT_COPY_MULTIPART_CONFLICT");
		row.intent.multipartUploadId = input.multipartUploadId;
		await save(row.id, row.intent, tx);
	});
}
export async function clearAccountInputCopyMultipart(
	input: { promotionId: string; leaseToken: string; multipartUploadId: string },
	client: MediaTransactionClient,
) {
	await runReadCommitted(client, async (tx) => {
		const row = await readIntent(input.promotionId, tx, true);
		if (!row) throw new Error("ACCOUNT_INPUT_COPY_UNAVAILABLE");
		assertLease(row.intent, input.leaseToken, await clock(tx));
		if (row.intent.multipartUploadId !== input.multipartUploadId)
			throw new Error("ACCOUNT_INPUT_COPY_MULTIPART_CONFLICT");
		delete row.intent.multipartUploadId;
		await save(row.id, row.intent, tx);
	});
}
export async function commitAccountInputCopy(
	input: {
		promotionId: string;
		leaseToken: string;
		checksum: string;
		bytes: number;
		mimeType: string;
		storageEtag?: string;
		storageVersionId?: string;
	},
	client: MediaTransactionClient,
) {
	await runReadCommitted(client, async (tx) => {
		const row = await lockCopy(input.promotionId, tx);
		if (!row) throw new Error("ACCOUNT_INPUT_COPY_UNAVAILABLE");
		const p = row.intent,
			now = await clock(tx);
		if (
			input.checksum !== p.source.checksum ||
			input.bytes !== p.source.bytes ||
			input.mimeType !== p.source.mimeType
		)
			throw new Error("ACCOUNT_INPUT_COPY_IDENTITY_CHANGED");
		if (["VERIFYING", "READY"].includes(p.phase)) {
			const target = await asset(p.target.assetId, tx);
			if (p.committedLeaseToken !== input.leaseToken)
				throw new Error("ACCOUNT_INPUT_COPY_LEASE_LOST");
			if (
				!target ||
				!targetMatches(target, p) ||
				target.deletedAt ||
				["DELETED", "QUARANTINED", "VERIFICATION_FAILED"].includes(target.status)
			)
				throw new Error("ACCOUNT_INPUT_COPY_BINDING_CHANGED");
			return;
		}
		assertLease(p, input.leaseToken, now);
		if (Date.parse(p.expiresAt) <= now.getTime()) {
			await tombstone(row.id, p, "ACCOUNT_INPUT_COPY_EXPIRED", tx, true);
			return;
		}
		const binding = await hasClaimedDraftBinding(p, now, tx);
		const target = await asset(p.target.assetId, tx);
		const source = await asset(p.source.assetId, tx);
		if (
			!binding ||
			!target ||
			!source ||
			source.deletedAt ||
			!source.deleteAfter ||
			source.deleteAfter <= now ||
			!approved(source, now) ||
			!sourceMatches(source, p) ||
			!targetMatches(target, p) ||
			target.status !== "UPLOADING" ||
			target.deletedAt
		)
			throw new Error("ACCOUNT_INPUT_COPY_BINDING_CHANGED");
		await tx.$executeRaw`UPDATE "media_asset" SET "status"='VERIFYING',"checksum"=${input.checksum},"storageEtag"=${input.storageEtag ?? null},"storageVersionId"=${input.storageVersionId ?? null},"finalizedAt"=${now},"verificationGeneration"=1,"verificationDeadlineAt"=${new Date(now.getTime() + 120_000)},"updatedAt"=${now} WHERE "id"=${p.target.assetId}`;
		await tx.$executeRaw`UPDATE "generation_draft" SET "assetId"=${p.target.assetId},"updatedAt"=${now} WHERE "id"=${p.draftId} AND "ownerId"=${p.ownerId} AND "assetId"=${p.source.assetId}`;
		await tx.storageUsageReservation.updateMany({
			where: { referenceKey: `account-input-copy:${p.target.assetId}`, status: "ACTIVE" },
			data: { status: "COMMITTED" },
		});
		await tx.$executeRaw`INSERT INTO "outbox_event" ("id","eventType","aggregateType","aggregateId","dedupeKey","payload") VALUES (${randomUUID()},'MEDIA_ASSET_VERIFY','MEDIA_ASSET',${p.target.assetId},${`account-input-copy-verify:${p.target.assetId}:g1`},${JSON.stringify({ assetId: p.target.assetId })}::jsonb) ON CONFLICT ("dedupeKey") DO NOTHING`;
		p.phase = "VERIFYING";
		p.committedLeaseToken = input.leaseToken;
		delete p.leaseToken;
		delete p.leasedUntil;
		await save(row.id, p, tx);
	});
}
export async function failAccountInputCopy(
	input: { promotionId: string; leaseToken: string; reasonCode: string; definitive: boolean },
	client: MediaTransactionClient,
) {
	await runReadCommitted(client, async (tx) => {
		const row = await lockCopy(input.promotionId, tx);
		if (!row || terminal(row.intent)) return;
		assertLease(row.intent, input.leaseToken, await clock(tx));
		if (input.definitive) await tombstone(row.id, row.intent, "ACCOUNT_INPUT_COPY_FAILED", tx);
		else {
			row.intent.uncertainWriter = true;
			delete row.intent.leaseToken;
			delete row.intent.leasedUntil;
			row.intent.phase = "PENDING";
			await save(row.id, row.intent, tx);
		}
	});
}

/** Must run within the verification transaction, before any terminal target can be retried. */
export async function reconcileAccountInputCopyTargetInTransaction(
	input: { assetId: string },
	tx: Tx,
): Promise<{ terminal: boolean }> {
	const [pointer] = await tx.$queryRaw<
		Array<{ payload: unknown }>
	>`SELECT "payload" FROM "outbox_event" WHERE "dedupeKey"=${`account-input-copy-target:${input.assetId}`} AND "eventType"='ACCOUNT_INPUT_COPY_TARGET'`;
	if (!pointer) return { terminal: false };
	const link = z
		.object({ promotionId: z.string().min(1) })
		.strict()
		.safeParse(pointer.payload);
	if (!link.success) throw new Error("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	// Match lockCopy's asset-row -> intent-row order. Verification already owns
	// its advisory lock, but that does not serialize the copy recovery worker.
	await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id"=${input.assetId} FOR UPDATE`;
	const row = await readIntent(link.data.promotionId, tx, true);
	if (!row || row.intent.target.assetId !== input.assetId)
		throw new Error("ACCOUNT_INPUT_COPY_INTENT_INVALID");
	const found = { id: row.id };
	const p = row.intent;
	if (terminal(p)) return { terminal: true };
	const target = await asset(input.assetId, tx);
	if (p.phase === "READY") {
		// The normal media lifecycle owns later reviews. Only a real deletion
		// starts orphan checks for a copy that still has an unresolved old writer.
		if (p.uncertainWriter && target?.deletedAt && target.status === "DELETED") {
			await tombstone(found.id, p, "ACCOUNT_INPUT_COPY_UNAVAILABLE", tx);
			return { terminal: true };
		}
		return { terminal: false };
	}
	if (
		!target ||
		!targetMatches(target, p) ||
		target.deletedAt ||
		["VERIFICATION_FAILED", "DELETED"].includes(target.status) ||
		(target.status === "QUARANTINED" && (p.phase !== "VERIFYING" || !awaitingContentReview(target)))
	) {
		await tombstone(found.id, p, "ACCOUNT_INPUT_COPY_FAILED", tx);
		return { terminal: true };
	}
	if (target.status === "READY" && approved(target, await clock(tx))) {
		if (!p.uncertainWriter) {
			// Standard owner deletion already releases this canonical input key.
			// Unknown writers retain their separate reservation and orphan watch.
			await tx.storageUsageReservation.updateMany({
				where: { referenceKey: `account-input-copy:${p.target.assetId}`, status: "COMMITTED" },
				data: { referenceKey: `media-draft:${p.target.assetId}` },
			});
		}
		p.phase = "READY";
		await save(found.id, p, tx);
	}
	return { terminal: false };
}

export async function getAccountInputCopyStatus(
	input: { ownerId: string; draftId: string },
	client: ReadClient,
): Promise<AccountInputCopyStatus | null> {
	const [row] = await client.$queryRaw<
		Array<{ id: string; payload: unknown }>
	>`SELECT "id","payload" FROM "outbox_event" WHERE "dedupeKey"=${`account-input-copy:v1:${input.draftId}`} AND "eventType"=${INTENT}`;
	if (!row?.id) return null;
	const p = parseAccountInputCopyIntent(row.payload);
	if (p.ownerId !== input.ownerId) return null;
	if (terminal(p))
		return {
			promotionId: row.id,
			status: p.reasonCode === "ACCOUNT_INPUT_COPY_EXPIRED" ? "EXPIRED" : "FAILED",
			reasonCode: p.reasonCode ?? "ACCOUNT_INPUT_COPY_FAILED",
		};
	const target = await asset(p.target.assetId, client),
		now = await clock(client);
	if (!target || !targetMatches(target, p))
		return { promotionId: row.id, status: "FAILED", reasonCode: "ACCOUNT_INPUT_COPY_FAILED" };
	if (target && p.phase !== "PENDING" && p.phase !== "COPYING" && approved(target, now))
		return { promotionId: row.id, status: "READY" };
	if (["VERIFYING", "READY"].includes(p.phase) && awaitingContentReview(target))
		return { promotionId: row.id, status: "VERIFYING" };
	if (
		target?.deletedAt ||
		(target && ["QUARANTINED", "VERIFICATION_FAILED", "DELETED"].includes(target.status))
	)
		return { promotionId: row.id, status: "FAILED", reasonCode: "ACCOUNT_INPUT_COPY_FAILED" };
	return {
		promotionId: row.id,
		status: p.phase === "VERIFYING" || p.phase === "READY" ? "VERIFYING" : "COPYING",
	};
}
export async function recoverAccountInputCopies(
	input: { limit?: number },
	client: MediaTransactionClient,
): Promise<{ promotionIds: string[]; orphanIds: string[] }> {
	const limit = input.limit ?? 25;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error("ACCOUNT_INPUT_COPY_RECOVERY_LIMIT_INVALID");
	const rows = await client.$queryRaw<
		Array<{ id: string }>
	>`SELECT "id" FROM "outbox_event" WHERE "eventType"=${INTENT} AND "availableAt"<=CURRENT_TIMESTAMP AND ("payload"->>'phase' NOT IN ('READY','CLEANED') OR ("payload"->>'phase'='READY' AND "payload"->>'uncertainWriter'='true')) ORDER BY "availableAt","createdAt","id" LIMIT ${limit}`;
	const promotionIds: string[] = [],
		orphanIds: string[] = [];
	for (const { id } of rows)
		await runReadCommitted(client, async (tx) => {
			const row = await lockCopy(id, tx);
			if (!row) return;
			const p = row.intent,
				now = await clock(tx);
			// Rotate every selected journal row, including unresolved orphan work and
			// source-review waits, so a bounded recovery batch cannot starve later rows.
			await tx.$executeRaw`UPDATE "outbox_event" SET "availableAt"=${new Date(now.getTime() + 60_000)} WHERE "id"=${id} AND "eventType"=${INTENT}`;
			if (p.phase === "VERIFYING" || p.phase === "READY") {
				await reconcileAccountInputCopyTargetInTransaction({ assetId: p.target.assetId }, tx);
				return;
			}
			if (p.phase === "CLEANED" || (p.leasedUntil && Date.parse(p.leasedUntil) > now.getTime()))
				return;
			p.sequence++;
			await save(row.id, p, tx);
			await enqueue(row.id, p, terminal(p), tx);
			(terminal(p) ? orphanIds : promotionIds).push(row.id);
		});
	return { promotionIds, orphanIds };
}
export async function claimAccountInputCopyOrphan(
	input: { promotionId: string },
	client: MediaTransactionClient,
) {
	return runReadCommitted(client, async (tx) => {
		const row = await lockCopy(input.promotionId, tx);
		if (!row || !terminal(row.intent) || row.intent.phase === "CLEANED") return null;
		const target = await asset(row.intent.target.assetId, tx);
		if (
			!target ||
			target.status !== "DELETED" ||
			!target.deletedAt ||
			target.objectKey !== row.intent.target.objectKey
		)
			return null;
		return {
			promotionId: row.id,
			assetId: target.id,
			objectKey: target.objectKey,
			...(row.intent.multipartUploadId ? { multipartUploadId: row.intent.multipartUploadId } : {}),
		};
	});
}
export async function recordAccountInputCopyOrphanPass(
	input: { promotionId: string },
	client: MediaTransactionClient,
) {
	await runReadCommitted(client, async (tx) => {
		const row = await lockCopy(input.promotionId, tx);
		if (!row || !terminal(row.intent) || row.intent.phase === "CLEANED") return;
		row.intent.orphanPasses++;
		if (!row.intent.uncertainWriter) {
			await tx.storageUsageReservation.updateMany({
				where: {
					referenceKey: `account-input-copy:${row.intent.target.assetId}`,
					status: { in: ["ACTIVE", "COMMITTED"] },
				},
				data: { status: "RELEASED", releasedAt: await clock(tx) },
			});
			row.intent.phase = "CLEANED";
		}
		await save(row.id, row.intent, tx);
	});
}
