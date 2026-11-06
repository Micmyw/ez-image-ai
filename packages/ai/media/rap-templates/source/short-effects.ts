import { z } from "zod";

export const SHORT_EFFECT_IDS = [
	"kung-fu-cat-ai",
	"paws-at-you-ai",
	"green-booth-freestyle-ai",
] as const;
export type ShortEffectId = (typeof SHORT_EFFECT_IDS)[number];

export function isShortEffectId(value: unknown): value is ShortEffectId {
	return typeof value === "string" && SHORT_EFFECT_IDS.some((id) => id === value);
}

export const SHORT_EFFECTS = {
	"kung-fu-cat-ai": {
		id: "kung-fu-cat-ai",
		path: "/kung-fu-cat-ai",
		name: "Kung Fu Cat",
		revision: "kung-fu-cat-h3-v2",
		preset: "pet",
		photoCount: 1,
		duration: 9,
		aspectRatio: "9:16",
		resolution: "768P",
		defaultCredits: 6,
		enabledKey: "short_kung_fu_cat_enabled",
		creditsKey: "short_kung_fu_cat_768p_credits",
	},
	"paws-at-you-ai": {
		id: "paws-at-you-ai",
		path: "/paws-at-you-ai",
		name: "Paws at You",
		revision: "paws-at-you-h3-v2",
		preset: "pet",
		photoCount: 1,
		duration: 6,
		aspectRatio: "9:16",
		resolution: "768P",
		defaultCredits: 4,
		enabledKey: "short_paws_at_you_enabled",
		creditsKey: "short_paws_at_you_768p_credits",
	},
	"green-booth-freestyle-ai": {
		id: "green-booth-freestyle-ai",
		path: "/green-booth-freestyle-ai",
		name: "Green Booth Freestyle",
		revision: "green-booth-h3-v3",
		preset: "duo",
		photoCount: 2,
		duration: 10,
		aspectRatio: "16:9",
		resolution: "768P",
		defaultCredits: 10,
		enabledKey: "short_green_booth_enabled",
		creditsKey: "short_green_booth_768p_credits",
	},
} as const;

const photoUrl = z
	.url()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.hash &&
				!/[{}<>]/.test(decodeURIComponent(value)) &&
				/\.[a-z]{2,63}$/i.test(url.hostname) &&
				!/\.(localhost|local|internal|invalid)$/i.test(url.hostname)
			);
		} catch {
			return false;
		}
	});

const commonFields = {
	// Historical revisions remain parseable; new creates compare the current
	// revision separately, after idempotency recovery has had a chance to run.
	revision: z.string().trim().min(1).max(80),
	imageUrl: photoUrl,
	resolution: z.literal("768P"),
	aspectRatio: z.literal("9:16"),
	expectedCredits: z.number().int().positive().max(1_000_000),
	idempotencyKey: z.uuid(),
	consentVersion: z.literal("short-effects-v1"),
};

export const shortEffectRequestSchema = z.discriminatedUnion("templateId", [
	z
		.object({
			...commonFields,
			templateId: z.literal("kung-fu-cat-ai"),
			preset: z.literal("pet"),
			duration: z.literal(9),
			secondImageUrl: z.never().optional(),
		})
		.strict()
		.refine((value) => !Object.prototype.hasOwnProperty.call(value, "secondImageUrl"), {
			path: ["secondImageUrl"],
			message: "One pet photo is required",
		}),
	z
		.object({
			...commonFields,
			templateId: z.literal("paws-at-you-ai"),
			preset: z.literal("pet"),
			duration: z.literal(6),
			secondImageUrl: z.never().optional(),
		})
		.strict()
		.refine((value) => !Object.prototype.hasOwnProperty.call(value, "secondImageUrl"), {
			path: ["secondImageUrl"],
			message: "One pet photo is required",
		}),
	z
		.object({
			...commonFields,
			templateId: z.literal("green-booth-freestyle-ai"),
			preset: z.literal("duo"),
			// Keep the previously accepted contract parseable for frozen-task recovery.
			duration: z.union([z.literal(10), z.literal(12)]),
			aspectRatio: z.enum(["16:9", "9:16"]),
			secondImageUrl: photoUrl,
		})
		.strict()
		.refine(
			(value) =>
				(value.duration === 10 && value.aspectRatio === "16:9") ||
				(value.duration === 12 && value.aspectRatio === "9:16"),
			{
				path: ["aspectRatio"],
				message: "Unsupported Green Booth format",
			},
		)
		.refine(
			(value) => {
				try {
					// Match approved-image lookup without changing the frozen request.
					return new URL(value.secondImageUrl).href !== new URL(value.imageUrl).href;
				} catch {
					return false;
				}
			},
			{
				path: ["secondImageUrl"],
				message: "Two different performer photos are required",
			},
		),
]);

export type ShortEffectInput = z.infer<typeof shortEffectRequestSchema>;
type WithLocalPhotos<T> = T extends unknown
	? Omit<T, "imageUrl" | "secondImageUrl" | "expectedCredits" | "idempotencyKey"> & {
			photos: File[];
		}
	: never;
export type ShortEffectDraft = WithLocalPhotos<ShortEffectInput>;
export type ShortEffectConfig = {
	id: ShortEffectId;
	ready: boolean;
	revision: string;
	variants: [
		{
			preset: "pet" | "duo";
			photoCount: 1 | 2;
			duration: 6 | 9 | 10;
			aspectRatio: "9:16" | "16:9";
			resolution: "768P";
			costCredits: number | null;
		},
	];
	examples: {
		label?: string;
		video: string;
		poster: string;
		durationSeconds: number;
		aspectRatio: "9:16" | "16:9";
		kind: "provided" | "generated";
	}[];
};

export function shortEffectQuote(
	id: ShortEffectId,
	configs: Record<string, string>,
): number | null {
	if (!isShortEffectId(id)) return null;
	const effect = SHORT_EFFECTS[id];
	const raw = configs[effect.creditsKey];
	if (raw === undefined) return effect.defaultCredits;
	if (!raw.trim()) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
}
