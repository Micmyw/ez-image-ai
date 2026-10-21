import { EZPIC_PRODUCT_KEYS } from "@repo/config/client";
import { getVideoModel } from "@repo/config/video-models";
import { z } from "zod";

export const generationDiagnosticsSchema = z
	.object({
		mediaKind: z.enum(["image", "video"]),
		phase: z.enum([
			"editing",
			"uploading",
			"ready",
			"quote",
			"confirm",
			"submitted",
			"succeeded",
			"failed",
			"held",
			"blocked",
			"download",
		]),
		publicModel: z
			.string()
			.max(64)
			.refine(
				(key) => (EZPIC_PRODUCT_KEYS as readonly string[]).includes(key) || !!getVideoModel(key),
			)
			.optional(),
		textLength: z.enum(["empty", "1-50", "51-200", "201-1000", "1001-plus"]).optional(),
		inputCount: z.number().int().min(0).max(9).optional(),
		aspectRatio: z
			.enum([
				"auto",
				"1:1",
				"16:9",
				"9:16",
				"4:3",
				"3:4",
				"3:2",
				"2:3",
				"21:9",
				"2:1",
				"1:2",
				"4:5",
				"5:4",
			])
			.optional(),
		resolution: z
			.enum(["default", "480p", "720p", "1080p", "2k", "4k", "1K", "2K", "4K"])
			.optional(),
		duration: z.number().int().min(1).max(30).optional(),
		sound: z.boolean().optional(),
		reason: z
			.enum([
				"input_required",
				"policy_rejected",
				"insufficient_credits",
				"capacity",
				"unavailable",
				"network",
				"unknown",
			])
			.optional(),
	})
	.strict();
export type GenerationDiagnostics = z.infer<typeof generationDiagnosticsSchema>;

export function textLengthBucket(length: number): GenerationDiagnostics["textLength"] {
	return length <= 0
		? "empty"
		: length <= 50
			? "1-50"
			: length <= 200
				? "51-200"
				: length <= 1000
					? "201-1000"
					: "1001-plus";
}

/** Maps application error keys only; never accepts an exception or provider message. */
export function generationErrorCategory(key: string): NonNullable<GenerationDiagnostics["reason"]> {
	if (/prompt|imageRequired|invalidImage|imageTooLarge/i.test(key)) return "input_required";
	if (/content|safety|moderation/i.test(key)) return "policy_rejected";
	if (/insufficient/i.test(key)) return "insufficient_credits";
	if (/busy|limit/i.test(key)) return "capacity";
	if (/network|upload/i.test(key)) return "network";
	if (/unavailable|disabled|unauthorized|unsupported/i.test(key)) return "unavailable";
	return "unknown";
}
