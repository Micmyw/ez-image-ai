import {
	EZPIC_PRODUCT_KEYS,
	IMAGE_ASPECT_RATIOS,
	IMAGE_BACKGROUNDS,
	IMAGE_OUTPUT_FORMATS,
	imageSkuKeySchema,
	imageGifFrameCountSchema,
	imageGifFrameDurationMsSchema,
} from "@repo/config/client";
import { z } from "zod";

export const generationFieldSchema = z.object({
	type: z.enum(["text", "select", "slider", "aspect-ratio", "count", "image-asset", "video-asset"]),
	key: z.string().min(1),
	label: z.string().min(1),
	options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	step: z.number().positive().optional(),
	required: z.boolean().optional(),
});

export const generationFormValuesSchema = z.object({
	productKey: z.enum(EZPIC_PRODUCT_KEYS),
	skuKey: imageSkuKeySchema,
	prompt: z.string().trim().min(1).max(10_000),
	sourceAssetId: z.string(),
	aspectRatio: z.enum(IMAGE_ASPECT_RATIOS),
	outputFormat: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
	background: z.enum(IMAGE_BACKGROUNDS).optional(),
	frameCount: imageGifFrameCountSchema.optional(),
	frameDurationMs: imageGifFrameDurationMsSchema.optional(),
});

export type GenerationFormValues = z.infer<typeof generationFormValuesSchema>;

const editInputSchema = z
	.object({
		kind: z.literal("image-to-image"),
		prompt: z.string().trim().min(1).max(10_000),
		sourceAssetId: z.string().min(1),
		skuKey: imageSkuKeySchema,
		aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default("auto"),
		outputFormat: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
		background: z.enum(IMAGE_BACKGROUNDS).optional(),
		frameCount: imageGifFrameCountSchema.optional(),
		frameDurationMs: imageGifFrameDurationMsSchema.optional(),
		strength: z.number().min(0).max(1).optional(),
	})
	.strict();

const textInputSchema = editInputSchema
	.omit({ sourceAssetId: true, strength: true })
	.extend({ kind: z.literal("text-to-image") })
	.strict();
const inputSchema = z
	.discriminatedUnion("kind", [editInputSchema, textInputSchema])
	.superRefine((input, context) => {
		if (
			input.outputFormat !== "gif" &&
			(input.frameCount !== undefined || input.frameDurationMs !== undefined)
		)
			context.addIssue({
				code: "custom",
				path: ["outputFormat"],
				message: "GIF settings require GIF output",
			});
		if (input.outputFormat === "gif" && input.aspectRatio !== "1:1")
			context.addIssue({
				code: "custom",
				path: ["aspectRatio"],
				message: "GIF frames use a square canvas",
			});
	});

export type GenerationInput = z.infer<typeof inputSchema>;

export function buildGenerationInput(value: unknown): GenerationInput {
	return inputSchema.parse(value);
}
