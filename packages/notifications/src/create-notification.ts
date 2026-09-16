import {
	getUserEmailLocaleForNotifications,
	isNotificationDisabled,
	NotificationTarget,
	type NotificationModel,
	type NotificationType,
} from "@repo/database";
import type { Locale } from "@repo/i18n";

import { createInAppNotification } from "./in-app";
import { resolveNotificationLink } from "./resolve-link";

export async function createNotification(input: {
	userId: string;
	type: NotificationType;
	data?: unknown;
	link?: string | null;
	read?: boolean;
	/** Explicit channel selection for operational alerts; preferences still apply. */
	channels?: readonly NotificationTarget[];
	/** Stable IN_APP delivery ID. Email is excluded for deduplicated operational delivery. */
	deliveryId?: string;
}) {
	const emailDisabled = await isNotificationDisabled(
		input.userId,
		input.type,
		NotificationTarget.EMAIL,
	);

	const absoluteLink = resolveNotificationLink(input.link);
	let created: NotificationModel | null = null;

	if (!input.channels || input.channels.includes(NotificationTarget.IN_APP)) {
		created = await createInAppNotification(input);
	}

	if (
		!emailDisabled &&
		!input.deliveryId &&
		(!input.channels || input.channels.includes(NotificationTarget.EMAIL))
	) {
		const userRow = await getUserEmailLocaleForNotifications(input.userId);

		if (userRow?.email) {
			const locale = (userRow.locale as Locale | null | undefined) ?? undefined;
			const dataObj =
				input.data &&
				typeof input.data === "object" &&
				input.data !== null &&
				!Array.isArray(input.data)
					? (input.data as Record<string, unknown>)
					: {};
			const title =
				typeof dataObj.headline === "string" && dataObj.headline.length > 0
					? dataObj.headline
					: typeof dataObj.title === "string" && dataObj.title.length > 0
						? dataObj.title
						: String(input.type);
			const message = typeof dataObj.message === "string" ? dataObj.message : undefined;

			const { sendEmail } = await import("@repo/mail");
			await sendEmail({
				to: userRow.email,
				locale,
				templateId: "notification",
				context: {
					title,
					message,
					link: absoluteLink ?? undefined,
				},
			});
		}
	}

	return created;
}
