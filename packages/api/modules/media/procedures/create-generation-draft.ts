import { createHash, randomUUID } from "node:crypto";

import { promptSchema, quoteCatalogInput } from "@repo/ai";
import {
	DEFAULT_PRODUCT_CONFIG,
	EZPIC_PRODUCT_KEYS,
	imageAspectRatioSchema,
	imageBackgroundSchema,
	imageOutputFormatSchema,
	imageSkuKeySchema,
	isValidImageSelection,
} from "@repo/config";
import { createGenerationDraftTransaction } from "@repo/database";
import { db } from "@repo/database/client";
import { createAssetObjectKey, deleteObject, putPrivateMediaObject } from "@repo/storage";
import { z } from "zod";

import { publicProcedure } from "../../../orpc/procedures";
import {
	createDraftClaimToken,
	hashDraftClaimToken,
	resolveGuestPublicOrigin,
} from "../lib/draft-security";

const draftUploadSchema = z
	.object({
		contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		base64: z
			.string()
			.min(1)
			.max(4 * Math.ceil(DEFAULT_PRODUCT_CONFIG.uploadLimits.imageBytes / 3))
			.refine(
				(value) =>
					Buffer.from(value, "base64").byteLength <= DEFAULT_PRODUCT_CONFIG.uploadLimits.imageBytes,
				{ message: "SOURCE_IMAGE_TOO_LARGE" },
			),
	})
	.strict();

export const marketingGenerationDraftInputSchema = z
	.object({
		productKey: z.enum(EZPIC_PRODUCT_KEYS),
		input: z
			.object({
				kind: z.literal("image-to-image"),
				prompt: promptSchema,
				skuKey: imageSkuKeySchema,
				aspectRatio: imageAspectRatioSchema,
				outputFormat: imageOutputFormatSchema.optional(),
				background: imageBackgroundSchema.optional(),
			})
			.strict(),
		upload: draftUploadSchema,
	})
	.strict()
	.superRefine((value, context) => {
		if (isValidImageSelection(value.productKey, value.input)) return;
		context.addIssue({
			code: "custom",
			message: "Invalid image SKU selection",
			path: ["input", "skuKey"],
		});
	});

export const createGenerationDraft = publicProcedure
	.route({ method: "POST", path: "/media/drafts", tags: ["Media"] })
	.input(marketingGenerationDraftInputSchema)
	.handler(async ({ context, input }) => {
		resolveGuestPublicOrigin(context.headers.get("origin"), {
			saasOrigin: process.env.NEXT_PUBLIC_SAAS_URL,
		});
		const subjectHash = createHash("sha256").update(randomUUID()).digest("hex");

		const token = createDraftClaimToken();
		const assetId = `asset_${randomUUID().replaceAll("-", "")}`;
		quoteCatalogInput({
			productKey: input.productKey,
			input: { ...input.input, sourceAssetId: assetId },
		});
		const objectKey = createAssetObjectKey(
			`draft_${randomUUID().replaceAll("-", "")}`,
			assetId,
			input.upload.contentType,
		);
		const uploaded = await putPrivateMediaObject({
			bucket: "media",
			key: objectKey,
			contentType: input.upload.contentType,
			body: Buffer.from(input.upload.base64, "base64"),
		});
		const expiresAt = new Date(Date.now() + 60 * 60_000);
		const uploadedAt = new Date();
		let draft;
		try {
			draft = await createGenerationDraftTransaction(
				{
					claimTokenHash: hashDraftClaimToken(token),
					productKey: input.productKey,
					input: input.input,
					expiresAt,
					abuseLimits: {
						subjectHash,
						maximumGlobalDraftsPerMinute: configuredPositiveInteger(
							process.env.MEDIA_MAX_GLOBAL_ANONYMOUS_DRAFTS_PER_MINUTE,
							100,
						),
					},
					asset: {
						id: assetId,
						objectKey,
						mimeType: input.upload.contentType,
						byteSize: BigInt(uploaded.bytes),
						checksum: uploaded.sha256,
						finalizedAt: uploadedAt,
					},
				},
				db,
			);
		} catch (error) {
			await deleteObject({ bucket: "media", key: objectKey }).catch(() => undefined);
			throw error;
		}
		context.responseHeaders?.set("Cache-Control", "no-store");
		return {
			draftId: draft.id,
			guestReady: false as const,
			expiresAt: draft.expiresAt.toISOString(),
			continueUrl: "/draft/continue",
			claimToken: token,
		};
	});

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
