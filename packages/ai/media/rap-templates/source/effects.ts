import { z } from "zod";

import { rapResolutions } from "./rap-catalog";

export const BULIN47_EFFECT_ID = "bulin-47" as const;
export const BULIN47_CREDIT_COST = 10;
export const EFFECT_PRIVATE_CONFIG_KEY = "bulin47_template_private_key";
export const BULIN47_PUBLIC_EXAMPLE = {
	posterUrl: "https://media.ezairapvideo.com/effects/bulin-47/bulin-47.jpg",
	previewUrl: "https://media.ezairapvideo.com/effects/bulin-47/bulin-47.mp4",
	exampleSourceUrl: "",
} as const;
export const EFFECT_PRESETS = ["freestyle"] as const;
export type EffectPreset = (typeof EFFECT_PRESETS)[number];
export type StoredEffectPreset = EffectPreset | "solo-reaction" | "duo-banter";

export const effectRequestSchema = z
	.object({
		id: z.literal(BULIN47_EFFECT_ID),
		preset: z.enum(EFFECT_PRESETS),
		revision: z.string().min(1).max(80),
	})
	.strict();
export type EffectRequest = z.infer<typeof effectRequestSchema>;
// Historical requests remain readable for paid-task recovery and idempotent replay.
export const storedEffectRequestSchema = effectRequestSchema.extend({
	preset: z.enum(["freestyle", "solo-reaction", "duo-banter"]),
});

// Definitions contain no prompt text or generation media. Defaults live in a
// server-only file; this schema is also used by the administrator editor.
const mediaUrl = z
	.url()
	.max(2048)
	.refine((value) => {
		if (!URL.canParse(value)) return false;
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.hash &&
			/\.[a-z]{2,63}$/i.test(url.hostname) &&
			!/\.(?:localhost|local|internal)$/i.test(url.hostname)
		);
	}, "Use an absolute HTTPS media URL.");
export const effectTemplateSchema = z
	.object({
		revision: z.string().min(1).max(80),
		enabled: z.boolean(),
		modelId: z.enum(["seedance-2-mini", "seedance-2"]),
		resolution: z.enum(["480p", "720p", "1080p"]),
		prompt: z.string().trim().min(3).max(7000),
		sceneImageUrl: mediaUrl,
		poseImageUrl: z.union([z.literal(""), mediaUrl]),
		referenceAudioUrl: mediaUrl,
		posterUrl: z.union([z.literal(""), mediaUrl]),
		previewUrl: z.union([z.literal(""), mediaUrl]),
		exampleSourceUrl: z.union([z.literal(""), mediaUrl]),
	})
	.strict()
	.refine((value) => rapResolutions(value.modelId).some((item) => item === value.resolution), {
		path: ["resolution"],
		message: "Resolution is not supported by this model.",
	})
	.refine(
		(value) =>
			![value.sceneImageUrl, value.poseImageUrl, value.referenceAudioUrl].some(
				(url) => url && [value.posterUrl, value.previewUrl, value.exampleSourceUrl].includes(url),
			),
		{
			path: ["posterUrl"],
			message: "Public examples and private generation references must use separate URLs.",
		},
	);
export type EffectTemplate = z.infer<typeof effectTemplateSchema>;

export type PublicEffectTemplate = Pick<
	EffectTemplate,
	| "revision"
	| "enabled"
	| "modelId"
	| "resolution"
	| "posterUrl"
	| "previewUrl"
	| "exampleSourceUrl"
> & {
	id: typeof BULIN47_EFFECT_ID;
	ready: boolean;
	costCredits: number | null;
	duration: 15;
	aspectRatio: "9:16";
};

export function effectPhotoCount(preset: StoredEffectPreset) {
	return preset === "duo-banter" ? 2 : 1;
}
