import { ORPCError } from "@orpc/server";
import { getAdminPromptContent, listAdminPromptContent } from "@repo/database";
import { db } from "@repo/database/client";

import { adminProcedure } from "../../../orpc/procedures";
import {
	adminPromptDetailInputSchema,
	adminPromptDetailOutputSchema,
	adminPromptListInputSchema,
	adminPromptListOutputSchema,
} from "../admin-prompt-content-types";

const privateAdmin = adminProcedure.use(({ context, next }) => {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	return next();
});

export const adminPromptContentList = privateAdmin
	.route({
		method: "POST",
		path: "/admin/media/prompt-content/search",
		tags: ["Admin", "Media"],
		summary: "Find saved prompts and failed requests without requiring an asset",
		description:
			"Audited bounded task and blocked-prompt records. List results contain identifiers and status, not prompt text or provider payloads. Historical missing evidence remains missing.",
	})
	.input(adminPromptListInputSchema)
	.output(adminPromptListOutputSchema)
	.handler(async ({ input, context }) => {
		try {
			return await listAdminPromptContent(input, context.user.id, db);
		} catch (error) {
			if (error instanceof Error && error.message === "ADMIN_PROMPT_RANGE_INVALID")
				throw new ORPCError("BAD_REQUEST");
			throw error;
		}
	});

export const adminPromptContentDetail = privateAdmin
	.route({
		method: "GET",
		path: "/admin/media/prompt-content/{recordKind}/{id}",
		tags: ["Admin", "Media"],
		summary: "Inspect a persisted prompt, text review and model diagnostics",
		description:
			"Administrator-only audited detail with bounded redacted saved text, exact quote-linked text moderation evidence and persisted attempt messages with their actual provenance. Makes no provider request.",
	})
	.input(adminPromptDetailInputSchema)
	.output(adminPromptDetailOutputSchema)
	.handler(async ({ input, context }) => {
		try {
			return await getAdminPromptContent(input, context.user.id, db);
		} catch (error) {
			if (error instanceof Error && error.message === "ADMIN_PROMPT_CONTENT_NOT_FOUND")
				throw new ORPCError("NOT_FOUND");
			throw error;
		}
	});
