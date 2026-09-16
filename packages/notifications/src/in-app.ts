import {
	insertNotification,
	isNotificationDisabled,
	NotificationTarget,
	type NotificationType,
} from "@repo/database";

import { resolveNotificationLink } from "./resolve-link";

/** Shared preference-aware delivery used by site notifications and the jobs worker. */
export async function createInAppNotification(input: {
	userId: string;
	type: NotificationType;
	data?: unknown;
	link?: string | null;
	read?: boolean;
	deliveryId?: string;
}) {
	if (await isNotificationDisabled(input.userId, input.type, NotificationTarget.IN_APP))
		return null;
	return insertNotification({
		userId: input.userId,
		type: input.type,
		data: input.data ?? {},
		link: resolveNotificationLink(input.link),
		read: input.read ?? false,
		...(input.deliveryId ? { id: input.deliveryId } : {}),
	});
}
