import {
	getImageProductSelectionContract,
	getImageSkuSelectionContract,
	isEzPicProductKey,
	LEGACY_EZPIC_PRODUCT_KEYS,
	parseImageSelection,
	type EzPicProductKey,
	type ImageAspectRatio,
	type ImageBackground,
	type ImageOutputFormat,
	type ImageSkuKey,
} from "@repo/config";

import type { Prisma } from "../../generated/client";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";
import { createGuestSessionBootstrapWithClaimFence } from "./guest-bootstrap";
import type { MediaTransactionClient } from "./types";

type LegacyEzPicProductKey = (typeof LEGACY_EZPIC_PRODUCT_KEYS)[number];
type StoredEzPicProductKey = EzPicProductKey | LegacyEzPicProductKey;

const LEGACY_IMAGE_DRAFT_TARGETS = {
	"image-fast": "image-nano-banana-2-lite",
	"image-quality": "image-gpt-image-2",
} as const satisfies Record<LegacyEzPicProductKey, EzPicProductKey>;

interface CreateGenerationDraftInput {
	claimTokenHash: string;
	productKey: string;
	input: Prisma.InputJsonValue;
	expiresAt: Date;
	asset?: {
		id: string;
		objectKey: string;
		mimeType: string;
		byteSize: bigint;
		checksum: string;
		finalizedAt: Date;
	};
	abuseLimits?: {
		subjectHash: string;
		maximumActiveDrafts: number;
		maximumActiveBytes: bigint;
		maximumGlobalDraftsPerMinute: number;
	};
}

export async function createGenerationDraftTransaction(
	input: CreateGenerationDraftInput,
	client: MediaTransactionClient,
): Promise<{ id: string; expiresAt: Date }> {
	const normalized = normalizeNewGenerationDraft(input.productKey, input.input);
	if (!normalized) throw new Error("DRAFT_UNAVAILABLE");
	return client.$transaction(async (tx) => {
		if (input.abuseLimits) {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('marketing-draft-global'))`;
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`marketing-draft:${input.abuseLimits.subjectHash}`}))`;
			const now = new Date();
			const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
			const [globalRate] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
				INSERT INTO "rate_limit_bucket" ("id", "action", "subjectHash", "windowStart", "windowEnd", "count", "updatedAt")
				VALUES (gen_random_uuid()::text, 'marketing-draft-global', 'global', ${windowStart}, ${new Date(windowStart.getTime() + 60_000)}, 1, now())
				ON CONFLICT ("action", "subjectHash", "windowStart") DO UPDATE
				SET "count" = "rate_limit_bucket"."count" + 1, "updatedAt" = now()
				RETURNING ("count" <= ${input.abuseLimits.maximumGlobalDraftsPerMinute}) AS "allowed"`;
			if (!globalRate?.allowed) throw new Error("GLOBAL_DRAFT_LIMITED");
			const active = await tx.generationDraft.findMany({
				where: {
					ownerId: `anonymous:${input.abuseLimits.subjectHash}`,
					status: "ACTIVE",
					expiresAt: { gt: now },
				},
				select: { assetId: true },
			});
			if (active.length >= input.abuseLimits.maximumActiveDrafts) {
				throw new Error("ACTIVE_DRAFT_LIMIT_EXCEEDED");
			}
			const activeAssets = await tx.mediaAsset.aggregate({
				where: {
					id: { in: active.flatMap((draft) => (draft.assetId ? [draft.assetId] : [])) },
					deletedAt: null,
				},
				_sum: { byteSize: true },
			});
			const activeBytes = activeAssets._sum.byteSize ?? 0n;
			if (
				activeBytes + BigInt(input.asset?.byteSize ?? 0n) >
				input.abuseLimits.maximumActiveBytes
			) {
				throw new Error("ACTIVE_DRAFT_BYTES_EXCEEDED");
			}
		}
		const draftId = crypto.randomUUID();
		const ownerId = input.abuseLimits
			? `anonymous:${input.abuseLimits.subjectHash}`
			: `draft:${draftId}`;
		if (input.asset) {
			await tx.mediaAsset.create({
				data: {
					...input.asset,
					ownerType: "USER",
					ownerId,
					kind: "INPUT",
					status: "VERIFYING",
				},
			});
		}
		const draft = await tx.generationDraft.create({
			data: {
				id: draftId,
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				claimTokenHash: input.claimTokenHash,
				assetId: input.asset?.id,
				productKey: normalized.productKey,
				inputSnapshot: normalized.inputSnapshot,
				expiresAt: input.expiresAt,
			},
		});
		return { id: draft.id, expiresAt: draft.expiresAt };
	});
}

export async function finalizeGuestDraftFromReadyUploadTransaction(
	input: {
		sessionId: string;
		completionTokenHash: string;
		consumedTokenHash: string;
		claimTokenHash: string;
		capabilityVersion: string;
		promotionPeriod: string;
		maximumOutstandingBootstraps: number;
		productKey: EzPicProductKey;
		skuKey: ImageSkuKey;
		prompt: string;
		aspectRatio?: ImageAspectRatio;
		outputFormat?: ImageOutputFormat;
		background?: ImageBackground;
		expiresAt: Date;
		verification: {
			provider: string;
			ruleVersion: string;
			policyVersion: string;
			now: Date;
		};
	},
	client: MediaTransactionClient,
): Promise<{ id: string; expiresAt: Date }> {
	const normalized = normalizeNewGenerationDraft(input.productKey, {
		kind: "image-to-image",
		prompt: input.prompt,
		skuKey: input.skuKey,
		aspectRatio: input.aspectRatio ?? "auto",
		...(input.outputFormat === undefined ? {} : { outputFormat: input.outputFormat }),
		...(input.background === undefined ? {} : { background: input.background }),
	});
	if (!normalized) {
		throw new Error("GUEST_PRODUCT_UNAVAILABLE");
	}
	return client.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.completionTokenHash}, 0))`;
		const session = await tx.mediaUploadSession.findFirst({
			where: {
				id: input.sessionId,
				tokenHash: input.completionTokenHash,
				guestCompletionConsumedAt: null,
				guestCapabilityVersion: input.capabilityVersion,
				status: "COMPLETED",
				expiresAt: { gt: input.verification.now },
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
						jobBindings: { where: { role: "OUTPUT" }, take: 1, select: { jobId: true } },
					},
				},
			},
		});
		if (!session) throw new Error("GUEST_UPLOAD_UNAVAILABLE");
		if (!hasCurrentApprovedMediaAssetEvidence(session.asset, input.verification)) {
			throw new Error("GUEST_UPLOAD_NOT_READY");
		}
		const consumed = await tx.mediaUploadSession.updateMany({
			where: {
				id: session.id,
				tokenHash: input.completionTokenHash,
				guestCompletionConsumedAt: null,
			},
			data: {
				tokenHash: input.consumedTokenHash,
				guestCompletionConsumedAt: input.verification.now,
			},
		});
		if (consumed.count !== 1) throw new Error("GUEST_COMPLETION_REPLAYED");
		const draft = await tx.generationDraft.create({
			data: {
				ownerType: "USER",
				ownerId: session.asset.ownerId,
				submittedByUserId: session.asset.ownerId,
				claimTokenHash: input.claimTokenHash,
				assetId: session.assetId,
				productKey: normalized.productKey,
				inputSnapshot: normalized.inputSnapshot,
				expiresAt: input.expiresAt,
			},
		});
		await createGuestSessionBootstrapWithClaimFence(
			{
				promotionPeriod: input.promotionPeriod,
				claimHash: input.claimTokenHash,
				idempotencyKey: `guest-bootstrap:${input.sessionId}`,
				claimedDraftId: draft.id,
				sourceAssetId: session.assetId,
				expiresAt: input.expiresAt,
				maximumOutstandingBootstraps: input.maximumOutstandingBootstraps,
				now: input.verification.now,
			},
			tx,
		);
		return { id: draft.id, expiresAt: draft.expiresAt };
	});
}

export async function claimGenerationDraftTransaction(
	input: {
		claimTokenHash: string;
		userId: string;
		allowedProductKeys: readonly EzPicProductKey[];
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> }> {
	return claimGenerationDraftWithPolicy(input, client, false);
}

export async function claimGuestGenerationDraftTransaction(
	input: {
		claimTokenHash: string;
		userId: string;
		allowedProductKeys: readonly EzPicProductKey[];
		now?: Date;
	},
	client: MediaTransactionClient,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> }> {
	return claimGenerationDraftWithPolicy(input, client, true);
}

async function claimGenerationDraftWithPolicy(
	input: {
		claimTokenHash: string;
		userId: string;
		allowedProductKeys: readonly EzPicProductKey[];
		now?: Date;
	},
	client: MediaTransactionClient,
	requireGuestBootstrap: boolean,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> }> {
	const allowedProductKeys = [...new Set(input.allowedProductKeys)];
	if (allowedProductKeys.length === 0) throw new Error("DRAFT_UNAVAILABLE");
	const storedProductKeys = expandStoredDraftProductKeys(allowedProductKeys);
	return client.$transaction(async (tx) => {
		const now = input.now ?? new Date();
		const draft = await tx.generationDraft.findFirst({
			where: {
				claimTokenHash: input.claimTokenHash,
				productKey: { in: storedProductKeys },
				expiresAt: { gt: now },
				...(requireGuestBootstrap
					? {
							guestBootstrap: {
								is: { ownerId: input.userId, completedAt: { not: null } },
							},
						}
					: {}),
				OR: [
					{ status: "ACTIVE" },
					{
						status: "SUBMITTED",
						ownerType: "USER",
						ownerId: input.userId,
						submittedByUserId: input.userId,
					},
				],
			},
		});
		if (!draft) throw new Error("DRAFT_UNAVAILABLE");
		if (draft.status === "SUBMITTED") return toClaimedGenerationDraft(draft);
		if (draft.status !== "ACTIVE") throw new Error("DRAFT_UNAVAILABLE");
		const normalized = normalizeStoredGenerationDraft(draft);
		if (!normalized) throw new Error("DRAFT_UNAVAILABLE");
		const changed = await tx.generationDraft.updateMany({
			where: {
				id: draft.id,
				productKey: { in: storedProductKeys },
				status: "ACTIVE",
				expiresAt: { gt: now },
			},
			data: {
				ownerType: "USER",
				ownerId: input.userId,
				submittedByUserId: input.userId,
				status: "SUBMITTED",
				productKey: normalized.productKey,
				inputSnapshot: normalized.inputSnapshot,
			},
		});
		if (changed.count !== 1) {
			const claimed = await tx.generationDraft.findFirst({
				where: {
					id: draft.id,
					claimTokenHash: input.claimTokenHash,
					productKey: normalized.productKey,
					status: "SUBMITTED",
					ownerType: "USER",
					ownerId: input.userId,
					submittedByUserId: input.userId,
					expiresAt: { gt: now },
				},
			});
			if (!claimed) throw new Error("DRAFT_UNAVAILABLE");
			return toClaimedGenerationDraft(claimed);
		}
		await transferGenerationDraftAssetOwnership(
			{
				assetId: draft.assetId,
				previousOwnerId: draft.ownerId,
				nextOwnerId: input.userId,
			},
			tx,
		);
		return toClaimedNormalizedGenerationDraft(draft, normalized);
	});
}

export async function transferGuestGenerationDraftToRegisteredUserInTransaction(
	input: {
		draftId: string;
		anonymousOwnerId: string;
		registeredUserId: string;
		now: Date;
	},
	tx: Prisma.TransactionClient,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> }> {
	const registeredUser = await tx.user.findUnique({
		where: { id: input.registeredUserId },
		select: { isAnonymous: true },
	});
	if (!registeredUser || registeredUser.isAnonymous) throw new Error("DRAFT_UNAVAILABLE");
	const draft = await tx.generationDraft.findFirst({
		where: {
			id: input.draftId,
			ownerType: "USER",
			ownerId: input.anonymousOwnerId,
			submittedByUserId: input.anonymousOwnerId,
			status: "SUBMITTED",
			expiresAt: { gt: input.now },
		},
	});
	if (!draft) throw new Error("DRAFT_UNAVAILABLE");
	const normalized = normalizeStoredGenerationDraft(draft);
	if (!normalized) throw new Error("DRAFT_UNAVAILABLE");
	const transferred = await tx.generationDraft.updateMany({
		where: {
			id: draft.id,
			ownerType: "USER",
			ownerId: input.anonymousOwnerId,
			submittedByUserId: input.anonymousOwnerId,
			status: "SUBMITTED",
			expiresAt: { gt: input.now },
		},
		data: {
			ownerId: input.registeredUserId,
			submittedByUserId: input.registeredUserId,
			productKey: normalized.productKey,
			inputSnapshot: normalized.inputSnapshot,
		},
	});
	if (transferred.count !== 1) throw new Error("DRAFT_UNAVAILABLE");
	await transferGenerationDraftAssetOwnership(
		{
			assetId: draft.assetId,
			previousOwnerId: input.anonymousOwnerId,
			nextOwnerId: input.registeredUserId,
		},
		tx,
	);
	return toClaimedNormalizedGenerationDraft(draft, normalized);
}

async function transferGenerationDraftAssetOwnership(
	input: { assetId: string | null; previousOwnerId: string; nextOwnerId: string },
	tx: Prisma.TransactionClient,
): Promise<void> {
	if (!input.assetId) return;
	const transferredVerifying = await tx.mediaAsset.updateMany({
		where: { id: input.assetId, ownerId: input.previousOwnerId, status: "VERIFYING" },
		data: { ownerType: "USER", ownerId: input.nextOwnerId },
	});
	if (transferredVerifying.count === 1) {
		await tx.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_VERIFY",
				aggregateType: "MEDIA_ASSET",
				aggregateId: input.assetId,
				dedupeKey: `media-asset-verify:${input.assetId}`,
				payload: { assetId: input.assetId },
			},
		});
		return;
	}
	const startedReadyTransfer = await tx.mediaAsset.updateMany({
		where: { id: input.assetId, ownerId: input.previousOwnerId, status: "READY" },
		data: { status: "VERIFYING" },
	});
	if (startedReadyTransfer.count !== 1) throw new Error("DRAFT_UNAVAILABLE");
	const transferredReady = await tx.mediaAsset.updateMany({
		where: { id: input.assetId, ownerId: input.previousOwnerId, status: "VERIFYING" },
		data: { ownerType: "USER", ownerId: input.nextOwnerId, status: "READY" },
	});
	if (transferredReady.count !== 1) throw new Error("DRAFT_UNAVAILABLE");
}

function toClaimedGenerationDraft(draft: {
	id: string;
	productKey: string | null;
	inputSnapshot: Prisma.JsonValue;
	assetId: string | null;
}): { id: string; productKey: string | null; input: Record<string, unknown> } {
	const normalized = normalizeStoredGenerationDraft(draft);
	if (!normalized) throw new Error("DRAFT_UNAVAILABLE");
	return toClaimedNormalizedGenerationDraft(draft, normalized);
}

function toClaimedNormalizedGenerationDraft(
	draft: { id: string; assetId: string | null },
	normalized: { productKey: EzPicProductKey; inputSnapshot: Prisma.InputJsonObject },
): { id: string; productKey: string | null; input: Record<string, unknown> } {
	return {
		id: draft.id,
		productKey: normalized.productKey,
		input: {
			...(normalized.inputSnapshot as Record<string, unknown>),
			...(draft.assetId ? { sourceAssetId: draft.assetId } : {}),
		},
	};
}

function expandStoredDraftProductKeys(
	allowedProductKeys: readonly EzPicProductKey[],
): StoredEzPicProductKey[] {
	const stored = new Set<StoredEzPicProductKey>(allowedProductKeys);
	for (const legacyKey of LEGACY_EZPIC_PRODUCT_KEYS) {
		if (allowedProductKeys.includes(LEGACY_IMAGE_DRAFT_TARGETS[legacyKey])) stored.add(legacyKey);
	}
	return [...stored];
}

const CURRENT_DRAFT_INPUT_KEYS = new Set([
	"kind",
	"prompt",
	"skuKey",
	"aspectRatio",
	"outputFormat",
	"background",
]);

function normalizeNewGenerationDraft(
	productKey: string,
	input: unknown,
): { productKey: EzPicProductKey; inputSnapshot: Prisma.InputJsonObject } | null {
	if (!isEzPicProductKey(productKey)) return null;
	const inputSnapshot = normalizeImageDraftInput(productKey, input, true);
	return inputSnapshot ? { productKey, inputSnapshot } : null;
}

function normalizeStoredGenerationDraft(draft: {
	productKey: string | null;
	inputSnapshot: Prisma.JsonValue;
}): { productKey: EzPicProductKey; inputSnapshot: Prisma.InputJsonObject } | null {
	if (!isStoredEzPicProductKey(draft.productKey) || !isJsonRecord(draft.inputSnapshot)) return null;
	const productKey = isLegacyEzPicProductKey(draft.productKey)
		? LEGACY_IMAGE_DRAFT_TARGETS[draft.productKey]
		: draft.productKey;
	if (isLegacyEzPicProductKey(draft.productKey)) {
		const contract = getImageProductSelectionContract(productKey);
		if (!contract) return null;
		const defaultCell = getImageSkuSelectionContract(productKey, contract.defaultSkuKey);
		if (!defaultCell) return null;
		const legacyRatio =
			typeof draft.inputSnapshot.aspectRatio === "string" &&
			defaultCell.aspectRatios.includes(draft.inputSnapshot.aspectRatio as ImageAspectRatio)
				? draft.inputSnapshot.aspectRatio
				: contract.defaultAspectRatio;
		const inputSnapshot = normalizeImageDraftInput(
			productKey,
			{
				kind: draft.inputSnapshot.kind,
				prompt: draft.inputSnapshot.prompt,
				skuKey: contract.defaultSkuKey,
				aspectRatio: legacyRatio,
			},
			false,
		);
		return inputSnapshot ? { productKey, inputSnapshot } : null;
	}
	const inputSnapshot = normalizeImageDraftInput(productKey, draft.inputSnapshot, false);
	return inputSnapshot ? { productKey, inputSnapshot } : null;
}

function normalizeImageDraftInput(
	productKey: EzPicProductKey,
	value: unknown,
	strict: boolean,
): Prisma.InputJsonObject | null {
	if (!isJsonRecord(value) || value.kind !== "image-to-image") return null;
	if (strict && Object.keys(value).some((key) => !CURRENT_DRAFT_INPUT_KEYS.has(key))) return null;
	if (typeof value.prompt !== "string") return null;
	const prompt = value.prompt.trim();
	if (prompt.length === 0 || prompt.length > 10_000) return null;
	const selection = parseImageSelection(productKey, value);
	if (!selection) return null;
	return {
		kind: "image-to-image",
		prompt,
		skuKey: selection.skuKey,
		aspectRatio: selection.aspectRatio,
		...(selection.outputFormat === undefined ? {} : { outputFormat: selection.outputFormat }),
		...(selection.background === undefined ? {} : { background: selection.background }),
	};
}

function isStoredEzPicProductKey(value: string | null): value is StoredEzPicProductKey {
	return (
		(typeof value === "string" && isEzPicProductKey(value)) ||
		LEGACY_EZPIC_PRODUCT_KEYS.includes(value as LegacyEzPicProductKey)
	);
}

function isLegacyEzPicProductKey(value: string): value is LegacyEzPicProductKey {
	return LEGACY_EZPIC_PRODUCT_KEYS.includes(value as LegacyEzPicProductKey);
}

function isJsonRecord(value: unknown): value is Prisma.JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function getClaimedGenerationDraft(
	input: { draftId: string; userId: string },
	client: MediaTransactionClient,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> } | null> {
	const draft = await client.generationDraft.findFirst({
		where: { id: input.draftId, ownerType: "USER", ownerId: input.userId, status: "SUBMITTED" },
	});
	if (!draft) return null;
	return toClaimedGenerationDraft(draft);
}

export async function expireGenerationDrafts(
	now: Date,
	client: MediaTransactionClient,
	candidateDraftIds?: string[],
): Promise<number> {
	return client.$transaction(async (tx) => {
		const expired = await tx.generationDraft.findMany({
			where: {
				...(candidateDraftIds ? { id: { in: candidateDraftIds } } : {}),
				status: "ACTIVE",
				expiresAt: { lte: now },
			},
			select: { id: true, assetId: true, ownerId: true },
		});
		let expiredCount = 0;
		for (const draft of expired) {
			const changed = await tx.generationDraft.updateMany({
				where: { id: draft.id, status: "ACTIVE" },
				data: { status: "EXPIRED" },
			});
			// A concurrent claim transfers the draft asset after changing the draft
			// state. Do not emit a physical-object deletion from this stale snapshot.
			if (changed.count !== 1) continue;
			expiredCount += 1;
			if (draft.assetId) {
				const asset = await tx.mediaAsset.findUnique({
					where: { id: draft.assetId },
					select: { objectKey: true },
				});
				await tx.mediaAsset.updateMany({
					where: { id: draft.assetId, ownerId: draft.ownerId, deletedAt: null },
					data: { status: "DELETED", deletedAt: now },
				});
				await tx.outboxEvent.create({
					data: {
						eventType: "MEDIA_OBJECT_DELETE",
						aggregateType: "MEDIA_ASSET",
						aggregateId: draft.assetId,
						dedupeKey: `media-draft-expire-cleanup:${draft.id}`,
						payload: { assetId: draft.assetId, objectKey: asset?.objectKey },
					},
				});
			}
		}
		return expiredCount;
	});
}
