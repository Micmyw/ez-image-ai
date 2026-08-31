import { createId as cuid } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	int,
	json,
	mysqlEnum,
	mysqlTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/mysql-core";

// Enums
export const purchaseTypeEnum = mysqlEnum("PurchaseType", ["SUBSCRIPTION", "ONE_TIME"]);

export const notificationTypeEnum = mysqlEnum("NotificationType", ["WELCOME", "APP_UPDATE"]);

export const notificationTargetEnum = mysqlEnum("NotificationTarget", ["IN_APP", "EMAIL"]);

// Tables
export const user = mysqlTable("user", {
	id: varchar("id", { length: 255 })
		.$defaultFn(() => cuid())
		.primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("emailVerified").notNull().default(false),
	image: text("image"),
	createdAt: timestamp("createdAt").notNull().defaultNow(),
	updatedAt: timestamp("updatedAt").notNull().defaultNow(),
	role: text("role"),
	banned: boolean("banned").default(false),
	twoFactorEnabled: boolean("twoFactorEnabled").default(false),
	banReason: text("banReason"),
	banExpires: timestamp("banExpires"),
	onboardingComplete: boolean("onboardingComplete").default(false).notNull(),
	paymentsCustomerId: text("paymentsCustomerId"),
	locale: text("locale"),
	lastActiveOrganizationId: text("lastActiveOrganizationId"),
	isAnonymous: boolean("isAnonymous").default(false).notNull(),
});

export const session = mysqlTable(
	"session",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		expiresAt: timestamp("expiresAt").notNull(),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		impersonatedBy: text("impersonatedBy"),
		activeOrganizationId: text("activeOrganizationId"),
		token: text("token").notNull(),
		createdAt: timestamp("createdAt").notNull(),
		updatedAt: timestamp("updatedAt").notNull(),
	},
	(table) => [uniqueIndex("session_token_idx").on(table.token)],
);

export const account = mysqlTable("account", {
	id: varchar("id", { length: 255 })
		.$defaultFn(() => cuid())
		.primaryKey(),
	accountId: text("accountId").notNull(),
	providerId: text("providerId").notNull(),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accessToken: text("accessToken"),
	refreshToken: text("refreshToken"),
	idToken: text("idToken"),
	expiresAt: timestamp("expiresAt"),
	password: text("password"),
	accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
	refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
	scope: text("scope"),
	createdAt: timestamp("createdAt").notNull(),
	updatedAt: timestamp("updatedAt").notNull(),
});

export const verification = mysqlTable("verification", {
	id: varchar("id", { length: 255 })
		.$defaultFn(() => cuid())
		.primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expiresAt").notNull(),
	createdAt: timestamp("createdAt"),
	updatedAt: timestamp("updatedAt"),
});

export const passkey = mysqlTable("passkey", {
	id: varchar("id", { length: 255 })
		.$defaultFn(() => cuid())
		.primaryKey(),
	name: text("name"),
	publicKey: text("publicKey").notNull(),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	credentialID: text("credentialID").notNull(),
	counter: int("counter").notNull(),
	deviceType: text("deviceType").notNull(),
	backedUp: boolean("backedUp").notNull(),
	transports: text("transports"),
	createdAt: timestamp("createdAt"),
	aaguid: text("aaguid"),
});

export const twoFactor = mysqlTable("twoFactor", {
	id: varchar("id", { length: 255 })
		.$defaultFn(() => cuid())
		.primaryKey(),
	secret: text("secret").notNull(),
	backupCodes: text("backupCodes").notNull(),
	verified: boolean("verified").default(false).notNull(),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	failedVerificationCount: int("failedVerificationCount").default(0),
	lockedUntil: timestamp("lockedUntil"),
});

export const organization = mysqlTable(
	"organization",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		createdAt: timestamp("createdAt").notNull(),
		metadata: text("metadata"),
		paymentsCustomerId: text("paymentsCustomerId"),
	},
	(table) => [uniqueIndex("organization_slug_idx").on(table.slug)],
);

export const member = mysqlTable(
	"member",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").default("member").notNull(),
		createdAt: timestamp("createdAt").notNull(),
	},
	(table) => [uniqueIndex("member_user_org_idx").on(table.userId, table.organizationId)],
);

export const invitation = mysqlTable(
	"invitation",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").default("pending").notNull(),
		expiresAt: timestamp("expiresAt").notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		inviterId: text("inviterId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitation_organizationId_idx").on(table.organizationId),
		index("invitation_email_idx").on(table.email),
	],
);

export const purchase = mysqlTable(
	"purchase",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		organizationId: text("organizationId").references(() => organization.id, {
			onDelete: "cascade",
		}),
		userId: text("userId").references(() => user.id, {
			onDelete: "cascade",
		}),
		type: purchaseTypeEnum.notNull(),
		provider: text("provider").default("stripe").notNull(),
		customerId: text("customerId").notNull(),
		subscriptionId: text("subscriptionId"),
		priceId: text("priceId").notNull(),
		status: text("status"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt"),
	},
	(table) => [
		uniqueIndex("purchase_provider_subscriptionId_uidx").on(table.provider, table.subscriptionId),
		index("purchase_subscriptionId_idx").on(table.subscriptionId),
		check(
			"purchase_exactly_one_owner",
			sql`(${table.organizationId} IS NOT NULL) <> (${table.userId} IS NOT NULL)`,
		),
	],
);

export const billingPlan = mysqlTable(
	"billing_plan",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: varchar("provider", { length: 64 }).notNull(),
		providerPriceId: varchar("providerPriceId", { length: 255 }).notNull(),
		name: text("name").notNull(),
		creditsPerPeriod: bigint("creditsPerPeriod", { mode: "bigint" }).notNull(),
		priceMicros: bigint("priceMicros", { mode: "bigint" }).notNull(),
		currency: varchar("currency", { length: 16 }).notNull(),
		active: boolean("active").default(true).notNull(),
		version: int("version").default(1).notNull(),
		metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("billing_plan_provider_providerPriceId_uidx").on(
			table.provider,
			table.providerPriceId,
		),
	],
);

export const subscription = mysqlTable(
	"subscription",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: mysqlEnum("ownerType", ["USER", "ORGANIZATION"]).notNull(),
		ownerId: varchar("ownerId", { length: 255 }).notNull(),
		provider: varchar("provider", { length: 64 }).notNull(),
		providerSubscriptionId: varchar("providerSubscriptionId", { length: 255 }).notNull(),
		planId: varchar("planId", { length: 255 })
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		purchaseId: varchar("purchaseId", { length: 255 }).references(() => purchase.id, {
			onDelete: "set null",
		}),
		status: mysqlEnum("status", ["PENDING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"]).notNull(),
		currentPeriodStart: timestamp("currentPeriodStart"),
		currentPeriodEnd: timestamp("currentPeriodEnd"),
		cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false).notNull(),
		scheduledPlanId: varchar("scheduledPlanId", { length: 255 }),
		lastProviderEventAt: timestamp("lastProviderEventAt"),
		lastProviderEventId: varchar("lastProviderEventId", { length: 255 }),
		lastReconciliationSweepId: varchar("lastReconciliationSweepId", { length: 255 }),
		lastReconciliationAppliedSweepId: varchar("lastReconciliationAppliedSweepId", {
			length: 255,
		}),
		lastReconciledAt: timestamp("lastReconciledAt"),
		graceEndsAt: timestamp("graceEndsAt"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("subscription_provider_providerSubscriptionId_uidx").on(
			table.provider,
			table.providerSubscriptionId,
		),
		uniqueIndex("subscription_purchaseId_uidx").on(table.purchaseId),
		index("subscription_owner_status_idx").on(table.ownerType, table.ownerId, table.status),
		index("subscription_provider_status_createdAt_idx").on(
			table.provider,
			table.status,
			table.createdAt,
		),
	],
);

export const paymentCustomer = mysqlTable(
	"payment_customer",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: varchar("provider", { length: 64 }).notNull(),
		ownerType: mysqlEnum("ownerType", ["USER", "ORGANIZATION"]).notNull(),
		ownerId: varchar("ownerId", { length: 255 }).notNull(),
		providerCustomerId: varchar("providerCustomerId", { length: 255 }).notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("payment_customer_provider_owner_uidx").on(
			table.provider,
			table.ownerType,
			table.ownerId,
		),
		index("payment_customer_provider_customer_idx").on(table.provider, table.providerCustomerId),
	],
);

export const paymentCheckoutIntent = mysqlTable(
	"payment_checkout_intent",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: varchar("provider", { length: 64 }).notNull(),
		ownerType: mysqlEnum("ownerType", ["USER", "ORGANIZATION"]).notNull(),
		ownerId: varchar("ownerId", { length: 255 }).notNull(),
		submittedByUserId: varchar("submittedByUserId", { length: 255 }).notNull(),
		billingPlanId: varchar("billingPlanId", { length: 255 })
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		planKey: varchar("planKey", { length: 64 }).notNull(),
		interval: varchar("interval", { length: 16 }).notNull(),
		idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
		providerSessionId: varchar("providerSessionId", { length: 255 }),
		providerCheckoutUrl: text("providerCheckoutUrl"),
		activeScopeKey: varchar("activeScopeKey", { length: 768 }),
		status: mysqlEnum("status", [
			"CREATED",
			"PROVIDER_CREATING",
			"PROVIDER_PENDING",
			"COMPLETED",
			"EXPIRED",
			"CANCELED",
			"REVIEW",
		])
			.default("CREATED")
			.notNull(),
		expiresAt: timestamp("expiresAt"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("payment_checkout_intent_owner_idempotency_uidx").on(
			table.ownerType,
			table.ownerId,
			table.idempotencyKey,
		),
		uniqueIndex("payment_checkout_intent_provider_session_uidx").on(
			table.provider,
			table.providerSessionId,
		),
		uniqueIndex("payment_checkout_intent_activeScopeKey_uidx").on(table.activeScopeKey),
		index("payment_checkout_intent_owner_plan_status_idx").on(
			table.ownerType,
			table.ownerId,
			table.planKey,
			table.interval,
			table.status,
		),
		index("payment_checkout_intent_expiry_status_idx").on(table.expiresAt, table.status),
	],
);

export const notification = mysqlTable(
	"notification",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: notificationTypeEnum.notNull(),
		data: json("data").$type<Record<string, unknown>>().notNull().default({}),
		link: text("link"),
		read: boolean("read").notNull().default(false),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
	},
	(table) => [index("notification_userId_idx").on(table.userId)],
);

export const userNotificationPreference = mysqlTable(
	"user_notification_preference",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: notificationTypeEnum.notNull(),
		target: notificationTargetEnum.notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
	},
	(table) => [
		index("user_notification_preference_userId_idx").on(table.userId),
		uniqueIndex("user_notification_preference_user_type_target_uidx").on(
			table.userId,
			table.type,
			table.target,
		),
	],
);

// Relations
export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	accounts: many(account),
	passkeys: many(passkey),
	members: many(member),
	invitations: many(invitation),
	twoFactors: many(twoFactor),

	purchases: many(purchase),
	memberships: many(member),
	notifications: many(notification),
	notificationPreferences: many(userNotificationPreference),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
	members: many(member),
	invitations: many(invitation),
	purchases: many(purchase),
}));

export const memberRelations = relations(member, ({ one }) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [member.userId],
		references: [user.id],
	}),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id],
	}),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
	user: one(user, {
		fields: [passkey.userId],
		references: [user.id],
	}),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [invitation.inviterId],
		references: [user.id],
	}),
}));

export const purchaseRelations = relations(purchase, ({ one }) => ({
	organization: one(organization, {
		fields: [purchase.organizationId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [purchase.userId],
		references: [user.id],
	}),
}));

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
	user: one(user, {
		fields: [twoFactor.userId],
		references: [user.id],
	}),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
	user: one(user, {
		fields: [notification.userId],
		references: [user.id],
	}),
}));

export const userNotificationPreferenceRelations = relations(
	userNotificationPreference,
	({ one }) => ({
		user: one(user, {
			fields: [userNotificationPreference.userId],
			references: [user.id],
		}),
	}),
);
