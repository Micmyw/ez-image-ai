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

export const PaymentCheckoutIntentStatus = {
	CREATED: "CREATED",
	PROVIDER_PENDING: "PROVIDER_PENDING",
	COMPLETED: "COMPLETED",
	EXPIRED: "EXPIRED",
	CANCELED: "CANCELED",
	REVIEW: "REVIEW",
} as const;

export type PaymentCheckoutIntentStatus =
	(typeof PaymentCheckoutIntentStatus)[keyof typeof PaymentCheckoutIntentStatus];

export const PaymentProductKind = {
	PLAN: "PLAN",
	CREDIT_PACK: "CREDIT_PACK",
} as const;

export type PaymentProductKind = (typeof PaymentProductKind)[keyof typeof PaymentProductKind];

export const CreditPackFulfillmentStatus = {
	FULFILLED: "FULFILLED",
	PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED",
	REFUNDED: "REFUNDED",
} as const;

export type CreditPackFulfillmentStatus =
	(typeof CreditPackFulfillmentStatus)[keyof typeof CreditPackFulfillmentStatus];

export const CreditPackAdjustmentStatus = {
	PENDING: "PENDING",
	REQUIRES_ACTION: "REQUIRES_ACTION",
	SUCCEEDED: "SUCCEEDED",
	FAILED: "FAILED",
	CANCELED: "CANCELED",
} as const;

export type CreditPackAdjustmentStatus =
	(typeof CreditPackAdjustmentStatus)[keyof typeof CreditPackAdjustmentStatus];
