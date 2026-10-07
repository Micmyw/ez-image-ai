import { z } from "zod";

/** Browser-safe product contract. Execution mappings and prompts stay in the server module. */
export const HOTEL_LOBBY_EFFECT_ID = "hotel-lobby-duo";
export const RAINDANCE_SOLO_EFFECT_ID = "raindance-solo";
export const RAINDANCE_DUO_EFFECT_ID = "raindance-duo";
export const RUMPELSTILTSKIN_SOLO_EFFECT_ID = "rumpelstiltskin-solo";
export const videoEffectIdSchema = z.enum([
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RAINDANCE_DUO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
]);
export type VideoEffectId = z.infer<typeof videoEffectIdSchema>;
export function videoEffectName(effectId: VideoEffectId): string {
	return effectId === HOTEL_LOBBY_EFFECT_ID
		? "Hotel Lobby duo"
		: effectId === RAINDANCE_SOLO_EFFECT_ID
			? "Raindance solo"
			: effectId === RAINDANCE_DUO_EFFECT_ID
				? "Raindance duet"
				: "Rumpelstiltskin solo";
}
export const VIDEO_EFFECT_MAX_INPUT_BYTES = 10_000_000;
export const HOTEL_LOBBY_PUBLIC_EFFECT = {
	effectId: HOTEL_LOBBY_EFFECT_ID,
	name: "Hotel Lobby duo",
	publicVersion: "1",
	presetKey: "standard",
	output: { durationSeconds: 5, resolution: "720p", aspectRatio: "9:16", sound: false },
	inputs: { count: 2, roles: ["left", "right"], maxBytes: VIDEO_EFFECT_MAX_INPUT_BYTES },
} as const;
/** Internal test entry; availability and approval evidence are server-only. */
export const RUMPELSTILTSKIN_PUBLIC_EFFECT = {
	effectId: RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	name: "Rumpelstiltskin solo",
	publicVersion: "1",
	presetKey: "standard",
	output: { durationSeconds: 5, resolution: "720p", aspectRatio: "9:16", sound: false },
	inputs: { count: 1, roles: ["subject"], maxBytes: VIDEO_EFFECT_MAX_INPUT_BYTES },
} as const;

const assetId = z.string().min(1).max(160);
export const videoEffectRequestSchema = z
	.object({
		effectId: videoEffectIdSchema,
		presetKey: z.literal("standard"),
		inputs: z.object({ leftAssetId: assetId, rightAssetId: assetId }).strict(),
	})
	.strict()
	.refine(
		(request) =>
			![RAINDANCE_SOLO_EFFECT_ID, RUMPELSTILTSKIN_SOLO_EFFECT_ID].includes(request.effectId) ||
			request.inputs.leftAssetId === request.inputs.rightAssetId,
		{ message: "Solo requires one subject reference" },
	);
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
