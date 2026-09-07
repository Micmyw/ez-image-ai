import { ORPCError } from "@orpc/server";
import { getCatalogEntry, getCatalogImageSpecCell, imageAspectRatioSchema } from "@repo/ai";
import {
	EZPIC_PRODUCT_KEYS,
	imageSkuKeySchema,
	LEGACY_EZPIC_PRODUCT_KEYS,
	productModelKeySchema,
	type ImageAspectRatio,
	type ImageSkuKey,
} from "@repo/config";
import { getImageEditSessionForOwner } from "@repo/database";
import { db } from "@repo/database/client";

import { protectedProcedure } from "../../../orpc/procedures";
import { editSessionIdInputSchema, jsonBigInt } from "../types";

type ImageEditProductKey =
	| (typeof EZPIC_PRODUCT_KEYS)[number]
	| (typeof LEGACY_EZPIC_PRODUCT_KEYS)[number];

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
	const input = imageEditInput(job.inputSnapshot, job.productKey);
	const outputBinding = job.assets.find(({ role }) => role === "OUTPUT");
	const output = outputState(outputBinding?.asset, userId);
	return {
		id: job.id,
		parentJobId: job.parentJobId,
		productKey: job.productKey as ImageEditProductKey,
		prompt: input.prompt,
		sourceAssetId: input.sourceAssetId,
		skuKey: input.skuKey,
		aspectRatio: input.aspectRatio,
		credits: jsonBigInt(job.creditsReserved),
		status: job.status,
		createdAt: job.createdAt.toISOString(),
		output,
		canEditAgain: job.status === "SUCCEEDED" && output.state === "READY",
	};
}

function imageEditInput(
	value: unknown,
	rawProductKey: string,
): {
	prompt: string;
	sourceAssetId: string | null;
	skuKey: ImageSkuKey | null;
	aspectRatio: ImageAspectRatio | null;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { prompt: "", sourceAssetId: null, skuKey: null, aspectRatio: null };
	}
	const input = value as Record<string, unknown>;
	if (input.kind !== "image-to-image") {
		return { prompt: "", sourceAssetId: null, skuKey: null, aspectRatio: null };
	}
	const productKey = productModelKeySchema.safeParse(rawProductKey);
	const skuKey = imageSkuKeySchema.safeParse(input.skuKey);
	const aspectRatio = imageAspectRatioSchema.safeParse(input.aspectRatio);
	const cell =
		productKey.success && skuKey.success
			? getCatalogImageSpecCell(getCatalogEntry(productKey.data), skuKey.data)
			: undefined;
	return {
		prompt: typeof input.prompt === "string" ? input.prompt : "",
		sourceAssetId: typeof input.sourceAssetId === "string" ? input.sourceAssetId : null,
		skuKey: cell?.skuKey ?? null,
		aspectRatio:
			cell && aspectRatio.success && cell.aspectRatios.includes(aspectRatio.data)
				? aspectRatio.data
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
