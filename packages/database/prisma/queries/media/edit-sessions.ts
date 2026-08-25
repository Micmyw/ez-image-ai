import type { Prisma } from "../../generated/client";
import type { MediaTransactionClient } from "./types";

interface EditSessionOwnerInput {
	ownerType: "USER" | "ORGANIZATION";
	ownerId: string;
}

export async function listImageEditSessionsForOwner(
	input: EditSessionOwnerInput & {
		take?: number;
		cursor?: { updatedAt: Date; id: string };
	},
	client: MediaTransactionClient,
) {
	const take = Math.min(Math.max(input.take ?? 20, 1), 100);
	const rows = await client.imageEditSession.findMany({
		where: {
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			...(input.cursor
				? {
						OR: [
							{ updatedAt: { lt: input.cursor.updatedAt } },
							{ updatedAt: input.cursor.updatedAt, id: { lt: input.cursor.id } },
						],
					}
				: {}),
		},
		orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
		include: {
			_count: { select: { jobs: { where: publicImageEditJobWhere(input) } } },
		},
		take: take + 1,
	});
	return { items: rows.slice(0, take), hasMore: rows.length > take };
}

export async function getImageEditSessionForOwner(
	input: EditSessionOwnerInput & { sessionId: string },
	client: MediaTransactionClient,
) {
	return client.imageEditSession.findFirst({
		where: {
			id: input.sessionId,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
		},
		include: {
			jobs: {
				where: publicImageEditJobWhere(input),
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				include: {
					reservation: true,
					assets: {
						orderBy: [{ role: "asc" }, { position: "asc" }, { id: "asc" }],
						include: {
							asset: {
								include: {
									moderationResults: {
										orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
										take: 1,
									},
								},
							},
						},
					},
				},
			},
		},
	});
}

function publicImageEditJobWhere(input: EditSessionOwnerInput): Prisma.GenerationJobWhereInput {
	return {
		ownerType: input.ownerType,
		ownerId: input.ownerId,
		productKey: { in: ["image-fast", "image-quality"] },
		inputSnapshot: { path: ["kind"], equals: "image-to-image" },
	};
}

export async function renameImageEditSessionForOwner(
	input: EditSessionOwnerInput & { sessionId: string; title: string },
	client: MediaTransactionClient,
) {
	const updated = await client.imageEditSession.updateMany({
		where: {
			id: input.sessionId,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
		},
		data: { title: input.title },
	});
	if (updated.count !== 1) return null;
	return client.imageEditSession.findFirst({
		where: {
			id: input.sessionId,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
		},
	});
}

export async function findEligibleImageEditParentForOwner(
	input: EditSessionOwnerInput & { parentJobId: string; sourceAssetId: string },
	client: MediaTransactionClient,
) {
	const parent = await client.generationJob.findFirst({
		where: {
			id: input.parentJobId,
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			status: "SUCCEEDED",
			productKey: { in: ["image-fast", "image-quality"] },
			editSession: {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
			},
		},
		select: {
			editSessionId: true,
			assets: {
				where: { role: "OUTPUT", assetId: input.sourceAssetId },
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
		!parent?.editSessionId ||
		!output ||
		output.ownerType !== input.ownerType ||
		output.ownerId !== input.ownerId ||
		output.status !== "READY" ||
		output.deletedAt !== null ||
		!output.mimeType.startsWith("image/") ||
		output.moderationResults[0]?.status !== "APPROVED"
	) {
		return null;
	}
	return {
		editSessionId: parent.editSessionId,
		parentJobId: input.parentJobId,
		sourceAssetId: input.sourceAssetId,
	};
}
