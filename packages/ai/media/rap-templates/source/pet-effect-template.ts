import { z } from "zod";

import { emptyGreenBoothTemplate, greenBoothTemplateSchema } from "./green-booth-template";

export const PET_EFFECT_TEMPLATE_KEYS = {
	"kung-fu-cat-ai": "kung_fu_cat_template_private_key",
	"paws-at-you-ai": "paws_at_you_template_private_key",
} as const;
export type PetEffectId = keyof typeof PET_EFFECT_TEMPLATE_KEYS;
export function isPetEffectId(id: unknown): id is PetEffectId {
	return (
		typeof id === "string" && Object.prototype.hasOwnProperty.call(PET_EFFECT_TEMPLATE_KEYS, id)
	);
}

// Same stored-media/editor contract as Green Booth, with two internal images.
export const petEffectTemplateSchema = z
	.object({
		...greenBoothTemplateSchema.shape,
		endPoseImageUrl: z.literal(""),
	})
	.strict()
	.superRefine((value, ctx) => {
		const internal = [value.sceneImageUrl, value.poseImageUrl, value.referenceAudioUrl];
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
		if (value.enabled && !value.assetsVerified) {
			ctx.addIssue({
				code: "custom",
				path: ["assetsVerified"],
				message: "Verify assets before enabling generation.",
			});
		}
		if (new Set(value.documents.map((document) => document.name)).size !== value.documents.length) {
			ctx.addIssue({
				code: "custom",
				path: ["documents"],
				message: "Document names must be unique.",
			});
		}
		if (value.additionalExamples?.some((example) => example.aspectRatio !== "9:16")) {
			ctx.addIssue({
				code: "custom",
				path: ["additionalExamples"],
				message: "Pet examples must be vertical.",
			});
		}
	});

export type PetEffectTemplate = z.infer<typeof petEffectTemplateSchema>;
export function emptyPetEffectTemplate(id: PetEffectId): PetEffectTemplate {
	return {
		...emptyGreenBoothTemplate(),
		revision: id === "kung-fu-cat-ai" ? "kung-fu-cat-h3-v2" : "paws-at-you-h3-v2",
		endPoseImageUrl: "",
		exampleDurationSeconds: id === "kung-fu-cat-ai" ? 9 : 6,
	};
}
