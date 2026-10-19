import { ORPCError } from "@orpc/server";
import { getAccountInputCopyStatus as getCopyStatus } from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";
import {
	accountInputCopyStatusSchema,
	publicAccountInputCopyStatus,
} from "../lib/account-input-copy-status";

export const getAccountInputCopyStatus = protectedProcedure
	.route({ method: "GET", path: "/media/drafts/{draftId}/input-copy", tags: ["Media"] })
	.input(z.object({ draftId: z.string().min(1).max(128) }).strict())
	.output(accountInputCopyStatusSchema)
	.handler(async ({ context, input }) => {
		context.responseHeaders?.set("Cache-Control", "private, no-store");
		const status = await getCopyStatus({ ownerId: context.user.id, draftId: input.draftId }, db);
		if (!status) throw new ORPCError("NOT_FOUND");
		return publicAccountInputCopyStatus(status);
	});
