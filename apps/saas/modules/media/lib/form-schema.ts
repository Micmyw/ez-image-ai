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
	productKey: z.enum(["image-fast", "image-quality", "video-fast", "video-quality"]),
	prompt: z.string().trim().min(1).max(10_000),
	aspectRatio: z.enum(["1:1", "4:3", "3:4"]),
	durationSeconds: z.number().int().min(1).max(30),
	sourceAssetId: z.string().optional(),
});

export type GenerationFormValues = z.infer<typeof generationFormValuesSchema>;

const inputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("text-to-image"),
		prompt: z.string().trim().min(1).max(10_000),
		width: z.number().int().min(256).max(2048).optional(),
		height: z.number().int().min(256).max(2048).optional(),
	}),
	z.object({
		kind: z.literal("image-to-image"),
		prompt: z.string().trim().min(1).max(10_000),
		sourceAssetId: z.string().min(1),
		strength: z.number().min(0).max(1).optional(),
	}),
	z.object({
		kind: z.literal("text-to-video"),
		prompt: z.string().trim().min(1).max(10_000),
		durationSeconds: z.number().int().min(1).max(30).optional(),
	}),
	z.object({
		kind: z.literal("image-to-video"),
		prompt: z.string().trim().min(1).max(10_000),
		sourceAssetId: z.string().min(1),
		durationSeconds: z.number().int().min(1).max(30).optional(),
	}),
]);

export type GenerationInput = z.infer<typeof inputSchema>;

export function buildGenerationInput(value: unknown): GenerationInput {
	const publicValue = value as Record<string, unknown>;
	const dimensions = imageDimensions(publicValue.aspectRatio);
	return inputSchema.parse({
		...publicValue,
		...(publicValue.kind === "text-to-image" ? dimensions : {}),
	});
}

function imageDimensions(value: unknown): { width: number; height: number } {
	switch (value) {
		case "4:3":
			return { width: 1024, height: 768 };
		case "3:4":
			return { width: 768, height: 1024 };
		default:
			return { width: 1024, height: 1024 };
	}
}
