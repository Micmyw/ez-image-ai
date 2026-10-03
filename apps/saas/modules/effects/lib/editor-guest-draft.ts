import { IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config/client";
import { z } from "zod";

import { generationFormValuesSchema, type GenerationFormValues } from "../../media/lib/form-schema";
import type { WorkspaceStorage } from "../../media/lib/workspace-draft";
import type { EffectPageContent, PublicEffectPreset } from "./types";

const schema = z
	.object({
		version: z.literal(1),
		savedAt: z.number().int().nonnegative(),
		presetId: z.string().min(1).max(96),
		presetVersion: z.number().int().positive(),
		values: generationFormValuesSchema
			.omit({ sourceAssetId: true })
			.extend({ prompt: z.string().max(10_000) })
			.strict()
			.refine((value) =>
				(IMAGE_SKU_KEYS_BY_PRODUCT[value.productKey] as readonly string[]).includes(value.skuKey),
			),
		hadReference: z.boolean(),
	})
	.strict();

const keyFor = (effectId: string) => `ezpic.effect-guest-draft.v1:${effectId}`;

export function readEffectGuestDraft(
	storage: WorkspaceStorage,
	effect: Pick<EffectPageContent, "id">,
	preset: Pick<PublicEffectPreset, "id" | "version">,
	now = Date.now(),
) {
	try {
		const serialized = storage.getItem(keyFor(effect.id));
		if (!serialized || serialized.length > 60_000) return null;
		const parsed = schema.safeParse(JSON.parse(serialized));
		if (
			!parsed.success ||
			parsed.data.savedAt > now + 300_000 ||
			now - parsed.data.savedAt > 3_600_000
		) {
			storage.removeItem(keyFor(effect.id));
			return null;
		}
		if (parsed.data.presetId !== preset.id || parsed.data.presetVersion !== preset.version)
			return null;
		return parsed.data;
	} catch {
		return null;
	}
}

export function saveEffectGuestDraft(
	storage: WorkspaceStorage,
	effect: Pick<EffectPageContent, "id">,
	preset: Pick<PublicEffectPreset, "id" | "version">,
	values: Omit<GenerationFormValues, "sourceAssetId">,
	hadReference: boolean,
	now = Date.now(),
): boolean {
	try {
		const parsed = schema.safeParse({
			version: 1,
			savedAt: now,
			presetId: preset.id,
			presetVersion: preset.version,
			values,
			hadReference,
		});
		if (!parsed.success) return false;
		storage.setItem(keyFor(effect.id), JSON.stringify(parsed.data));
		return true;
	} catch {
		return false;
	}
}
