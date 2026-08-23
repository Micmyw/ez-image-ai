import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../client";
import type { NotificationTarget, NotificationType } from "../schema";
import { notification, userNotificationPreference } from "../schema/postgres";

export async function getDisabledNotificationPreferences(userId: string) {
	return db
		.select({
			type: userNotificationPreference.type,
			target: userNotificationPreference.target,
		})
		.from(userNotificationPreference)
		.where(eq(userNotificationPreference.userId, userId));
}

export async function isNotificationDisabled(
	userId: string,
	type: NotificationType,
	target: NotificationTarget,
) {
	const row = await db.query.userNotificationPreference.findFirst({
		where: (pref, { eq, and }) =>
			and(eq(pref.userId, userId), eq(pref.type, type), eq(pref.target, target)),
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
		await db
			.insert(userNotificationPreference)
			.values({ userId, type, target })
			.onConflictDoNothing({
				target: [
					userNotificationPreference.userId,
					userNotificationPreference.type,
					userNotificationPreference.target,
				],
			});
	} else {
		await db
			.delete(userNotificationPreference)
			.where(
				and(
					eq(userNotificationPreference.userId, userId),
					eq(userNotificationPreference.type, type),
					eq(userNotificationPreference.target, target),
				),
			);
	}
}

function jsonObjectFromUnknown(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

export async function insertNotification(input: {
	userId: string;
	type: NotificationType;
	data: unknown;
	link: string | null;
	read: boolean;
}) {
	const [row] = await db
		.insert(notification)
		.values({
			userId: input.userId,
			type: input.type,
			data: jsonObjectFromUnknown(input.data),
			link: input.link,
			read: input.read,
		})
		.returning();
	return row ?? null;
}

export async function getUserEmailLocaleForNotifications(userId: string) {
	const row = await db.query.user.findFirst({
		where: (u, { eq }) => eq(u.id, userId),
		columns: { email: true, locale: true },
	});
	return row ?? null;
}

export async function markNotificationAsRead(userId: string, notificationId: string) {
	const rows = await db
		.update(notification)
		.set({ read: true })
		.where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
		.returning({ id: notification.id });
	return { count: rows.length };
}

export async function markNotificationsAsRead(userId: string, ids: string[]) {
	if (ids.length === 0) {
		return { count: 0 };
	}
	const rows = await db
		.update(notification)
		.set({ read: true })
		.where(and(eq(notification.userId, userId), inArray(notification.id, ids)))
		.returning({ id: notification.id });
	return { count: rows.length };
}

export async function markAllNotificationsAsReadForUser(userId: string) {
	const rows = await db
		.update(notification)
		.set({ read: true })
		.where(and(eq(notification.userId, userId), eq(notification.read, false)))
		.returning({ id: notification.id });
	return { count: rows.length };
}

export async function listNotificationRowsForUser(userId: string, take: number) {
	return db
		.select()
		.from(notification)
		.where(eq(notification.userId, userId))
		.orderBy(desc(notification.createdAt))
		.limit(take);
}

export async function countUnreadNotificationsForUser(userId: string) {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(notification)
		.where(and(eq(notification.userId, userId), eq(notification.read, false)));
	return row?.count ?? 0;
}
