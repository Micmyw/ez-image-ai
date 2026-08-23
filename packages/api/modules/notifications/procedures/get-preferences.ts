import { NotificationTargetSchema, NotificationTypeSchema } from "@repo/database";
import { getDisabledNotificationPreferences } from "@repo/notifications";
import { z } from "zod";

import { protectedProcedure } from "../../../orpc/procedures";

export const getPreferences = protectedProcedure
	.route({
		method: "GET",
		path: "/notifications/preferences",
		tags: ["Notifications"],
		summary: "Get notification preferences",
	})
	.output(
		z.object({
			disabled: z.array(
				z.object({
					type: NotificationTypeSchema,
					target: NotificationTargetSchema,
				}),
			),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const disabled = await getDisabledNotificationPreferences(user.id);
		return { disabled };
	});
