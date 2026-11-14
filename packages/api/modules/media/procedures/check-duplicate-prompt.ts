import { findRecentGenerationPromptMatch } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const checkDuplicatePrompt = protectedProcedure
	.route({
		method: "POST",
		path: "/media/prompt-match",
		tags: ["Media"],
		summary: "Check for a recently submitted image prompt",
		description:
			"Returns only a matching task ID from the signed-in account's last 20 image tasks.",
	})
	.input(z.object({ prompt: z.string().trim().min(1).max(10_000) }))
	.output(z.object({ match: z.object({ jobId: z.string() }).nullable() }))
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		return {
			match: await findRecentGenerationPromptMatch(
				{ ownerId: context.user.id, prompt: input.prompt },
				db,
			),
		};
	});
