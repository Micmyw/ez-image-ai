import { IMAGE_SKU_KEYS_BY_PRODUCT } from "@repo/config/client";
import { z } from "zod";

import { generationFormValuesSchema, type GenerationFormValues } from "./form-schema";

export interface WorkspaceDraft {
	values: GenerationFormValues;
	parentJobId: string | null;
}
export interface WorkspaceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): unknown;
	removeItem(key: string): unknown;
}
export const WORKSPACE_DRAFT_KEY = "ezpic.workspace-draft.v1";
const storedDraftSchema = z
	.object({
		version: z.literal(1),
		savedAt: z.number().int().nonnegative(),
		ownerId: z.string().min(1).max(128),
		values: generationFormValuesSchema
			.extend({
				prompt: z.string().max(10_000),
				sourceAssetId: z.string().max(128),
			})
			.strict()
			.refine((value) =>
				(IMAGE_SKU_KEYS_BY_PRODUCT[value.productKey] as readonly string[]).includes(value.skuKey),
			),
		// Accept old drafts without restoring their transient result selection.
		jobId: z.string().min(1).max(128).nullable().optional(),
		parentJobId: z.string().min(1).max(128).nullable(),
	})
	.strict();

export function saveWorkspaceDraft(
	storage: WorkspaceStorage,
	ownerId: string,
	draft: WorkspaceDraft,
	now = Date.now(),
): boolean {
	try {
		const parsed = storedDraftSchema.safeParse({
			version: 1,
			savedAt: now,
			ownerId,
			values: draft.values,
			parentJobId: draft.parentJobId,
		});
		if (!parsed.success) return false;
		storage.setItem(WORKSPACE_DRAFT_KEY, JSON.stringify(parsed.data));
		return true;
	} catch {
		return false;
	}
}

export function loadWorkspaceDraft(
	storage: WorkspaceStorage,
	ownerId: string,
	now = Date.now(),
): WorkspaceDraft | null {
	try {
		const serialized = storage.getItem(WORKSPACE_DRAFT_KEY);
		if (!serialized || serialized.length > 65_000) return null;
		const parsed = storedDraftSchema.safeParse(JSON.parse(serialized));
		if (
			!parsed.success ||
			parsed.data.ownerId !== ownerId ||
			now - parsed.data.savedAt > 3_600_000 ||
			parsed.data.savedAt > now + 300_000
		) {
			storage.removeItem(WORKSPACE_DRAFT_KEY);
			return null;
		}
		return {
			values: parsed.data.values,
			parentJobId: parsed.data.parentJobId,
		};
	} catch {
		return null;
	}
}
