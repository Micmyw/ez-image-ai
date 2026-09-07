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
		productKind: mysqlEnum("productKind", ["PLAN", "CREDIT_PACK"]).default("PLAN").notNull(),
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
		check(
			"purchase_credit_pack_shape",
			sql`${table.productKind} = 'PLAN' OR (${table.provider} IN ('paypal', 'waffo') AND ${table.type} = 'ONE_TIME' AND ${table.subscriptionId} IS NULL)`,
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
		productKind: mysqlEnum("productKind", ["PLAN", "CREDIT_PACK"]).default("PLAN").notNull(),
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
		check(
			"billing_plan_credit_pack_provider",
			sql`${table.productKind} = 'PLAN' OR ${table.provider} IN ('paypal', 'waffo')`,
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
		productKind: mysqlEnum("productKind", ["PLAN", "CREDIT_PACK"]).default("PLAN").notNull(),
		billingPlanId: varchar("billingPlanId", { length: 255 })
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		planKey: varchar("planKey", { length: 64 }).notNull(),
		interval: varchar("interval", { length: 16 }).notNull(),
		idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
		providerSessionId: varchar("providerSessionId", { length: 255 }),
		providerOrderId: varchar("providerOrderId", { length: 255 }),
		providerCheckoutUrl: text("providerCheckoutUrl"),
		activeScopeKey: varchar("activeScopeKey", { length: 768 }),
		creditPackCatalogVersion: varchar("creditPackCatalogVersion", { length: 255 }),
		creditPackPricingVersion: varchar("creditPackPricingVersion", { length: 255 }),
		creditPackSubscriberEligibilityVersion: varchar("creditPackSubscriberEligibilityVersion", {
			length: 255,
		}),
		creditPackBaseCredits: bigint("creditPackBaseCredits", { mode: "bigint" }),
		creditPackBonusCredits: bigint("creditPackBonusCredits", { mode: "bigint" }),
		creditPackTotalCredits: bigint("creditPackTotalCredits", { mode: "bigint" }),
		creditPackExpiryMonths: int("creditPackExpiryMonths"),
		creditPackSubscriberBonusEligible: boolean("creditPackSubscriberBonusEligible"),
		creditPackSubscriberSubscriptionId: varchar("creditPackSubscriberSubscriptionId", {
			length: 255,
		}),
		creditPackSubscriberPlanKey: varchar("creditPackSubscriberPlanKey", { length: 64 }),
		creditPackEligibilityEvaluatedAt: timestamp("creditPackEligibilityEvaluatedAt"),
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
		uniqueIndex("payment_checkout_intent_provider_order_uidx").on(
			table.provider,
			table.providerOrderId,
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
		check(
			"payment_checkout_intent_credit_pack_snapshot",
			sql`(${table.productKind} = 'PLAN' AND ${table.creditPackCatalogVersion} IS NULL AND ${table.creditPackPricingVersion} IS NULL AND ${table.creditPackSubscriberEligibilityVersion} IS NULL AND ${table.creditPackBaseCredits} IS NULL AND ${table.creditPackBonusCredits} IS NULL AND ${table.creditPackTotalCredits} IS NULL AND ${table.creditPackExpiryMonths} IS NULL AND ${table.creditPackSubscriberBonusEligible} IS NULL AND ${table.creditPackSubscriberSubscriptionId} IS NULL AND ${table.creditPackSubscriberPlanKey} IS NULL AND ${table.creditPackEligibilityEvaluatedAt} IS NULL) OR (${table.productKind} = 'CREDIT_PACK' AND ${table.provider} IN ('paypal', 'waffo') AND ${table.interval} = 'one-time' AND NULLIF(${table.creditPackCatalogVersion}, '') IS NOT NULL AND NULLIF(${table.creditPackPricingVersion}, '') IS NOT NULL AND NULLIF(${table.creditPackSubscriberEligibilityVersion}, '') IS NOT NULL AND ${table.creditPackBaseCredits} > 0 AND ${table.creditPackBonusCredits} >= 0 AND ${table.creditPackTotalCredits} = ${table.creditPackBaseCredits} + ${table.creditPackBonusCredits} AND ${table.creditPackExpiryMonths} = 6 AND ${table.creditPackSubscriberBonusEligible} IS NOT NULL AND ${table.creditPackEligibilityEvaluatedAt} IS NOT NULL AND ((${table.creditPackSubscriberBonusEligible} = false AND ${table.creditPackBonusCredits} = 0 AND ${table.creditPackSubscriberSubscriptionId} IS NULL AND ${table.creditPackSubscriberPlanKey} IS NULL) OR (${table.creditPackSubscriberBonusEligible} = true AND ${table.creditPackBonusCredits} > 0 AND NULLIF(${table.creditPackSubscriberSubscriptionId}, '') IS NOT NULL AND NULLIF(${table.creditPackSubscriberPlanKey}, '') IS NOT NULL)))`,
		),
	],
);

export const paymentCheckoutIntentIdempotencyAlias = mysqlTable(
	"payment_checkout_intent_idempotency_alias",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: mysqlEnum("ownerType", ["USER", "ORGANIZATION"]).notNull(),
		ownerId: varchar("ownerId", { length: 255 }).notNull(),
		idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
		checkoutIntentId: varchar("checkoutIntentId", { length: 255 })
			.notNull()
			.references(() => paymentCheckoutIntent.id, { onDelete: "cascade" }),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("payment_checkout_intent_alias_owner_idempotency_uidx").on(
			table.ownerType,
			table.ownerId,
			table.idempotencyKey,
		),
		index("payment_checkout_intent_alias_checkoutIntentId_idx").on(table.checkoutIntentId),
	],
);

export const creditPackFulfillment = mysqlTable(
	"credit_pack_fulfillment",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		purchaseId: varchar("purchaseId", { length: 255 }).references(() => purchase.id, {
			onDelete: "set null",
		}),
		checkoutIntentId: varchar("checkoutIntentId", { length: 255 })
			.notNull()
			.references(() => paymentCheckoutIntent.id, { onDelete: "restrict" }),
		billingPlanId: varchar("billingPlanId", { length: 255 })
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		ownerType: mysqlEnum("ownerType", ["USER", "ORGANIZATION"]).notNull(),
		ownerId: varchar("ownerId", { length: 255 }).notNull(),
		provider: varchar("provider", { length: 64 }).notNull(),
		providerOrderId: varchar("providerOrderId", { length: 255 }).notNull(),
		providerPaymentId: varchar("providerPaymentId", { length: 255 }).notNull(),
		paidAmountMicros: bigint("paidAmountMicros", { mode: "bigint" }).notNull(),
		currency: varchar("currency", { length: 16 }).notNull(),
		baseCredits: bigint("baseCredits", { mode: "bigint" }).notNull(),
		bonusCredits: bigint("bonusCredits", { mode: "bigint" }).notNull(),
		grantedCredits: bigint("grantedCredits", { mode: "bigint" }).notNull(),
		refundedAmountMicros: bigint("refundedAmountMicros", { mode: "bigint" }).default(0n).notNull(),
		refundedCredits: bigint("refundedCredits", { mode: "bigint" }).default(0n).notNull(),
		grantReferenceKey: varchar("grantReferenceKey", { length: 255 }).notNull(),
		paidAt: timestamp("paidAt").notNull(),
		expiresAt: timestamp("expiresAt").notNull(),
		status: mysqlEnum("status", ["FULFILLED", "PARTIALLY_REFUNDED", "REFUNDED"])
			.default("FULFILLED")
			.notNull(),
		fulfilledAt: timestamp("fulfilledAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("credit_pack_fulfillment_purchaseId_uidx").on(table.purchaseId),
		uniqueIndex("credit_pack_fulfillment_checkoutIntentId_uidx").on(table.checkoutIntentId),
		uniqueIndex("credit_pack_fulfillment_provider_payment_uidx").on(
			table.provider,
			table.providerPaymentId,
		),
		uniqueIndex("credit_pack_fulfillment_grantReferenceKey_uidx").on(table.grantReferenceKey),
		uniqueIndex("credit_pack_fulfillment_provider_order_uidx").on(
			table.provider,
			table.providerOrderId,
		),
		index("credit_pack_fulfillment_owner_fulfilled_idx").on(
			table.ownerType,
			table.ownerId,
			table.fulfilledAt,
			table.id,
		),
		index("credit_pack_fulfillment_status_fulfilled_idx").on(table.status, table.fulfilledAt),
		index("credit_pack_fulfillment_expiresAt_idx").on(table.expiresAt),
		check(
			"credit_pack_fulfillment_values",
			sql`${table.provider} IN ('paypal', 'waffo') AND ${table.paidAmountMicros} > 0 AND ${table.baseCredits} > 0 AND ${table.bonusCredits} >= 0 AND ${table.grantedCredits} = ${table.baseCredits} + ${table.bonusCredits} AND ${table.refundedAmountMicros} >= 0 AND ${table.refundedAmountMicros} <= ${table.paidAmountMicros} AND ${table.refundedCredits} >= 0 AND ${table.refundedCredits} <= ${table.grantedCredits} AND ${table.expiresAt} > ${table.paidAt}`,
		),
		check(
			"credit_pack_fulfillment_status_totals",
			sql`(${table.status} = 'FULFILLED' AND ${table.refundedAmountMicros} = 0) OR (${table.status} = 'PARTIALLY_REFUNDED' AND ${table.refundedAmountMicros} > 0 AND ${table.refundedAmountMicros} < ${table.paidAmountMicros}) OR (${table.status} = 'REFUNDED' AND ${table.refundedAmountMicros} = ${table.paidAmountMicros})`,
		),
	],
);

export const creditPackAdjustment = mysqlTable(
	"credit_pack_adjustment",
	{
		id: varchar("id", { length: 255 })
			.$defaultFn(() => cuid())
			.primaryKey(),
		fulfillmentId: varchar("fulfillmentId", { length: 255 })
			.notNull()
			.references(() => creditPackFulfillment.id, { onDelete: "restrict" }),
		provider: varchar("provider", { length: 64 }).notNull(),
		providerAdjustmentId: varchar("providerAdjustmentId", { length: 255 }).notNull(),
		amountMicros: bigint("amountMicros", { mode: "bigint" }).notNull(),
		currency: varchar("currency", { length: 16 }).notNull(),
		status: mysqlEnum("status", [
			"PENDING",
			"REQUIRES_ACTION",
			"SUCCEEDED",
			"FAILED",
			"CANCELED",
		]).notNull(),
		providerCreatedAt: timestamp("providerCreatedAt").notNull(),
		lastProviderChangeAt: timestamp("lastProviderChangeAt").notNull(),
		lastProviderChangeId: varchar("lastProviderChangeId", { length: 255 }).notNull(),
		finalizedCredits: bigint("finalizedCredits", { mode: "bigint" }).default(0n).notNull(),
		creditsFinalizedAt: timestamp("creditsFinalizedAt"),
		refundReferenceKey: varchar("refundReferenceKey", { length: 255 }),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
	},
	(table) => [
		uniqueIndex("credit_pack_adjustment_provider_id_uidx").on(
			table.provider,
			table.providerAdjustmentId,
		),
		uniqueIndex("credit_pack_adjustment_refundReferenceKey_uidx").on(table.refundReferenceKey),
		index("credit_pack_adjustment_fulfillment_status_idx").on(table.fulfillmentId, table.status),
		index("credit_pack_adjustment_status_finalized_idx").on(table.status, table.creditsFinalizedAt),
		check(
			"credit_pack_adjustment_values",
			sql`${table.provider} IN ('paypal', 'waffo') AND ${table.amountMicros} > 0 AND ${table.finalizedCredits} >= 0 AND ((${table.status} = 'SUCCEEDED' AND ((${table.creditsFinalizedAt} IS NULL AND ${table.finalizedCredits} = 0 AND ${table.refundReferenceKey} IS NULL) OR (${table.creditsFinalizedAt} IS NOT NULL AND ${table.refundReferenceKey} IS NOT NULL))) OR (${table.status} <> 'SUCCEEDED' AND ${table.creditsFinalizedAt} IS NULL AND ${table.finalizedCredits} = 0 AND ${table.refundReferenceKey} IS NULL))`,
		),
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
	creditPackFulfillment: one(creditPackFulfillment),
}));

export const billingPlanRelations = relations(billingPlan, ({ many }) => ({
	subscriptions: many(subscription),
	checkoutIntents: many(paymentCheckoutIntent),
	creditPackFulfillments: many(creditPackFulfillment),
}));

export const paymentCheckoutIntentRelations = relations(paymentCheckoutIntent, ({ one, many }) => ({
	billingPlan: one(billingPlan, {
		fields: [paymentCheckoutIntent.billingPlanId],
		references: [billingPlan.id],
	}),
	creditPackFulfillment: one(creditPackFulfillment),
	idempotencyAliases: many(paymentCheckoutIntentIdempotencyAlias),
}));

export const paymentCheckoutIntentIdempotencyAliasRelations = relations(
	paymentCheckoutIntentIdempotencyAlias,
	({ one }) => ({
		checkoutIntent: one(paymentCheckoutIntent, {
			fields: [paymentCheckoutIntentIdempotencyAlias.checkoutIntentId],
			references: [paymentCheckoutIntent.id],
		}),
	}),
);

export const creditPackFulfillmentRelations = relations(creditPackFulfillment, ({ one, many }) => ({
	purchase: one(purchase, {
		fields: [creditPackFulfillment.purchaseId],
		references: [purchase.id],
	}),
	checkoutIntent: one(paymentCheckoutIntent, {
		fields: [creditPackFulfillment.checkoutIntentId],
		references: [paymentCheckoutIntent.id],
	}),
	billingPlan: one(billingPlan, {
		fields: [creditPackFulfillment.billingPlanId],
		references: [billingPlan.id],
	}),
	adjustments: many(creditPackAdjustment),
}));

export const creditPackAdjustmentRelations = relations(creditPackAdjustment, ({ one }) => ({
	fulfillment: one(creditPackFulfillment, {
		fields: [creditPackAdjustment.fulfillmentId],
		references: [creditPackFulfillment.id],
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
