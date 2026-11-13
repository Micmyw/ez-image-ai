import { EZPIC_PRODUCT_KEYS } from "@repo/config";
import { saveReferencePromptRecord } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import { toMediaOrpcError } from "../lib/errors";
import { enforceMediaRateLimit } from "../lib/rate-limit";

export const saveReferencePrompt = protectedProcedure
	.route({
		method: "POST",
		path: "/media/reference-prompts",
		tags: ["Media"],
		summary: "Save reference-image prompt context",
		description:
			"Saves an authenticated owner's unsubmitted prompt for private support review, without starting generation or approving an image.",
	})
	.input(
		z
			.object({
				assetId: z.string().min(1).max(128),
				productKey: z.enum(EZPIC_PRODUCT_KEYS),
				prompt: z
					.string()
					.min(1)
					.max(10_000)
					.refine((value) => Boolean(value.trim())),
				captureId: z.uuid(),
			})
			.strict(),
	)
	.output(z.object({ id: z.string() }))
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		try {
			await enforceMediaRateLimit(context.user.id, "media:reference-prompt");
			return await saveReferencePromptRecord({ ...input, ownerId: context.user.id }, db);
		} catch (error) {
			throw toMediaOrpcError(error);
		}
	});
