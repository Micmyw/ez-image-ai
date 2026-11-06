import { z } from "zod";

import type { EffectRequest } from "./effects";
import { RAP_MODEL_IDS, validRapSettings } from "./rap-catalog";
import { rapCompositionSchema, type RapComposition } from "./rap-composition";

export { RAP_MODEL_IDS, RAP_RESOLUTIONS, RAP_DURATIONS } from "./rap-catalog";

export const RAP_MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const RAP_MAX_PHOTOS = 2;
export const RAP_MAX_CREATIVE_INPUT_LENGTH = 2000;
export const RAP_MAX_DIRECTION_LENGTH = 20_000;
export const RAP_INPUT_MODES = ["text", "image"] as const;
export const RAP_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export const RAP_DURATION = { min: 5, max: 15, default: 12 } as const;
export const RAP_PERFORMANCE_STYLES = ["studio", "street", "cinematic"] as const;

export type RapInputMode = (typeof RAP_INPUT_MODES)[number];
export type RapAspectRatio = (typeof RAP_ASPECT_RATIOS)[number];
export type RapPerformanceStyle = (typeof RAP_PERFORMANCE_STYLES)[number];
export type RapFile = Pick<File, "name" | "type" | "size">;

// This shape also decodes already-paid jobs, including legacy 4K/durations.
// New jobs must additionally pass validRapSettings.
export const rapStoredSettingsSchema = z.object({
	mode: z.enum(RAP_INPUT_MODES),
	modelId: z.enum(RAP_MODEL_IDS),
	aspectRatio: z.enum([...RAP_ASPECT_RATIOS, "adaptive"]),
	duration: z.number().int().min(4).max(15),
	resolution: z.enum(["480p", "720p", "1080p", "4k"]),
	performanceStyle: z.enum(RAP_PERFORMANCE_STYLES),
});
export const rapSettingsSchema = rapStoredSettingsSchema.refine(validRapSettings, {
	message: "Unsupported model settings",
});

export type RapDraft = z.infer<typeof rapSettingsSchema> & {
	photos: File[];
	direction: string;
	promptVersion?: 1;
	composition?: RapComposition;
	effect?: EffectRequest;
};

export const RAP_DEFAULT_DRAFT: RapDraft = {
	mode: "text",
	modelId: "seedance-2-mini",
	photos: [],
	direction: "",
	aspectRatio: "9:16",
	duration: RAP_DURATION.default,
	resolution: "720p",
	performanceStyle: "studio",
};

export type RapDraftError =
	| "photoRequired"
	| "photoType"
	| "photoSize"
	| "photoCount"
	| "photoDecode"
	| "photoDimensions"
	| "directionRequired"
	| "directionLength"
	| "settingsInvalid";
export type RapDraftErrors = Partial<Record<"photo" | "direction" | "settings", RapDraftError>>;

const photoMimeTypes: Record<string, readonly string[]> = {
	jpg: ["image/jpeg"],
	jpeg: ["image/jpeg"],
	png: ["image/png"],
	webp: ["image/webp"],
};

export function validateRapPhoto(file: RapFile | null): RapDraftError | null {
	if (!file) return "photoRequired";
	const extension = file.name.match(/\.([^.]+)$/)?.[1].toLowerCase();
	const types = extension ? photoMimeTypes[extension] : undefined;
	if (
		!types ||
		(file.type &&
			file.type !== "application/octet-stream" &&
			!types.includes(file.type.toLowerCase()))
	)
		return "photoType";
	if (!Number.isFinite(file.size) || file.size <= 0 || file.size > RAP_MAX_PHOTO_BYTES)
		return "photoSize";
	return null;
}

export function validateRapDraft(
	draft: Omit<RapDraft, "photos"> & { photos: RapFile[] },
): RapDraftErrors {
	const errors: RapDraftErrors = {};
	if (!rapSettingsSchema.safeParse(draft).success) errors.settings = "settingsInvalid";
	if (draft.mode === "image") {
		const photoError = !draft.photos.length
			? "photoRequired"
			: draft.photos.length > RAP_MAX_PHOTOS
				? "photoCount"
				: draft.photos.map(validateRapPhoto).find(Boolean);
		if (photoError) errors.photo = photoError;
	}
	if (draft.composition && !rapCompositionSchema.safeParse(draft.composition).success)
		errors.settings = "settingsInvalid";
	if (!draft.composition && !draft.effect && draft.direction.trim().length < 3)
		errors.direction = "directionRequired";
	else if (draft.composition && draft.direction.length > RAP_MAX_CREATIVE_INPUT_LENGTH)
		errors.direction = "directionLength";
	else if (draft.direction.length > RAP_MAX_DIRECTION_LENGTH) errors.direction = "directionLength";
	return errors;
}

/** A portable creative brief. Never contains media bytes or provider requests. */
export function createRapProject(draft: RapDraft, now = new Date()) {
	if (Object.keys(validateRapDraft(draft)).length) throw new Error("RAP_INVALID_PROJECT");
	const settings = rapSettingsSchema.parse(draft);
	return {
		version: 3,
		kind: "rap-video-project",
		createdAt: now.toISOString(),
		...settings,
		direction: draft.direction.trim(),
		...(draft.promptVersion ? { promptVersion: draft.promptVersion } : {}),
		...(draft.composition ? { composition: rapCompositionSchema.parse(draft.composition) } : {}),
		photos:
			draft.mode === "image"
				? draft.photos.map(({ name, type, size }) => ({ name, type, size }))
				: [],
	};
}
