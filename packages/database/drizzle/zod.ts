import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";

import {
	account,
	billingPlan,
	invitation,
	member,
	notification,
	organization,
	passkey,
	paymentCheckoutIntent,
	paymentCustomer,
	purchase,
	session,
	user,
	userNotificationPreference,
	verification,
	subscription,
} from "./schema";

export const UserSchema = createSelectSchema(user);
export const UserUpdateSchema = createUpdateSchema(user, {
	id: z.string(),
});
export const OrganizationSchema = createSelectSchema(organization);
export const OrganizationUpdateSchema = createUpdateSchema(organization, {
	id: z.string(),
});
export const MemberSchema = createSelectSchema(member);
export const InvitationSchema = createSelectSchema(invitation);
export const PurchaseSchema = createSelectSchema(purchase);
export type Purchase = typeof purchase.$inferSelect;
export const PurchaseInsertSchema = createInsertSchema(purchase).superRefine((value, context) => {
	const ownerCount =
		Number(value.organizationId !== null && value.organizationId !== undefined) +
		Number(value.userId !== null && value.userId !== undefined);
	if (ownerCount !== 1) {
		context.addIssue({
			code: "custom",
			path: ["organizationId"],
			message: "A purchase must have exactly one owner",
		});
	}
});
export const PurchaseUpdateSchema = createUpdateSchema(purchase, {
	id: z.string(),
});
export const BillingPlanSchema = createSelectSchema(billingPlan);
export const SubscriptionSchema = createSelectSchema(subscription);
export const PaymentCustomerSchema = createSelectSchema(paymentCustomer);
export const PaymentCustomerInsertSchema = createInsertSchema(paymentCustomer);
export const PaymentCustomerUpdateSchema = createUpdateSchema(paymentCustomer, { id: z.string() });
export const PaymentCheckoutIntentSchema = createSelectSchema(paymentCheckoutIntent);
export const PaymentCheckoutIntentInsertSchema = createInsertSchema(paymentCheckoutIntent);
export const PaymentCheckoutIntentUpdateSchema = createUpdateSchema(paymentCheckoutIntent, {
	id: z.string(),
});
export const SessionSchema = createSelectSchema(session);
export const AccountSchema = createSelectSchema(account);
export const VerificationSchema = createSelectSchema(verification);
export const PasskeySchema = createSelectSchema(passkey);
export const NotificationSchema = createSelectSchema(notification);
export const NotificationInsertSchema = createInsertSchema(notification);
export const NotificationUpdateSchema = createUpdateSchema(notification, {
	id: z.string(),
});
export type Notification = typeof notification.$inferSelect;
export const UserNotificationPreferenceSchema = createSelectSchema(userNotificationPreference);
export const UserNotificationPreferenceInsertSchema = createInsertSchema(
	userNotificationPreference,
);
export const UserNotificationPreferenceUpdateSchema = createUpdateSchema(
	userNotificationPreference,
	{
		id: z.string(),
	},
);
export type UserNotificationPreference = typeof userNotificationPreference.$inferSelect;
