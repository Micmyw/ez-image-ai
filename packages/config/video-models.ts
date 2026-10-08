import { z } from "zod";

/** Public capabilities only. Provider routes, costs and account readiness are server-owned. */
export const VIDEO_MODEL_CATALOG_VERSION = "video-models-2026-10-08.1";
/** Frozen consumer contract: independent of future active catalog revisions. */
export const VIDEO_VEO_TIER_CONTRACT_VERSION = "video-models-2026-10-08.1";
export const videoVeoTierSchema = z.enum(["lite", "fast", "quality"]);
export type VideoVeoTier = z.infer<typeof videoVeoTierSchema>;
export type VideoMode = "text-to-video" | "image-to-video";
export type VideoModelOption = {
	duration: number;
	resolution: string;
	aspectRatio: string;
	sound: boolean;
	veoTier?: VideoVeoTier;
};
export type VideoModelSelection = VideoModelOption & { productKey: string; mode: VideoMode };
export type VideoModelVariant = {
	id: string;
	label: string;
	selection: { productKey: string; resolution?: string; veoTier?: VideoVeoTier };
};
/** Named supplier variants only. Resolution-backed Kling modes stay coupled. */
export const VIDEO_MODEL_VARIANT_GROUPS: readonly {
	id: string;
	productKey: string;
	label: string;
	variants: readonly VideoModelVariant[];
}[] = [
	{
		id: "veo31",
		productKey: "video-veo-3-1",
		label: "Veo 3.1",
		variants: [
			{ id: "lite", label: "Lite", selection: { productKey: "video-veo-3-1", veoTier: "lite" } },
			{ id: "fast", label: "Fast", selection: { productKey: "video-veo-3-1", veoTier: "fast" } },
			{
				id: "quality",
				label: "Quality",
				selection: { productKey: "video-veo-3-1", veoTier: "quality" },
			},
		],
	},
	{
		id: "seedance2",
		productKey: "video-seedance-2",
		label: "Seedance 2",
		variants: [
			{ id: "mini", label: "Mini", selection: { productKey: "video-seedance-2-mini" } },
			{ id: "fast", label: "Fast", selection: { productKey: "video-seedance-2-fast" } },
			{ id: "standard", label: "Seedance 2", selection: { productKey: "video-seedance-2" } },
		],
	},
	{
		id: "kling3",
		productKey: "video-kling-3",
		label: "Kling 3",
		variants: [
			{
				id: "standard",
				label: "Standard",
				selection: { productKey: "video-kling-3", resolution: "720p" },
			},
			{ id: "pro", label: "Pro", selection: { productKey: "video-kling-3", resolution: "1080p" } },
			{ id: "4k", label: "4K", selection: { productKey: "video-kling-3", resolution: "4k" } },
			{ id: "turbo", label: "Turbo", selection: { productKey: "video-kling-3-turbo" } },
		],
	},
];
export function getVideoVariantGroup(productKey: string) {
	return VIDEO_MODEL_VARIANT_GROUPS.find((group) =>
		group.variants.some((variant) => variant.selection.productKey === productKey),
	);
}
export type VideoModelCapabilityGroup = {
	mode: VideoMode;
	durations: readonly number[];
	resolutions: readonly string[];
	aspectRatios: readonly string[];
	sounds: readonly boolean[];
	veoTiers?: readonly VideoVeoTier[];
};
export type VideoModelDefinition = {
	productKey: string;
	label: string;
	family: "MiniMax" | "Seedance" | "Gemini" | "Kling" | "Veo";
	status: "implemented" | "blocked";
	blockedReason?: string;
	modes: readonly VideoMode[];
	/** provider-native allows an audio track; it does not promise every output has one. */
	audio: "toggle" | "provider-native" | "silent";
	minPromptCodePoints: number;
	maxPromptCodePoints: number;
	groups: readonly VideoModelCapabilityGroup[];
	defaults: Partial<Record<VideoMode, VideoModelOption>>;
};
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bothModes: readonly VideoMode[] = ["text-to-video", "image-to-video"];
const widescreen = ["16:9", "9:16"];
const standardRatios = ["16:9", "9:16", "1:1"];
const extendedRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

function model(
	productKey: string,
	label: string,
	family: VideoModelDefinition["family"],
	durations: number[],
	resolutions: string[],
	textRatios: string[],
	imageRatios: string[],
	audio: VideoModelDefinition["audio"],
	maxPromptCodePoints: number,
	minPromptCodePoints = 1,
	modes: readonly VideoMode[] = bothModes,
): VideoModelDefinition {
	const sounds = audio === "toggle" ? [false, true] : [audio === "provider-native"];
	const groups = modes.map((mode) => ({
		mode,
		durations,
		resolutions,
		aspectRatios: mode === "text-to-video" ? textRatios : imageRatios,
		sounds,
		...(productKey === "video-veo-3-1" ? { veoTiers: videoVeoTierSchema.options } : {}),
	}));
	return {
		productKey,
		label,
		family,
		status: "implemented",
		modes,
		audio,
		minPromptCodePoints,
		// Application text safety accepts at most 10,000 UTF-16 code units.
		// Preserve larger official limits in source evidence, never admit unreviewable text.
		maxPromptCodePoints: Math.min(maxPromptCodePoints, 10000),
		groups,
		defaults: Object.fromEntries(
			groups.map((group) => [
				group.mode,
				{
					duration: productKey === "video-veo-3-1" ? 8 : durations.includes(5) ? 5 : durations[0]!,
					resolution: resolutions[0]!,
					aspectRatio: group.aspectRatios[0]!,
					sound: sounds[0]!,
					...(productKey === "video-veo-3-1" ? { veoTier: "lite" as const } : {}),
				},
			]),
		),
	};
}
function blocked(
	productKey: string,
	label: string,
	family: VideoModelDefinition["family"],
	reason: string,
): VideoModelDefinition {
	return {
		productKey,
		label,
		family,
		status: "blocked",
		blockedReason: reason,
		modes: [],
		audio: "provider-native",
		minPromptCodePoints: 1,
		maxPromptCodePoints: 1000,
		groups: [],
		defaults: {},
	};
}

/** Verified public API intersections, not copied competitor claims. See source manifest in @repo/ai. */
export const VIDEO_MODEL_CATALOG: readonly VideoModelDefinition[] = [
	model(
		"video-minimax-h3",
		"MiniMax H3",
		"MiniMax",
		range(4, 15),
		["768p", "2k"],
		extendedRatios,
		["source"],
		"provider-native",
		7000,
	),
	blocked(
		"video-minimax-h3-turbo",
		"MiniMax H3 Turbo",
		"MiniMax",
		"OFFICIAL_MODEL_CONTRACT_UNAVAILABLE",
	),
	blocked(
		"video-minimax-h3-max-turbo",
		"MiniMax H3 Max Turbo",
		"MiniMax",
		"OFFICIAL_MODEL_CONTRACT_UNAVAILABLE",
	),
	blocked(
		"video-minimax-h3-max",
		"MiniMax H3 Max",
		"MiniMax",
		"OFFICIAL_MODEL_CONTRACT_UNAVAILABLE",
	),
	model(
		"video-seedance-2-5",
		"Seedance 2.5",
		"Seedance",
		range(4, 30),
		["720p", "480p", "1080p"],
		extendedRatios,
		[...extendedRatios, "adaptive"],
		"toggle",
		20480,
	),
	model(
		"video-seedance-2-mini",
		"Seedance 2 Mini",
		"Seedance",
		range(4, 15),
		["720p", "480p"],
		extendedRatios,
		[...extendedRatios, "adaptive"],
		"toggle",
		20000,
		3,
	),
	model(
		"video-seedance-1-pro-fast",
		"Seedance 1 Pro Fast",
		"Seedance",
		[5, 10],
		["720p", "1080p"],
		[],
		["source"],
		"silent",
		10000,
		1,
		["image-to-video"],
	),
	model(
		"video-seedance-1-5-pro",
		"Seedance 1.5 Pro",
		"Seedance",
		range(4, 12),
		["720p", "480p", "1080p"],
		extendedRatios,
		extendedRatios,
		"toggle",
		20000,
		3,
	),
	model(
		"video-seedance-2",
		"Seedance 2",
		"Seedance",
		range(4, 15),
		["720p", "480p", "1080p", "4k"],
		extendedRatios,
		[...extendedRatios, "adaptive"],
		"toggle",
		20000,
		3,
	),
	model(
		"video-seedance-2-fast",
		"Seedance 2 Fast",
		"Seedance",
		range(4, 15),
		["720p", "480p"],
		extendedRatios,
		[...extendedRatios, "adaptive"],
		"toggle",
		20000,
		3,
	),
	model(
		"video-gemini-omni-flash",
		"Gemini Omni 1.1 Flash",
		"Gemini",
		[4, 6, 8, 10],
		["720p", "360p", "1080p", "4k"],
		widescreen,
		widescreen,
		"provider-native",
		20000,
	),
	model(
		"video-kling-3",
		"Kling 3",
		"Kling",
		range(3, 15),
		["720p", "1080p", "4k"],
		standardRatios,
		["source"],
		"toggle",
		1000,
	),
	model(
		"video-kling-3-turbo",
		"Kling 3 Turbo",
		"Kling",
		range(3, 15),
		["720p", "1080p"],
		standardRatios,
		["source"],
		"provider-native",
		2500,
	),
	model(
		"video-kling-2-6-v1",
		"Kling 2.6",
		"Kling",
		[5, 10],
		["default"],
		standardRatios,
		["source"],
		"toggle",
		1000,
	),
	model(
		"video-veo-3-1",
		"Veo 3.1",
		"Veo",
		[4, 6, 8],
		["720p", "1080p", "4k"],
		widescreen,
		[...widescreen, "source"],
		"provider-native",
		1000,
	),
	model(
		"video-veo-3-1-fast",
		"Veo 3.1 Fast",
		"Veo",
		[4, 6, 8],
		["720p", "1080p", "4k"],
		widescreen,
		[...widescreen, "source"],
		"provider-native",
		1000,
	),
	blocked("video-veo-3-1-pro", "Veo 3.1 Pro", "Veo", "OFFICIAL_VARIANT_MAPPING_UNCONFIRMED"),
];

export function getVideoModel(productKey: string): VideoModelDefinition | undefined {
	return VIDEO_MODEL_CATALOG.find((entry) => entry.productKey === productKey);
}
export function getVideoModelOptions(productKey: string, mode: VideoMode): VideoModelOption[] {
	const entry = getVideoModel(productKey);
	if (!entry || entry.status !== "implemented") return [];
	return entry.groups
		.filter((group) => group.mode === mode)
		.flatMap((group) =>
			group.durations.flatMap((duration) =>
				group.resolutions.flatMap((resolution) =>
					group.aspectRatios.flatMap((aspectRatio) =>
						group.sounds.flatMap((sound) =>
							(group.veoTiers ?? [undefined]).map((veoTier) => ({
								duration,
								resolution,
								aspectRatio,
								sound,
								...(veoTier === undefined ? {} : { veoTier }),
							})),
						),
					),
				),
			),
		);
}
export function validateVideoModelSelection(selection: VideoModelSelection): boolean {
	const entry = getVideoModel(selection.productKey);
	return Boolean(
		entry?.status === "implemented" &&
		entry.groups.some(
			(group) =>
				group.mode === selection.mode &&
				group.durations.includes(selection.duration) &&
				group.resolutions.includes(selection.resolution) &&
				group.aspectRatios.includes(selection.aspectRatio) &&
				group.sounds.includes(selection.sound) &&
				(group.veoTiers
					? selection.veoTier !== undefined && group.veoTiers.includes(selection.veoTier)
					: selection.veoTier === undefined),
		),
	);
}

/** Narrow compatibility parser for immutable receipts and already admitted provider jobs. */
export const videoModelReceiptInputSchema = z
	.object({
		productKey: z.string().min(1).max(100),
		mode: z.enum(["text-to-video", "image-to-video"]),
		prompt: z.string().trim().min(1).max(10000),
		duration: z.number().int().positive(),
		resolution: z.string().min(1).max(20),
		aspectRatio: z.string().min(1).max(20),
		sound: z.boolean(),
		inputAssetId: z.string().min(1).max(160).optional(),
		// Append only: absent historical fields must not change serialized fingerprints.
		veoTier: videoVeoTierSchema.optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		const historicalKlingImage =
			input.productKey === "video-kling-3" &&
			input.mode === "image-to-video" &&
			standardRatios.includes(input.aspectRatio) &&
			validateVideoModelSelection({ ...input, aspectRatio: "source" });
		const historicalVeo =
			input.productKey === "video-veo-3-1" &&
			input.veoTier === undefined &&
			validateVideoModelSelection({ ...input, veoTier: "fast" });
		if (!validateVideoModelSelection(input) && !historicalKlingImage && !historicalVeo)
			ctx.addIssue({ code: "custom", message: "VIDEO_MODEL_SELECTION_UNSUPPORTED" });
		const entry = getVideoModel(input.productKey);
		const length = Array.from(input.prompt).length;
		if (entry && (length < entry.minPromptCodePoints || length > entry.maxPromptCodePoints))
			ctx.addIssue({ code: "custom", path: ["prompt"], message: "VIDEO_PROMPT_LENGTH" });
		if ((input.mode === "image-to-video") !== Boolean(input.inputAssetId))
			ctx.addIssue({
				code: "custom",
				path: ["inputAssetId"],
				message: "VIDEO_INPUT_ASSET_MODE_MISMATCH",
			});
	});

/** New quotes and admissions use only today's documented capability intersection. */
export const videoModelInputSchema = videoModelReceiptInputSchema.refine(
	validateVideoModelSelection,
	{ message: "VIDEO_MODEL_SELECTION_UNSUPPORTED" },
);
export type VideoModelInput = z.infer<typeof videoModelInputSchema>;
