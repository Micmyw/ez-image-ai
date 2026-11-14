import { ORPCError } from "@orpc/server";
import {
	executeAdminContentCleanup,
	listRecentAdminContentCleanupPlans,
	previewAdminContentCleanup,
} from "@repo/database";
import { db } from "@repo/database/client";
import { z } from "zod";

import { adminProcedure } from "../../../orpc/procedures";
import {
	adminCleanupExecuteInputSchema,
	adminCleanupExecuteOutputSchema,
	adminCleanupPreviewInputSchema,
	adminCleanupPreviewOutputSchema,
} from "../admin-content-cleanup-types";

const privateAdminProcedure = adminProcedure.use(({ context, next }) => {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	return next();
});
function mapError(error: unknown): never {
	if (error instanceof Error && error.message.startsWith("ADMIN_CLEANUP_")) {
		throw new ORPCError("CONFLICT", { message: error.message });
	}
	throw error;
}
export const adminContentCleanupPreview = privateAdminProcedure
	.route({
		method: "POST",
		path: "/admin/media/content-cleanup/preview",
		tags: ["Admin", "Media"],
		summary: "Preview selected image and expired internal telemetry cleanup",
	})
	.input(adminCleanupPreviewInputSchema)
	.output(adminCleanupPreviewOutputSchema)
	.handler(async ({ input, context: { user } }) => {
		try {
			return await previewAdminContentCleanup(input, user.id, db);
		} catch (error) {
			return mapError(error);
		}
	});
export const adminContentCleanupExecute = privateAdminProcedure
	.route({
		method: "POST",
		path: "/admin/media/content-cleanup/execute",
		tags: ["Admin", "Media"],
		summary: "Confirm an exact administrator cleanup plan",
	})
	.input(adminCleanupExecuteInputSchema)
	.output(adminCleanupExecuteOutputSchema)
	.handler(async ({ input, context: { user } }) => {
		try {
			return await executeAdminContentCleanup(input, user.id, db);
		} catch (error) {
			return mapError(error);
		}
	});

export const adminContentCleanupRecent = privateAdminProcedure
	.route({
		method: "GET",
		path: "/admin/media/content-cleanup/recent",
		tags: ["Admin", "Media"],
		summary: "Restore this administrator's five recent confirmed cleanup plans",
	})
	.input(z.object({}).strict())
	.output(z.array(adminCleanupPreviewOutputSchema).max(5))
	.handler(({ context: { user } }) => listRecentAdminContentCleanupPlans(user.id, db));
