import { z } from "zod";

// Public creative choices. The actual prompt templates live on the server.
export const rapCompositionSchema = z
	.object({
		stageId: z.enum(["orange-studio", "street-cypher", "neon-rap", "funny-rap"]),
		customStage: z.string().trim().max(2000).optional(),
		occasion: z.string().trim().max(500).optional(),
		locale: z.enum(["en", "zh"]),
	})
	.strict();

export type RapComposition = z.infer<typeof rapCompositionSchema>;

export const rapPromptRequestSchema = z
	.object({
		composition: rapCompositionSchema,
		direction: z.string().trim().max(2000),
		duration: z.union([z.literal(5), z.literal(8), z.literal(10), z.literal(12), z.literal(15)]),
		aspectRatio: z.enum(["9:16", "16:9", "1:1", "adaptive"]),
		photoCount: z.number().int().min(0).max(2),
	})
	.strict();

export type RapPromptRequest = z.infer<typeof rapPromptRequestSchema>;

export function rapSongKind(
	draft: { direction: string; duration: number },
	options: { occasion?: string; customStage?: string },
) {
	return draft.direction.trim()
		? "customer"
		: draft.duration === 12 && !options.occasion?.trim() && !options.customStage?.trim()
			? "preset"
			: "freestyle";
}
