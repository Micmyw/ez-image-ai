import type { Prisma } from "../../generated/client";
import { hasCurrentApprovedMediaAssetEvidence } from "./assets";
import { createGuestSessionBootstrapWithClaimFence } from "./guest-bootstrap";
import type { MediaTransactionClient } from "./types";

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
				productKey: input.productKey,
				inputSnapshot: input.input,
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
		productKey: "image-fast" | "image-quality";
		prompt: string;
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
	if (input.productKey !== "image-fast" && input.productKey !== "image-quality") {
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
				productKey: input.productKey,
				inputSnapshot: { kind: "image-to-image", prompt: input.prompt },
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
		allowedProductKeys: readonly ("image-fast" | "image-quality")[];
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
		allowedProductKeys: readonly ("image-fast" | "image-quality")[];
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
		allowedProductKeys: readonly ("image-fast" | "image-quality")[];
		now?: Date;
	},
	client: MediaTransactionClient,
	requireGuestBootstrap: boolean,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> }> {
	const allowedProductKeys = [...new Set(input.allowedProductKeys)];
	if (allowedProductKeys.length === 0) throw new Error("DRAFT_UNAVAILABLE");
	return client.$transaction(async (tx) => {
		const now = input.now ?? new Date();
		const draft = await tx.generationDraft.findFirst({
			where: {
				claimTokenHash: input.claimTokenHash,
				productKey: { in: allowedProductKeys },
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
		const changed = await tx.generationDraft.updateMany({
			where: {
				id: draft.id,
				productKey: { in: allowedProductKeys },
				status: "ACTIVE",
				expiresAt: { gt: now },
			},
			data: {
				ownerType: "USER",
				ownerId: input.userId,
				submittedByUserId: input.userId,
				status: "SUBMITTED",
			},
		});
		if (changed.count !== 1) {
			const claimed = await tx.generationDraft.findFirst({
				where: {
					id: draft.id,
					claimTokenHash: input.claimTokenHash,
					productKey: { in: allowedProductKeys },
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
		return toClaimedGenerationDraft(draft);
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
	return toClaimedGenerationDraft(draft);
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
	return {
		id: draft.id,
		productKey: draft.productKey,
		input: {
			...(draft.inputSnapshot as Record<string, unknown>),
			...(draft.assetId ? { sourceAssetId: draft.assetId } : {}),
		},
	};
}

export async function getClaimedGenerationDraft(
	input: { draftId: string; userId: string },
	client: MediaTransactionClient,
): Promise<{ id: string; productKey: string | null; input: Record<string, unknown> } | null> {
	const draft = await client.generationDraft.findFirst({
		where: { id: input.draftId, ownerType: "USER", ownerId: input.userId, status: "SUBMITTED" },
	});
	if (!draft) return null;
	return {
		id: draft.id,
		productKey: draft.productKey,
		input: {
			...(draft.inputSnapshot as Record<string, unknown>),
			...(draft.assetId ? { sourceAssetId: draft.assetId } : {}),
		},
	};
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
