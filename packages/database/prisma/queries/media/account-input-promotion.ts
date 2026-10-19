import type { Prisma } from "../../generated/client";

/** Producer switch. Enable only after every old physical-delete consumer drains. */
export async function accountInputRetentionPatch(
	input: {
		draftId: string;
		nextOwnerId: string;
		asset: { id: string; objectKey: string; retentionClass: string; deleteAfter: Date | null };
	},
	tx: Prisma.TransactionClient,
): Promise<{ retentionClass?: "ACCOUNT"; deleteAfter?: null }> {
	if (
		process.env.ACCOUNT_INPUT_PROMOTION_ENABLED !== "true" ||
		input.asset.retentionClass !== "GUEST_TRIAL"
	)
		return {};
	// Both claim paths update their own draft in this transaction and hold the
	// asset binding + row locks. Guest-link additionally fences guest admission
	// with the guest-owner lock; ordinary claim starts from an exclusive ACTIVE
	// draft, which guest admission cannot consume. Check time after waiting.
	const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
	if (!clock || !input.asset.deleteAfter || input.asset.deleteAfter <= clock.now)
		throw new Error("DRAFT_UNAVAILABLE");
	const [trial, binding, otherDraft, owner, currentDraft] = await Promise.all([
		tx.guestMediaTrial.findFirst({
			where: { OR: [{ sourceDraftId: input.draftId }, { sourceAssetId: input.asset.id }] },
			select: { id: true },
		}),
		tx.generationJobAsset.findFirst({
			where: { assetId: input.asset.id },
			select: { jobId: true },
		}),
		tx.generationDraft.findFirst({
			where: {
				assetId: input.asset.id,
				id: { not: input.draftId },
				status: { in: ["ACTIVE", "SUBMITTED"] },
				expiresAt: { gt: clock.now },
			},
			select: { id: true },
		}),
		tx.user.findUnique({ where: { id: input.nextOwnerId }, select: { isAnonymous: true } }),
		tx.generationDraft.findFirst({
			where: {
				id: input.draftId,
				assetId: input.asset.id,
				ownerType: "USER",
				ownerId: input.nextOwnerId,
				submittedByUserId: input.nextOwnerId,
				status: "SUBMITTED",
				expiresAt: { gt: clock.now },
			},
			select: { id: true },
		}),
	]);
	if (trial || binding || otherDraft || !owner || owner.isAnonymous || !currentDraft)
		throw new Error("DRAFT_UNAVAILABLE");
	// Retire only this obsolete scheduled delivery. LEASED events and tasks that
	// already carry the old payload are protected by the consumer fence instead.
	// PROCESSED is an Outbox no-op disposition, never a physical-storage receipt.
	await tx.outboxEvent.updateMany({
		where: {
			dedupeKey: `guest-media-deadline-cleanup:${input.asset.id}`,
			eventType: "MEDIA_OBJECT_DELETE",
			aggregateType: "MEDIA_ASSET",
			aggregateId: input.asset.id,
			status: "PENDING",
			availableAt: input.asset.deleteAfter,
			payload: { path: ["objectKey"], equals: input.asset.objectKey },
			AND: [{ payload: { path: ["assetId"], equals: input.asset.id } }],
		},
		data: {
			status: "PROCESSED",
			processedAt: clock.now,
			lastError: "SUPERSEDED_BY_ACCOUNT_INPUT_PROMOTION",
		},
	});
	return { retentionClass: "ACCOUNT", deleteAfter: null };
}
