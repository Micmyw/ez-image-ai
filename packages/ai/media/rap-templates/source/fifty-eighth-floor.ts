import { z } from "zod";

export const FLOOR58_ID = "58th-floor-ai" as const;
export const FLOOR58_REVISION = "floor58-h3-reference-v1" as const;
export const FLOOR58_MODES = ["duo", "solo", "person-pet"] as const;
export type Floor58Mode = (typeof FLOOR58_MODES)[number];
export const FLOOR58_COUNTS = { duo: 2, solo: 1, "person-pet": 2 } as const;
export const FLOOR58_RESOLUTIONS = ["768P", "2K"] as const;
export type Floor58Resolution = (typeof FLOOR58_RESOLUTIONS)[number];

const portraitUrl = z
	.url()
	.max(2048)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});

export const floor58RequestSchema = z
	.object({
		templateId: z.literal(FLOOR58_ID),
		preset: z.enum(FLOOR58_MODES),
		revision: z.string().min(1).max(80),
		imageUrl: portraitUrl,
		secondImageUrl: portraitUrl.optional(),
		resolution: z.enum(FLOOR58_RESOLUTIONS),
		duration: z.literal(15),
		aspectRatio: z.literal("9:16"),
		expectedCredits: z.number().int().positive().max(1_000_000),
		idempotencyKey: z.uuid(),
	})
	.strict()
	.refine(
		(value) =>
			(value.secondImageUrl ? 2 : 1) === FLOOR58_COUNTS[value.preset] &&
			value.secondImageUrl !== value.imageUrl,
		{ message: "Invalid performer photos", path: ["secondImageUrl"] },
	);

export type Floor58Input = z.infer<typeof floor58RequestSchema>;
export type Floor58Draft = Pick<
	Floor58Input,
	"templateId" | "preset" | "revision" | "resolution" | "duration" | "aspectRatio"
> & { photos: File[] };
export type Floor58Config = {
	ready: boolean;
	revision: string;
	prices: Record<Floor58Resolution, number | null>;
	example?: { video: string; poster: string };
};

export function floor58Prices(configs: Record<string, string>): Floor58Config["prices"] {
	const price = (key: string, fallback: number) => {
		const raw = configs[key]?.trim();
		if (!raw) return fallback;
		const value = Number(raw);
		return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
	};
	return {
		"768P": price("floor58_768p_credits", 10),
		"2K": price("floor58_2k_credits", 20),
	};
}

// Owner-supplied example, independent of private generation references.
export const FLOOR58_EXAMPLE = {
	video: "/effects/58th-floor/duo-example.mp4",
	poster: "/effects/58th-floor/duo-example.webp",
} as const;
