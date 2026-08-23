export * from "./postgres";

export const NotificationTarget = {
	IN_APP: "IN_APP",
	EMAIL: "EMAIL",
} as const;

export type NotificationTarget = (typeof NotificationTarget)[keyof typeof NotificationTarget];

export const NotificationType = {
	WELCOME: "WELCOME",
	APP_UPDATE: "APP_UPDATE",
} as const;

export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
