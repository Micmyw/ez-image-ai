import { getVideoModel, validateVideoModelSelection } from "@repo/config/video-models";
import { z } from "zod";

import { changeVideoDraft, type VideoDraft } from "./model";

const savedSchema = z
	.object({
		version: z.literal(1),
		ownerId: z.string(),
		savedAt: z.number().finite(),
		draft: z
			.object({
				productKey: z.string(),
				mode: z.enum(["text-to-video", "image-to-video"]),
				prompt: z.string().max(20000),
				inputAssetId: z.string().min(1).max(200).nullable(),
				duration: z.number().int().positive(),
				resolution: z.string(),
				aspectRatio: z.string(),
				sound: z.boolean(),
			})
			.strict(),
	})
	.strict();

export const videoDraftKey = (ownerId: string) => `video-v1:draft:${ownerId}`;
export const VIDEO_GUEST_HANDOFF_KEY = "video-v1:guest-handoff";

export function serializeVideoDraft(draft: VideoDraft, ownerId: string, now = Date.now()) {
	return JSON.stringify({
		version: 1,
		ownerId,
		savedAt: now,
		draft: {
			...draft,
			mode: draft.inputAssetId ? "image-to-video" : draft.mode,
			inputAssetId: ownerId === "guest" ? null : draft.inputAssetId,
		},
	});
}

export function parseVideoDraft(
	raw: string | null,
	ownerId: string,
	now = Date.now(),
): VideoDraft | null {
	try {
		const result = savedSchema.safeParse(JSON.parse(raw ?? "null"));
		if (!result.success) return null;
		const saved = result.data;
		if (
			saved.ownerId !== ownerId ||
			saved.savedAt > now ||
			now - saved.savedAt > 3_600_000 ||
			getVideoModel(saved.draft.productKey)?.status !== "implemented" ||
			(ownerId === "guest" && saved.draft.inputAssetId)
		)
			return null;
		// Unsubmitted references need explicit re-selection after a reload. Pending
		// accepted submissions restore their immutable asset from the separate receipt.
		const draft = changeVideoDraft(saved.draft, {
			mode: saved.draft.inputAssetId ? "image-to-video" : saved.draft.mode,
			inputAssetId: null,
		});
		return validateVideoModelSelection(draft) ? draft : null;
	} catch {
		return null;
	}
}
