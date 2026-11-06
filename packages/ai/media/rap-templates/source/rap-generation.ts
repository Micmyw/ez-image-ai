import { z } from "zod";

import {
	BULIN47_CREDIT_COST,
	BULIN47_EFFECT_ID,
	effectPhotoCount,
	effectRequestSchema,
	storedEffectRequestSchema,
	type StoredEffectPreset,
} from "./effects";
import type { FLOOR58_ID, Floor58Mode } from "./fifty-eighth-floor";
import { HOTEL_LOBBY_ID, type HotelLobbyResolution } from "./hotel-lobby";
import {
	RAP_DURATIONS,
	validRapSettings,
	type RapModel,
	type RapModelId,
	type RapSaleResolution,
} from "./rap-catalog";
import { rapCompositionSchema } from "./rap-composition";
import { RAP_MAX_DIRECTION_LENGTH, rapStoredSettingsSchema } from "./rap-draft";
import type { ShortEffectId } from "./short-effects";
import type { SPIN_DANCE_ID, SpinDancePreset } from "./spin-dance";

export const RAP_GENERATION_SCENE = "rap_seedance_generation";
export type RapResolution = RapSaleResolution | "4k";

export const rapStoredGenerationSchema = rapStoredSettingsSchema
	.extend({
		idempotencyKey: z.uuid(),
		direction: z.string().trim().max(RAP_MAX_DIRECTION_LENGTH),
		imageUrl: z.url().max(2048).optional(),
		// Optional so historical single-image request serialization stays unchanged.
		secondImageUrl: z.url().max(2048).optional(),
		expectedCredits: z.number().int().positive().max(1_000_000),
		promptVersion: z.literal(1).optional(),
		composition: rapCompositionSchema.optional(),
		effect: storedEffectRequestSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			(!value.composition && !value.effect && value.direction.length < 3) ||
			(value.composition && (value.direction.length > 2000 || value.promptVersion))
		)
			ctx.addIssue({
				code: "custom",
				path: ["direction"],
				message: "Invalid creative brief.",
			});
		if (
			value.effect &&
			(value.direction !== "" ||
				value.composition ||
				value.promptVersion ||
				value.mode !== "image" ||
				value.duration !== 15 ||
				value.aspectRatio !== "9:16" ||
				(value.secondImageUrl ? 2 : 1) !== effectPhotoCount(value.effect.preset) ||
				(value.secondImageUrl && value.secondImageUrl === value.imageUrl))
		)
			ctx.addIssue({
				code: "custom",
				path: ["effect"],
				message: "Invalid effect input.",
			});
		if (
			(value.mode === "image") !== Boolean(value.imageUrl) ||
			(value.mode === "text" && value.secondImageUrl)
		)
			ctx.addIssue({
				code: "custom",
				path: ["imageUrl"],
				message: "Image mode requires an owned, approved image; text mode accepts no image.",
			});
	});
export const rapGenerationSchema = rapStoredGenerationSchema
	.refine(validRapSettings, {
		message: "Unsupported model settings",
	})
	.refine((value) => !value.effect || effectRequestSchema.safeParse(value.effect).success, {
		path: ["effect"],
		message: "This effect preset is no longer available for new tasks.",
	});
export type RapGenerationInput = z.infer<typeof rapGenerationSchema>;

export function rapImageUrls(
	input: Pick<RapGenerationInput, "imageUrl" | "secondImageUrl"> & {
		thirdImageUrl?: string;
	},
) {
	return [input.imageUrl, input.secondImageUrl, input.thirdImageUrl].filter((url): url is string =>
		Boolean(url),
	);
}
export type RapGenerationConfig = {
	ready: boolean;
	imageReady: boolean;
	pricingVersion: string;
	models: readonly RapModel[];
};
export type RapGenerationTask = {
	id: string;
	modelId: RapModelId | typeof HOTEL_LOBBY_ID | typeof FLOOR58_ID | ShortEffectId;
	status: "pending" | "processing" | "success" | "failed" | "canceled";
	phase: "reviewing" | "submitting" | "generating" | "complete";
	costCredits: number;
	duration: number | null;
	resolution: RapResolution | HotelLobbyResolution;
	aspectRatio: string;
	createdAt: string;
	files: string[];
	/** Approved user references, returned only by owner-scoped task endpoints. */
	referenceImages?: string[];
	sceneId?: "empty-room" | "retro-neon";
	storageStatus?: "pending" | "saved";
	errorCode?: string;
	recoverable: boolean;
	effectId?:
		| "bulin-47"
		| typeof HOTEL_LOBBY_ID
		| typeof SPIN_DANCE_ID
		| typeof FLOOR58_ID
		| ShortEffectId;
	effectPreset?: StoredEffectPreset | SpinDancePreset | Floor58Mode | "pet";
};

/** Finished generation can still need polling until its preview is saved. */
export function rapTaskNeedsRefresh(task?: RapGenerationTask): boolean {
	return Boolean(
		task &&
		(["pending", "processing"].includes(task.status) ||
			(task.status === "success" && task.storageStatus === "pending")),
	);
}

export function rapCreditQuote(
	config: RapGenerationConfig | undefined,
	modelId: RapModelId,
	resolution: RapResolution,
	duration: number,
	effectId?: typeof BULIN47_EFFECT_ID,
) {
	const index = RAP_DURATIONS.findIndex((value) => value === duration);
	if (index < 0 || resolution === "4k") return null;
	const modelQuote =
		config?.models.find((model) => model.id === modelId)?.prices[resolution]?.[index] ?? null;
	if (modelQuote === null || (effectId && duration !== 15)) return null;
	// The fixed template has its own consumer price; ordinary Rap keeps its catalog.
	return effectId === BULIN47_EFFECT_ID ? BULIN47_CREDIT_COST : modelQuote;
}

export function seedanceImageDimensions(width: number, height: number) {
	// Provider-ready first frame; user uploads are automatically fitted to this range.
	return (
		width > 300 &&
		height > 300 &&
		width < 6000 &&
		height < 6000 &&
		width / height > 0.4 &&
		width / height < 2.5
	);
}
