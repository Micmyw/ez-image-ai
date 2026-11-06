import { z } from "zod";

export const HOTEL_LOBBY_ID = "hotel-lobby-ai" as const;
export const HOTEL_LOBBY_RESOLUTIONS = ["768P", "2K"] as const;
export const HOTEL_LOBBY_RATIOS = [
	"9:16",
	"16:9",
	"1:1",
	"4:3",
	"3:4",
	"21:9",
	"adaptive",
] as const;
export const HOTEL_LOBBY_DEFAULT_PRICES = { "768P": 10, "2K": 20 } as const;
export type HotelLobbyResolution = (typeof HOTEL_LOBBY_RESOLUTIONS)[number];

const portraitUrl = z
	.url()
	.max(2048)
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.hash;
	});
export const hotelLobbyRequestSchema = z
	.object({
		templateId: z.literal(HOTEL_LOBBY_ID),
		imageUrl: portraitUrl,
		secondImageUrl: portraitUrl,
		resolution: z.enum(HOTEL_LOBBY_RESOLUTIONS),
		aspectRatio: z.enum(HOTEL_LOBBY_RATIOS),
		expectedCredits: z.number().int().positive().max(1_000_000),
		idempotencyKey: z.uuid(),
	})
	.strict();
export type HotelLobbyInput = z.infer<typeof hotelLobbyRequestSchema>;
export type HotelLobbyDraft = Pick<HotelLobbyInput, "templateId" | "resolution" | "aspectRatio"> & {
	photos: File[];
};
export type HotelLobbyConfig = {
	ready: boolean;
	prices: Record<HotelLobbyResolution, number | null>;
};

export function hotelLobbyPrices(configs: Record<string, string>): HotelLobbyConfig["prices"] {
	const price = (key: string, fallback: number) => {
		const raw = configs[key]?.trim();
		if (!raw) return fallback;
		const value = Number(raw);
		return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
	};
	return {
		"768P": price("hotel_lobby_768p_credits", HOTEL_LOBBY_DEFAULT_PRICES["768P"]),
		"2K": price("hotel_lobby_2k_credits", HOTEL_LOBBY_DEFAULT_PRICES["2K"]),
	};
}

export function hotelLobbyImageDimensions(width: number, height: number) {
	return (
		width >= 256 &&
		height >= 256 &&
		width <= 5760 &&
		height <= 5760 &&
		width / height >= 0.4 &&
		width / height <= 2.5
	);
}

export const HOTEL_LOBBY_EXAMPLES = [2].map((index) => ({
	id: index,
	poster: `/effects/hotel-lobby/example-${index}.jpg`,
	video: `/effects/hotel-lobby/example-${index}.mp4`,
	portraits: [
		`/effects/hotel-lobby/example-${index}-left.png`,
		`/effects/hotel-lobby/example-${index}-right.png`,
	],
}));
