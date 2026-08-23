import { db } from "../client";
import type { NotificationTarget, NotificationType, Prisma } from "../generated/client";

export async function getDisabledNotificationPreferences(userId: string) {
	return db.userNotificationPreference.findMany({
		where: { userId },
		select: { type: true, target: true },
	});
}

export async function isNotificationDisabled(
	userId: string,
	type: NotificationType,
	target: NotificationTarget,
) {
	const row = await db.userNotificationPreference.findUnique({
		where: {
			userId_type_target: { userId, type, target },
		},
	});
	return Boolean(row);
}

export async function setNotificationDisabled(
	userId: string,
	type: NotificationType,
	target: NotificationTarget,
	disabled: boolean,
) {
	if (disabled) {
		await db.userNotificationPreference.upsert({
			where: {
				userId_type_target: { userId, type, target },
			},
			create: { userId, type, target },
			update: {},
		});
	} else {
		await db.userNotificationPreference.deleteMany({
			where: { userId, type, target },
		});
	}
}

export async function insertNotification(input: {
	userId: string;
	type: NotificationType;
	data: unknown;
	link: string | null;
	read: boolean;
}) {
	return db.notification.create({
		data: {
			userId: input.userId,
			type: input.type,
			data: (input.data ?? {}) as Prisma.InputJsonValue,
			link: input.link,
			read: input.read,
		},
	});
}

export async function getUserEmailLocaleForNotifications(userId: string) {
	return db.user.findUnique({
		where: { id: userId },
		select: { email: true, locale: true },
	});
}

export async function markNotificationAsRead(userId: string, notificationId: string) {
	return db.notification.updateMany({
		where: { id: notificationId, userId },
		data: { read: true },
	});
}

export async function markNotificationsAsRead(userId: string, ids: string[]) {
	if (ids.length === 0) {
		return { count: 0 };
	}
	return db.notification.updateMany({
		where: { userId, id: { in: ids } },
		data: { read: true },
	});
}

export async function markAllNotificationsAsReadForUser(userId: string) {
	return db.notification.updateMany({
		where: { userId, read: false },
		data: { read: true },
	});
}

export async function listNotificationRowsForUser(userId: string, take: number) {
	return db.notification.findMany({
		where: { userId },
		orderBy: { createdAt: "desc" },
		take,
	});
}

export async function countUnreadNotificationsForUser(userId: string) {
	return db.notification.count({
		where: { userId, read: false },
	});
}
