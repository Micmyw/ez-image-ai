import { NotificationSchema } from "@repo/database";
import { resolveNotificationLink, listNotificationRowsForUser } from "@repo/notifications";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const listNotifications = protectedProcedure
	.route({
		method: "GET",
		path: "/notifications",
		tags: ["Notifications"],
		summary: "List notifications",
		description: "Returns recent notifications for the current user",
	})
	.input(
		z.object({
			take: z.number().int().min(1).max(100).optional(),
		}),
	)
	.output(z.array(NotificationSchema))
	.handler(async ({ input: { take }, context: { user } }) => {
		const rows = await listNotificationRowsForUser(user.id, take ?? 50);
		return rows.map((row) => ({
			...row,
			link: resolveNotificationLink(row.link),
		}));
	});
