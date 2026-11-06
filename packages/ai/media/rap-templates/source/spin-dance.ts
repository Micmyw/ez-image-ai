import { z } from "zod";

import {
	RAP_DURATIONS,
	RAP_MODEL_IDS,
	RAP_RESOLUTIONS,
	rapModel,
	validRapSettings,
	type RapModelId,
	type RapSaleResolution,
} from "./rap-catalog";

export const SPIN_DANCE_ID = "spin-me-round-dance-ai" as const;
export const SPIN_DANCE_REVISION = "spin-v3-flexible-settings";
// Published with the account owner's permission; independent of their library copy.
export const SPIN_DANCE_EXAMPLE = {
	video: "https://media.ezairapvideo.com/effects/spin-me-round/trio-15s-v1.mp4",
	poster: "/effects/spin-me-round/trio-15s-v1.webp",
} as const;
export const SPIN_DANCE_SCENE_IDS = ["empty-room", "retro-neon"] as const;
export type SpinDanceScene = (typeof SPIN_DANCE_SCENE_IDS)[number];
export const SPIN_DANCE_SCENE_IMAGES: Record<SpinDanceScene, string> = {
	"empty-room": "/effects/spin-me-round/scene-v1.png",
	"retro-neon": "/effects/spin-me-round/retro-neon-v1.png",
};
export const SPIN_DANCE_SCENE = SPIN_DANCE_SCENE_IMAGES["empty-room"];
// Web previews are separate from the full-resolution provider references.
export const SPIN_DANCE_SCENE_PREVIEWS: Record<SpinDanceScene, string> = {
	"empty-room": "/effects/spin-me-round/scene-v1-preview.webp",
	"retro-neon": "/effects/spin-me-round/retro-neon-v1-preview.webp",
};
export const SPIN_DANCE_SCENE_THUMBNAILS: Record<SpinDanceScene, string> = {
	"empty-room": "/effects/spin-me-round/scene-v1-thumb.webp",
	"retro-neon": "/effects/spin-me-round/retro-neon-v1-thumb.webp",
};
export const SPIN_DANCE_PRESETS = ["solo", "duo", "trio"] as const;
export type SpinDancePreset = (typeof SPIN_DANCE_PRESETS)[number];
export const SPIN_DANCE_COUNTS = { solo: 1, duo: 2, trio: 3 } as const;

export type SpinDanceSettings = {
	modelId: RapModelId;
	resolution: RapSaleResolution;
	aspectRatio: "9:16" | "16:9" | "1:1" | "adaptive";
	duration: (typeof RAP_DURATIONS)[number];
};

export function spinDanceSettings(preset: SpinDancePreset): SpinDanceSettings {
	return {
		modelId: "seedance-2-mini" as const,
		resolution: "720p" as const,
		aspectRatio: "9:16" as const,
		duration: preset === "trio" ? (15 as const) : (12 as const),
	};
}

export function spinDanceQuote(preset: SpinDancePreset, settings = spinDanceSettings(preset)) {
	if (!validRapSettings({ ...settings, mode: "image" })) return null;
	return rapModel(settings.modelId).prices[settings.resolution]![
		RAP_DURATIONS.indexOf(settings.duration)
	];
}

const portraitUrl = z
	.url()
	.max(2048)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});

// A separate strict input keeps ordinary Rap and historical Bulin requests intact.
export const spinDanceRequestSchema = z
	.object({
		templateId: z.literal(SPIN_DANCE_ID),
		preset: z.enum(SPIN_DANCE_PRESETS),
		// Do not materialize a default: paid requests without this field must
		// preserve their serialized hash for idempotent recovery.
		sceneId: z.enum(SPIN_DANCE_SCENE_IDS).optional(),
		revision: z.string().min(1).max(80),
		modelId: z.enum(RAP_MODEL_IDS),
		resolution: z.enum(RAP_RESOLUTIONS),
		aspectRatio: z.enum(["9:16", "16:9", "1:1", "adaptive"]),
		duration: z.union([z.literal(5), z.literal(8), z.literal(10), z.literal(12), z.literal(15)]),
		imageUrl: portraitUrl,
		secondImageUrl: portraitUrl.optional(),
		thirdImageUrl: portraitUrl.optional(),
		expectedCredits: z.number().int().positive().max(1_000_000),
		idempotencyKey: z.uuid(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const images = [value.imageUrl, value.secondImageUrl, value.thirdImageUrl].filter(Boolean);
		const count = SPIN_DANCE_COUNTS[value.preset];
		if (
			images.length !== count ||
			(count >= 2 && !value.secondImageUrl) ||
			(count === 3 && !value.thirdImageUrl) ||
			new Set(images).size !== count ||
			!validRapSettings({ ...value, mode: "image" })
		) {
			ctx.addIssue({
				code: "custom",
				path: ["preset"],
				message: "Invalid dance photo count or model settings.",
			});
		}
	});
export type SpinDanceInput = z.infer<typeof spinDanceRequestSchema>;
export type SpinDanceDraft = Pick<
	SpinDanceInput,
	"templateId" | "preset" | "revision" | "sceneId"
> &
	SpinDanceSettings & { photos: File[] };
export type SpinDanceConfig = {
	ready: boolean;
	revision: string;
	modelId: RapModelId;
	resolution: RapSaleResolution;
	aspectRatio: SpinDanceSettings["aspectRatio"];
	modes: {
		preset: SpinDancePreset;
		photoCount: number;
		duration: SpinDanceSettings["duration"];
		costCredits: number;
	}[];
};
