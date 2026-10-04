import { z } from "zod";

import { getVideoModel, type VideoMode } from "./video-models";

type VideoAccessOption = {
	productKey: string;
	mode: VideoMode;
	duration: number;
	resolution: string;
	sound: boolean;
};
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const groupSchema = z
	.object({
		productKey: z.string().min(1).max(100),
		modes: z
			.array(z.enum(["text-to-video", "image-to-video"]))
			.min(1)
			.max(2)
			.refine(unique),
		durations: z.array(z.number().int().min(2).max(30)).min(1).max(29).refine(unique),
		resolutions: z.array(z.string().min(1).max(20)).min(1).max(8).refine(unique),
		sounds: z.array(z.boolean()).min(1).max(2).refine(unique),
	})
	.strict();
const groupsSchema = z.array(groupSchema).min(1).max(64);
export type VideoModelAccess = {
	ready: boolean;
	reason: "VIDEO_MODEL_OPTIONS_NOT_CONFIGURED" | "VIDEO_MODEL_OPTIONS_INVALID" | null;
	allowed: ReadonlySet<string>;
};
function optionKey(option: VideoAccessOption): string {
	return JSON.stringify([
		option.productKey,
		option.mode,
		option.duration,
		option.resolution,
		option.sound,
	]);
}

/** Server-owned rollout allowlist. Existing accepted jobs never re-read this admission gate. */
export function readVideoModelAccess(
	environment: Record<string, string | undefined>,
): VideoModelAccess {
	const encoded = environment.VIDEO_MODEL_ALLOWED_OPTIONS;
	if (!encoded)
		return { ready: false, reason: "VIDEO_MODEL_OPTIONS_NOT_CONFIGURED", allowed: new Set() };
	const invalid: VideoModelAccess = {
		ready: false,
		reason: "VIDEO_MODEL_OPTIONS_INVALID",
		allowed: new Set(),
	};
	if (encoded.length > 16_000) return invalid;
	try {
		const groups = groupsSchema.safeParse(JSON.parse(encoded));
		if (!groups.success) return invalid;
		const allowed = new Set<string>();
		for (const group of groups.data) {
			const model = getVideoModel(group.productKey);
			if (!model || model.status !== "implemented") return invalid;
			for (const mode of group.modes)
				for (const duration of group.durations)
					for (const resolution of group.resolutions)
						for (const sound of group.sounds) {
							if (
								!model.groups.some(
									(capability) =>
										capability.mode === mode &&
										capability.durations.includes(duration) &&
										capability.resolutions.includes(resolution) &&
										capability.sounds.includes(sound),
								)
							)
								return invalid;
							const key = optionKey({
								productKey: group.productKey,
								mode,
								duration,
								resolution,
								sound,
							});
							if (allowed.has(key)) return invalid;
							allowed.add(key);
						}
		}
		return { ready: true, reason: null, allowed };
	} catch {
		return invalid;
	}
}

export function isVideoModelOptionAllowed(
	access: VideoModelAccess,
	option: VideoAccessOption,
): boolean {
	return access.ready && access.allowed.has(optionKey(option));
}
