import { z } from "zod";

import { effectTemplateSchema } from "./effects";

export const FLOOR58_PRIVATE_CONFIG_KEY = "floor58_template_private_key";
export const FLOOR58_LEGACY_MEDIA_KEY = "floor58_legacy_media_private_key";
const mediaUrl = effectTemplateSchema.shape.sceneImageUrl;
const prompt = z.string().trim().min(3).max(7000);

export const floor58TemplateSchema = z
	.object({
		revision: z.string().min(1).max(80),
		enabled: z.boolean(),
		prompts: z.object({ duo: prompt, solo: prompt, "person-pet": prompt }).strict(),
		sceneImageUrl: mediaUrl,
		poseImageUrl: mediaUrl,
		closeupImageUrl: mediaUrl,
		referenceAudioUrl: mediaUrl,
		posterUrl: mediaUrl,
		previewUrl: mediaUrl,
		sourceVideoUrl: mediaUrl,
		referenceFrames: z
			.array(
				z
					.object({
						name: z.string().trim().min(1).max(120),
						timestampSeconds: z.number().finite().nonnegative(),
						url: mediaUrl,
					})
					.strict(),
			)
			.max(60),
		documents: z
			.array(
				z
					.object({
						name: z.string().trim().min(1).max(180),
						content: z.string().max(100_000),
					})
					.strict(),
			)
			.max(16),
	})
	.strict()
	.refine(
		(value) =>
			new Set(value.documents.map((document) => document.name)).size === value.documents.length,
		{
			path: ["documents"],
			message: "Document names must be unique.",
		},
	)
	.refine(
		(value) =>
			![
				value.sceneImageUrl,
				value.poseImageUrl,
				value.closeupImageUrl,
				value.referenceAudioUrl,
			].some((url) => [value.posterUrl, value.previewUrl].includes(url)),
		{
			path: ["posterUrl"],
			message: "Use separate URLs for public examples and generation references.",
		},
	);

export const floor58LegacyMediaSchema = z.record(z.string().max(200), mediaUrl);
export type Floor58Template = z.infer<typeof floor58TemplateSchema>;

export function emptyFloor58Template(): Floor58Template {
	return {
		revision: "unconfigured",
		enabled: false,
		prompts: { duo: "", solo: "", "person-pet": "" },
		sceneImageUrl: "",
		poseImageUrl: "",
		closeupImageUrl: "",
		referenceAudioUrl: "",
		posterUrl: "",
		previewUrl: "",
		sourceVideoUrl: "",
		referenceFrames: [],
		documents: [],
	};
}
