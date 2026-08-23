import { countUnreadNotificationsForUser } from "@repo/notifications";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const unreadCount = protectedProcedure
	.route({
		method: "GET",
		path: "/notifications/unread-count",
		tags: ["Notifications"],
		summary: "Unread notification count",
	})
	.output(
		z.object({
			count: z.number().int().nonnegative(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const count = await countUnreadNotificationsForUser(user.id);
		return { count };
	});
