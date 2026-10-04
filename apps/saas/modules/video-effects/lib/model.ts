import { HOTEL_LOBBY_EFFECT_ID, VIDEO_EFFECT_MAX_INPUT_BYTES } from "@repo/config/video-effects";
import { z } from "zod";

export const VIDEO_EFFECT_PATH = "/video-effects/hotel-lobby-ai";
export const VIDEO_EFFECT_ID = HOTEL_LOBBY_EFFECT_ID;
export const VIDEO_EFFECT_PRESET = "standard";
export const VIDEO_EFFECT_MAX_BYTES = VIDEO_EFFECT_MAX_INPUT_BYTES;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const requestSchema = z
	.object({
		effectId: z.literal(VIDEO_EFFECT_ID),
		presetKey: z.literal(VIDEO_EFFECT_PRESET),
		inputs: z.object({ leftAssetId: id, rightAssetId: id }).strict(),
	})
	.strict();
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

export function emptyEffectDraft(ownerId: string): EffectDraft {
	return {
		version: 1,
		ownerId,
		revision: 0,
		leftAssetId: null,
		rightAssetId: null,
		confirmation: null,
		jobId: null,
	};
}
export function readEffectDraft(raw: string | null, ownerId: string): EffectDraft | null {
	try {
		const value = draftSchema.parse(JSON.parse(raw ?? "null"));
		return value.ownerId === ownerId ? value : null;
	} catch {
		return null;
	}
}
export function effectStorageKey(ownerId: string) {
	return `ezpic.video-effect.v1:${ownerId}`;
}
export function effectRequest(draft: EffectDraft) {
	return requestSchema.parse({
		effectId: VIDEO_EFFECT_ID,
		presetKey: VIDEO_EFFECT_PRESET,
		inputs: { leftAssetId: draft.leftAssetId, rightAssetId: draft.rightAssetId },
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
): "insufficient" | "quoteExpired" | "unavailable" | "requestFailed" {
	const value =
		typeof error === "object" && error !== null
			? (error as { code?: string; message?: string })
			: {};
	const code = `${value.code ?? ""} ${value.message ?? ""}`;
	if (value.message === "INSUFFICIENT_ELIGIBLE_CREDITS") return "insufficient";
	if (value.message === "QUOTE_EXPIRED_OR_CHANGED") return "quoteExpired";
	if (/DISABLED|UNAVAILABLE|ADMISSION|FORBIDDEN/.test(code)) return "unavailable";
	return "requestFailed";
}
