import { ORPCError } from "@orpc/server";
import { getImageEditSessionForOwner } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { editSessionIdInputSchema, jsonBigInt } from "../types";

export const getEditSession = protectedProcedure
	.route({ method: "GET", path: "/media/edit-sessions/{sessionId}", tags: ["Media"] })
	.input(editSessionIdInputSchema)
	.handler(async ({ context: { user }, input }) => {
		const session = await getImageEditSessionForOwner(
			{ ownerType: "USER", ownerId: user.id, sessionId: input.sessionId },
			db,
		);
		if (!session) throw new ORPCError("NOT_FOUND");
		return {
			id: session.id,
			rootAssetId: session.rootAssetId,
			title: session.title,
			createdAt: session.createdAt.toISOString(),
			updatedAt: session.updatedAt.toISOString(),
			versions: session.jobs.map((job) => versionDto(job, user.id)),
		};
	});

function versionDto(
	job: {
		id: string;
		parentJobId: string | null;
		productKey: string;
		status: string;
		creditsReserved: bigint;
		inputSnapshot: unknown;
		createdAt: Date;
		assets: Array<{
			role: string;
			position: number;
			asset: {
				id: string;
				ownerType: string;
				ownerId: string;
				status: string;
				deletedAt: Date | null;
				mimeType: string;
				moderationResults: Array<{ status: string }>;
			};
		}>;
	},
	userId: string,
) {
	const input = imageEditInput(job.inputSnapshot);
	const outputBinding = job.assets.find(({ role }) => role === "OUTPUT");
	const output = outputState(outputBinding?.asset, userId);
	return {
		id: job.id,
		parentJobId: job.parentJobId,
		productKey: job.productKey as "image-fast" | "image-quality",
		prompt: input.prompt,
		sourceAssetId: input.sourceAssetId,
		credits: jsonBigInt(job.creditsReserved),
		status: job.status,
		createdAt: job.createdAt.toISOString(),
		output,
		canEditAgain: job.status === "SUCCEEDED" && output.state === "READY",
	};
}

function imageEditInput(value: unknown): { prompt: string; sourceAssetId: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { prompt: "", sourceAssetId: null };
	}
	const input = value as Record<string, unknown>;
	return {
		prompt: input.kind === "image-to-image" && typeof input.prompt === "string" ? input.prompt : "",
		sourceAssetId:
			input.kind === "image-to-image" && typeof input.sourceAssetId === "string"
				? input.sourceAssetId
				: null,
	};
}

function outputState(
	asset:
		| {
				id: string;
				ownerType: string;
				ownerId: string;
				status: string;
				deletedAt: Date | null;
				mimeType: string;
				moderationResults: Array<{ status: string }>;
		  }
		| undefined,
	userId: string,
): { state: "READY" | "DELETED" | "UNAVAILABLE"; assetId: string | null } {
	if (!asset || asset.ownerType !== "USER" || asset.ownerId !== userId) {
		return { state: "UNAVAILABLE", assetId: null };
	}
	if (asset.deletedAt !== null || asset.status === "DELETED") {
		return { state: "DELETED", assetId: null };
	}
	if (
		asset.status === "READY" &&
		asset.mimeType.startsWith("image/") &&
		asset.moderationResults[0]?.status === "APPROVED"
	) {
		return { state: "READY", assetId: asset.id };
	}
	return { state: "UNAVAILABLE", assetId: null };
}
