export const NOTIFICATION_TYPES = {
	WELCOME: "WELCOME",
	APP_UPDATE: "APP_UPDATE",
	MODERATION_ALERT: "MODERATION_ALERT",
} as const;

export type { NotificationTarget, NotificationType } from "@repo/database";
