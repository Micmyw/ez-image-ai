import { z } from "zod";

export const promptSchema = z.string().trim().min(1).max(10_000);
export const mediaAssetIdSchema = z.string().regex(/^asset_[A-Za-z0-9_-]{16,64}$/);

export const mediaModelInputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("text-to-image"),
		prompt: promptSchema,
		width: z.number().int().min(256).max(2048).optional(),
		height: z.number().int().min(256).max(2048).optional(),
	}),
	z.object({
		kind: z.literal("image-to-image"),
		prompt: promptSchema,
		sourceAssetId: mediaAssetIdSchema,
		strength: z.number().min(0).max(1).optional(),
	}),
	z.object({
		kind: z.literal("text-to-video"),
		prompt: promptSchema,
		durationSeconds: z.number().int().min(1).max(30).optional(),
	}),
	z.object({
		kind: z.literal("image-to-video"),
		prompt: promptSchema,
		sourceAssetId: mediaAssetIdSchema,
		durationSeconds: z.number().int().min(1).max(30).optional(),
	}),
]);

export type MediaModelInput = z.infer<typeof mediaModelInputSchema>;
