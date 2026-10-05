import { z } from "zod";

/** Browser-safe product contract. Execution mappings and prompts stay in the server module. */
export const HOTEL_LOBBY_EFFECT_ID = "hotel-lobby-duo";
export const VIDEO_EFFECT_MAX_INPUT_BYTES = 10_000_000;
export const HOTEL_LOBBY_PUBLIC_EFFECT = {
	effectId: HOTEL_LOBBY_EFFECT_ID,
	name: "Hotel Lobby duo",
	publicVersion: "1",
	presetKey: "standard",
	output: { durationSeconds: 5, resolution: "720p", aspectRatio: "9:16", sound: false },
	inputs: { count: 2, roles: ["left", "right"], maxBytes: VIDEO_EFFECT_MAX_INPUT_BYTES },
} as const;

const assetId = z.string().min(1).max(160);
export const videoEffectRequestSchema = z
	.object({
		effectId: z.literal(HOTEL_LOBBY_EFFECT_ID),
		presetKey: z.literal("standard"),
		inputs: z.object({ leftAssetId: assetId, rightAssetId: assetId }).strict(),
	})
	.strict();
export const videoEffectInputSchema = videoEffectRequestSchema;
export const videoEffectCreateSchema = z
	.object({
		quoteId: z.string().min(1).max(160),
		idempotencyKey: z.string().min(8).max(128),
		request: videoEffectRequestSchema,
	})
	.strict();
export type VideoEffectRequest = z.infer<typeof videoEffectRequestSchema>;
export type VideoEffectCreateInput = z.infer<typeof videoEffectCreateSchema>;
