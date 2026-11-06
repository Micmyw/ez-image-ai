import { z } from "zod";

import { floor58TemplateSchema } from "./floor58-template";

export const GREEN_BOOTH_PRIVATE_CONFIG_KEY = "green_booth_template_private_key";
export const GREEN_BOOTH_ENABLED_KEY = "short_green_booth_enabled";
const common = floor58TemplateSchema.shape;

export const referenceExampleSchema = z
	.object({
		label: z.string().trim().min(1).max(100),
		video: common.previewUrl,
		poster: common.posterUrl,
		durationSeconds: z.number().finite().positive().max(60),
		aspectRatio: z.enum(["9:16", "16:9"]),
		kind: z.enum(["provided", "generated"]),
	})
	.strict();

export const greenBoothTemplateSchema = z
	.object({
		revision: common.revision,
		enabled: z.boolean(),
		assetsVerified: z.boolean(),
		prompt: z.string().trim().min(1).max(7000),
		sceneImageUrl: common.sceneImageUrl,
		poseImageUrl: common.poseImageUrl,
		endPoseImageUrl: common.poseImageUrl,
		referenceAudioUrl: common.referenceAudioUrl,
		previewUrl: common.previewUrl,
		posterUrl: common.posterUrl,
		sourceVideoUrl: common.sourceVideoUrl,
		exampleDurationSeconds: z.number().finite().positive().max(60),
		exampleKind: z.enum(["provided", "generated"]),
		additionalExamples: z.array(referenceExampleSchema).max(3).optional(),
		rightsManifest: z.string().trim().min(1).max(20000),
		referenceFrames: common.referenceFrames,
		documents: common.documents,
	})
	.strict()
	.superRefine((value, ctx) => {
		const internal = [
			value.sceneImageUrl,
			value.poseImageUrl,
			value.endPoseImageUrl,
			value.referenceAudioUrl,
		];
		const published = [
			value.previewUrl,
			value.posterUrl,
			...(value.additionalExamples ?? []).flatMap((example) => [example.video, example.poster]),
		];
		if (
			new Set(internal).size !== internal.length ||
			internal.some((url) => published.includes(url))
		) {
			ctx.addIssue({
				code: "custom",
				path: ["sceneImageUrl"],
				message: "Keep distinct generation references and public examples.",
			});
		}
		if (new Set(value.documents.map((document) => document.name)).size !== value.documents.length) {
			ctx.addIssue({
				code: "custom",
				path: ["documents"],
				message: "Document names must be unique.",
			});
		}
		if (value.enabled && !value.assetsVerified) {
			ctx.addIssue({
				code: "custom",
				path: ["assetsVerified"],
				message: "Verify assets before enabling generation.",
			});
		}
	});

export type GreenBoothTemplate = z.infer<typeof greenBoothTemplateSchema>;

export function emptyGreenBoothTemplate(): GreenBoothTemplate {
	return {
		revision: "green-booth-h3-v3",
		enabled: false,
		assetsVerified: false,
		prompt: "",
		sceneImageUrl: "",
		poseImageUrl: "",
		endPoseImageUrl: "",
		referenceAudioUrl: "",
		previewUrl: "",
		posterUrl: "",
		sourceVideoUrl: "",
		exampleDurationSeconds: 10,
		exampleKind: "provided",
		rightsManifest: "",
		referenceFrames: [],
		documents: [],
	};
}
