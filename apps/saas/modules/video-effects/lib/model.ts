import {
	HOTEL_LOBBY_EFFECT_ID,
	RAINDANCE_SOLO_EFFECT_ID,
	RUMPELSTILTSKIN_SOLO_EFFECT_ID,
	VIDEO_EFFECT_MAX_INPUT_BYTES,
	videoEffectRequestSchema,
	videoEffectIdSchema,
	type VideoEffectId,
} from "@repo/config/video-effects";
import { z } from "zod";

export { VIDEO_EFFECT_PATH } from "./paths";
export const VIDEO_EFFECT_ID = HOTEL_LOBBY_EFFECT_ID;
export const VIDEO_EFFECT_PRESET = "standard";
export const VIDEO_EFFECT_MAX_BYTES = VIDEO_EFFECT_MAX_INPUT_BYTES;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const requestSchema = videoEffectRequestSchema.refine(
	(request) =>
		id.safeParse(request.inputs.leftAssetId).success &&
		id.safeParse(request.inputs.rightAssetId).success,
);
const quoteSchema = z
	.object({ quoteId: id, credits: z.string().regex(/^\d+$/), expiresAt: z.string().datetime() })
	.strict();
const confirmationSchema = z
	.object({
		input: z
			.object({ quoteId: id, idempotencyKey: z.string().uuid(), request: requestSchema })
			.strict(),
		quote: quoteSchema,
	})
	.strict()
	.refine((value) => value.input.quoteId === value.quote.quoteId);
const draftSchema = z
	.object({
		version: z.literal(1),
		ownerId: id,
		effectId: videoEffectIdSchema.default(HOTEL_LOBBY_EFFECT_ID),
		revision: z.number().int().nonnegative(),
		leftAssetId: id.nullable(),
		rightAssetId: id.nullable(),
		confirmation: confirmationSchema.nullable(),
		jobId: id.nullable(),
	})
	.strict();
export type EffectDraft = z.infer<typeof draftSchema>;
export type EffectConfirmation = z.infer<typeof confirmationSchema>;
export type EffectQuote = z.infer<typeof quoteSchema>;
export type EffectRole = "left" | "right";

export function emptyEffectDraft(
	ownerId: string,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
): EffectDraft {
	return {
		version: 1,
		ownerId,
		effectId,
		revision: 0,
		leftAssetId: null,
		rightAssetId: null,
		confirmation: null,
		jobId: null,
	};
}
export function readEffectDraft(
	raw: string | null,
	ownerId: string,
	effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID,
): EffectDraft | null {
	try {
		const value = draftSchema.parse(JSON.parse(raw ?? "null"));
		return value.ownerId === ownerId &&
			value.effectId === effectId &&
			(!value.confirmation || value.confirmation.input.request.effectId === effectId)
			? value
			: null;
	} catch {
		return null;
	}
}
export function effectStorageKey(ownerId: string, effectId: VideoEffectId = HOTEL_LOBBY_EFFECT_ID) {
	return effectId === HOTEL_LOBBY_EFFECT_ID
		? `ezpic.video-effect.v1:${ownerId}`
		: `ezpic.video-effect.v1:${effectId}:${ownerId}`;
}
export function effectRequest(draft: EffectDraft) {
	return requestSchema.parse({
		effectId: draft.effectId,
		presetKey: VIDEO_EFFECT_PRESET,
		inputs: {
			leftAssetId: draft.leftAssetId,
			rightAssetId: [RAINDANCE_SOLO_EFFECT_ID, RUMPELSTILTSKIN_SOLO_EFFECT_ID].includes(
				draft.effectId,
			)
				? draft.leftAssetId
				: draft.rightAssetId,
		},
	});
}
export function changeEffectInputs(
	draft: EffectDraft,
	patch: Partial<Pick<EffectDraft, "leftAssetId" | "rightAssetId">>,
): EffectDraft {
	// A pending confirmation is an unresolved commercial intent. Keep it independently
	// from the new draft until its original receipt is recovered.
	return { ...draft, ...patch, revision: draft.revision + 1 };
}
export function swapEffectInputs(draft: EffectDraft): EffectDraft {
	return changeEffectInputs(draft, {
		leftAssetId: draft.rightAssetId,
		rightAssetId: draft.leftAssetId,
	});
}
export function createEffectConfirmation(
	draft: EffectDraft,
	quote: EffectQuote,
	key = crypto.randomUUID(),
): EffectConfirmation {
	return confirmationSchema.parse({
		quote,
		input: { quoteId: quote.quoteId, idempotencyKey: key, request: effectRequest(draft) },
	});
}
export function validEffectFile(file: { type: string; size: number }, maxBytes: number): boolean {
	return (
		["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
		file.size > 0 &&
		file.size <= Math.min(VIDEO_EFFECT_MAX_BYTES, maxBytes)
	);
}
export function effectError(
	error: unknown,
): "insufficient" | "quoteExpired" | "unavailable" | "requestFailed" | EffectReadinessMessage {
	const value =
		typeof error === "object" && error !== null
			? (error as { code?: string; message?: string })
			: {};
	const code = `${value.code ?? ""} ${value.message ?? ""}`;
	const readiness = effectReadinessMessage(value.message ?? "");
	if (readiness !== "unavailable") return readiness;
	if (value.message === "INSUFFICIENT_ELIGIBLE_CREDITS") return "insufficient";
	if (value.message === "QUOTE_EXPIRED_OR_CHANGED") return "quoteExpired";
	if (/DISABLED|UNAVAILABLE|ADMISSION|FORBIDDEN/.test(code)) return "unavailable";
	return "requestFailed";
}

type EffectReadinessMessage =
	| "rumpelstiltskin.motionRequired"
	| "rumpelstiltskin.motionInvalid"
	| "rumpelstiltskin.costRequired"
	| "rumpelstiltskin.costInvalid"
	| "unavailable";

/** Unknown server errors are never interpolated into product copy. */
export function effectReadinessMessage(reason: string): EffectReadinessMessage {
	switch (reason) {
		case "MOTION_REFERENCE_REQUIRED":
			return "rumpelstiltskin.motionRequired";
		case "MOTION_REFERENCE_INVALID":
			return "rumpelstiltskin.motionInvalid";
		case "COST_APPROVAL_REQUIRED":
			return "rumpelstiltskin.costRequired";
		case "COST_APPROVAL_INVALID":
			return "rumpelstiltskin.costInvalid";
		default:
			return "unavailable";
	}
}
