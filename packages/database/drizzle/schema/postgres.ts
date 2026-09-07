import { createId as cuid } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const purchaseTypeEnum = pgEnum("PurchaseType", ["SUBSCRIPTION", "ONE_TIME"]);

export const paymentProductKindEnum = pgEnum("PaymentProductKind", ["PLAN", "CREDIT_PACK"]);

export const ownerTypeEnum = pgEnum("OwnerType", ["USER", "ORGANIZATION"]);

export const subscriptionStatusEnum = pgEnum("SubscriptionStatus", [
	"PENDING",
	"ACTIVE",
	"PAST_DUE",
	"CANCELED",
	"EXPIRED",
]);

export const paymentCheckoutIntentStatusEnum = pgEnum("PaymentCheckoutIntentStatus", [
	"CREATED",
	"PROVIDER_CREATING",
	"PROVIDER_PENDING",
	"COMPLETED",
	"EXPIRED",
	"CANCELED",
	"REVIEW",
]);

export const creditPackFulfillmentStatusEnum = pgEnum("CreditPackFulfillmentStatus", [
	"FULFILLED",
	"PARTIALLY_REFUNDED",
	"REFUNDED",
]);

export const creditPackAdjustmentStatusEnum = pgEnum("CreditPackAdjustmentStatus", [
	"PENDING",
	"REQUIRES_ACTION",
	"SUCCEEDED",
	"FAILED",
	"CANCELED",
]);

export const notificationTypeEnum = pgEnum("NotificationType", ["WELCOME", "APP_UPDATE"]);

export const notificationTargetEnum = pgEnum("NotificationTarget", ["IN_APP", "EMAIL"]);

export const user = pgTable("user", {
	id: text("id")
		.$defaultFn(() => cuid())
		.primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("emailVerified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("createdAt").defaultNow().notNull(),
	updatedAt: timestamp("updatedAt")
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
	role: text("role"),
	banned: boolean("banned").default(false),
	banReason: text("banReason"),
	banExpires: timestamp("banExpires"),
	twoFactorEnabled: boolean("twoFactorEnabled").default(false),
	onboardingComplete: boolean("onboardingComplete"),
	paymentsCustomerId: text("paymentsCustomerId"),
	locale: text("locale"),
	lastActiveOrganizationId: text("lastActiveOrganizationId"),
	isAnonymous: boolean("isAnonymous").default(false).notNull(),
});

export const session = pgTable(
	"session",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		expiresAt: timestamp("expiresAt").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		impersonatedBy: text("impersonatedBy"),
		activeOrganizationId: text("activeOrganizationId"),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text("id")
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
		accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
		refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
	"verification",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expiresAt").notNull(),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkey = pgTable(
	"passkey",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		name: text("name"),
		publicKey: text("publicKey").notNull(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		credentialID: text("credentialID").notNull(),
		counter: integer("counter").notNull(),
		deviceType: text("deviceType").notNull(),
		backedUp: boolean("backedUp").notNull(),
		transports: text("transports"),
		createdAt: timestamp("createdAt"),
		aaguid: text("aaguid"),
	},
	(table) => [
		index("passkey_userId_idx").on(table.userId),
		index("passkey_credentialID_idx").on(table.credentialID),
	],
);

export const organization = pgTable(
	"organization",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		createdAt: timestamp("createdAt").notNull(),
		metadata: text("metadata"),
		paymentsCustomerId: text("paymentsCustomerId"),
	},
	(table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
);

export const member = pgTable(
	"member",
	{
		id: text("id")
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
	(table) => [
		index("member_organizationId_idx").on(table.organizationId),
		index("member_userId_idx").on(table.userId),
	],
);

export const invitation = pgTable(
	"invitation",
	{
		id: text("id")
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

export const twoFactor = pgTable(
	"twoFactor",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		secret: text("secret").notNull(),
		backupCodes: text("backupCodes").notNull(),
		verified: boolean("verified").default(false).notNull(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		failedVerificationCount: integer("failedVerificationCount").default(0),
		lockedUntil: timestamp("lockedUntil"),
	},
	(table) => [
		index("twoFactor_secret_idx").on(table.secret),
		index("twoFactor_userId_idx").on(table.userId),
	],
);

export const purchase = pgTable(
	"purchase",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		organizationId: text("organizationId").references(() => organization.id, {
			onDelete: "cascade",
		}),
		userId: text("userId").references(() => user.id, {
			onDelete: "cascade",
		}),
		type: purchaseTypeEnum("type").notNull(),
		productKind: paymentProductKindEnum("productKind").default("PLAN").notNull(),
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
			sql`num_nonnulls(${table.organizationId}, ${table.userId}) = 1`,
		),
		check(
			"purchase_credit_pack_shape",
			sql`${table.productKind} = 'PLAN' OR (${table.provider} IN ('paypal', 'waffo') AND ${table.type} = 'ONE_TIME' AND ${table.subscriptionId} IS NULL)`,
		),
	],
);

export const billingPlan = pgTable(
	"billing_plan",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		providerPriceId: text("providerPriceId").notNull(),
		productKind: paymentProductKindEnum("productKind").default("PLAN").notNull(),
		name: text("name").notNull(),
		creditsPerPeriod: bigint("creditsPerPeriod", { mode: "bigint" }).notNull(),
		priceMicros: bigint("priceMicros", { mode: "bigint" }).notNull(),
		currency: text("currency").notNull(),
		active: boolean("active").default(true).notNull(),
		version: integer("version").default(1).notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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

export const subscription = pgTable(
	"subscription",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: ownerTypeEnum("ownerType").notNull(),
		ownerId: text("ownerId").notNull(),
		provider: text("provider").notNull(),
		providerSubscriptionId: text("providerSubscriptionId").notNull(),
		planId: text("planId")
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		purchaseId: text("purchaseId").references(() => purchase.id, { onDelete: "set null" }),
		status: subscriptionStatusEnum("status").notNull(),
		currentPeriodStart: timestamp("currentPeriodStart", { withTimezone: true }),
		currentPeriodEnd: timestamp("currentPeriodEnd", { withTimezone: true }),
		cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false).notNull(),
		scheduledPlanId: text("scheduledPlanId"),
		lastProviderEventAt: timestamp("lastProviderEventAt", { withTimezone: true }),
		lastProviderEventId: text("lastProviderEventId"),
		lastReconciliationSweepId: text("lastReconciliationSweepId"),
		lastReconciliationAppliedSweepId: text("lastReconciliationAppliedSweepId"),
		lastReconciledAt: timestamp("lastReconciledAt", { withTimezone: true }),
		graceEndsAt: timestamp("graceEndsAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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

export const paymentCustomer = pgTable(
	"payment_customer",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		ownerType: ownerTypeEnum("ownerType").notNull(),
		ownerId: text("ownerId").notNull(),
		providerCustomerId: text("providerCustomerId").notNull(),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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

export const paymentCheckoutIntent = pgTable(
	"payment_checkout_intent",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		ownerType: ownerTypeEnum("ownerType").notNull(),
		ownerId: text("ownerId").notNull(),
		submittedByUserId: text("submittedByUserId").notNull(),
		productKind: paymentProductKindEnum("productKind").default("PLAN").notNull(),
		billingPlanId: text("billingPlanId")
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		planKey: text("planKey").notNull(),
		interval: text("interval").notNull(),
		idempotencyKey: text("idempotencyKey").notNull(),
		providerSessionId: text("providerSessionId"),
		providerOrderId: text("providerOrderId"),
		providerCheckoutUrl: text("providerCheckoutUrl"),
		activeScopeKey: text("activeScopeKey"),
		creditPackCatalogVersion: text("creditPackCatalogVersion"),
		creditPackPricingVersion: text("creditPackPricingVersion"),
		creditPackSubscriberEligibilityVersion: text("creditPackSubscriberEligibilityVersion"),
		creditPackBaseCredits: bigint("creditPackBaseCredits", { mode: "bigint" }),
		creditPackBonusCredits: bigint("creditPackBonusCredits", { mode: "bigint" }),
		creditPackTotalCredits: bigint("creditPackTotalCredits", { mode: "bigint" }),
		creditPackExpiryMonths: integer("creditPackExpiryMonths"),
		creditPackSubscriberBonusEligible: boolean("creditPackSubscriberBonusEligible"),
		creditPackSubscriberSubscriptionId: text("creditPackSubscriberSubscriptionId"),
		creditPackSubscriberPlanKey: text("creditPackSubscriberPlanKey"),
		creditPackEligibilityEvaluatedAt: timestamp("creditPackEligibilityEvaluatedAt", {
			withTimezone: true,
		}),
		status: paymentCheckoutIntentStatusEnum("status").default("CREATED").notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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
			sql`(
				${table.productKind} = 'PLAN'
				AND ${table.creditPackCatalogVersion} IS NULL
				AND ${table.creditPackPricingVersion} IS NULL
				AND ${table.creditPackSubscriberEligibilityVersion} IS NULL
				AND ${table.creditPackBaseCredits} IS NULL
				AND ${table.creditPackBonusCredits} IS NULL
				AND ${table.creditPackTotalCredits} IS NULL
				AND ${table.creditPackExpiryMonths} IS NULL
				AND ${table.creditPackSubscriberBonusEligible} IS NULL
				AND ${table.creditPackSubscriberSubscriptionId} IS NULL
				AND ${table.creditPackSubscriberPlanKey} IS NULL
				AND ${table.creditPackEligibilityEvaluatedAt} IS NULL
				) OR (
					${table.productKind} = 'CREDIT_PACK'
					AND ${table.provider} IN ('paypal', 'waffo')
					AND ${table.interval} = 'one-time'
				AND NULLIF(${table.creditPackCatalogVersion}, '') IS NOT NULL
				AND NULLIF(${table.creditPackPricingVersion}, '') IS NOT NULL
				AND NULLIF(${table.creditPackSubscriberEligibilityVersion}, '') IS NOT NULL
				AND ${table.creditPackBaseCredits} > 0
				AND ${table.creditPackBonusCredits} >= 0
				AND ${table.creditPackTotalCredits} = ${table.creditPackBaseCredits} + ${table.creditPackBonusCredits}
				AND ${table.creditPackExpiryMonths} = 6
				AND ${table.creditPackSubscriberBonusEligible} IS NOT NULL
				AND ${table.creditPackEligibilityEvaluatedAt} IS NOT NULL
				AND (
					(${table.creditPackSubscriberBonusEligible} = false AND ${table.creditPackBonusCredits} = 0 AND ${table.creditPackSubscriberSubscriptionId} IS NULL AND ${table.creditPackSubscriberPlanKey} IS NULL)
					OR
					(${table.creditPackSubscriberBonusEligible} = true AND ${table.creditPackBonusCredits} > 0 AND NULLIF(${table.creditPackSubscriberSubscriptionId}, '') IS NOT NULL AND NULLIF(${table.creditPackSubscriberPlanKey}, '') IS NOT NULL)
				)
			)`,
		),
	],
);

export const paymentCheckoutIntentIdempotencyAlias = pgTable(
	"payment_checkout_intent_idempotency_alias",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: ownerTypeEnum("ownerType").notNull(),
		ownerId: text("ownerId").notNull(),
		idempotencyKey: text("idempotencyKey").notNull(),
		checkoutIntentId: text("checkoutIntentId")
			.notNull()
			.references(() => paymentCheckoutIntent.id, { onDelete: "cascade" }),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
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

export const creditPackFulfillment = pgTable(
	"credit_pack_fulfillment",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		purchaseId: text("purchaseId").references(() => purchase.id, { onDelete: "set null" }),
		checkoutIntentId: text("checkoutIntentId")
			.notNull()
			.references(() => paymentCheckoutIntent.id, { onDelete: "restrict" }),
		billingPlanId: text("billingPlanId")
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		ownerType: ownerTypeEnum("ownerType").notNull(),
		ownerId: text("ownerId").notNull(),
		provider: text("provider").notNull(),
		providerOrderId: text("providerOrderId").notNull(),
		providerPaymentId: text("providerPaymentId").notNull(),
		paidAmountMicros: bigint("paidAmountMicros", { mode: "bigint" }).notNull(),
		currency: text("currency").notNull(),
		baseCredits: bigint("baseCredits", { mode: "bigint" }).notNull(),
		bonusCredits: bigint("bonusCredits", { mode: "bigint" }).notNull(),
		grantedCredits: bigint("grantedCredits", { mode: "bigint" }).notNull(),
		refundedAmountMicros: bigint("refundedAmountMicros", { mode: "bigint" }).default(0n).notNull(),
		refundedCredits: bigint("refundedCredits", { mode: "bigint" }).default(0n).notNull(),
		grantReferenceKey: text("grantReferenceKey").notNull(),
		paidAt: timestamp("paidAt", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
		status: creditPackFulfillmentStatusEnum("status").default("FULFILLED").notNull(),
		fulfilledAt: timestamp("fulfilledAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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

export const creditPackAdjustment = pgTable(
	"credit_pack_adjustment",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		fulfillmentId: text("fulfillmentId")
			.notNull()
			.references(() => creditPackFulfillment.id, { onDelete: "restrict" }),
		provider: text("provider").notNull(),
		providerAdjustmentId: text("providerAdjustmentId").notNull(),
		amountMicros: bigint("amountMicros", { mode: "bigint" }).notNull(),
		currency: text("currency").notNull(),
		status: creditPackAdjustmentStatusEnum("status").notNull(),
		providerCreatedAt: timestamp("providerCreatedAt", { withTimezone: true }).notNull(),
		lastProviderChangeAt: timestamp("lastProviderChangeAt", { withTimezone: true }).notNull(),
		lastProviderChangeId: text("lastProviderChangeId").notNull(),
		finalizedCredits: bigint("finalizedCredits", { mode: "bigint" }).default(0n).notNull(),
		creditsFinalizedAt: timestamp("creditsFinalizedAt", { withTimezone: true }),
		refundReferenceKey: text("refundReferenceKey"),
		createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
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

export const notification = pgTable(
	"notification",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: notificationTypeEnum("type").notNull(),
		data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
		link: text("link"),
		read: boolean("read").notNull().default(false),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("notification_userId_idx").on(table.userId)],
);

export const userNotificationPreference = pgTable(
	"user_notification_preference",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: notificationTypeEnum("type").notNull(),
		target: notificationTargetEnum("target").notNull(),
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

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	accounts: many(account),
	passkeys: many(passkey),
	members: many(member),
	invitations: many(invitation),
	twoFactors: many(twoFactor),
	purchases: many(purchase),
	notifications: many(notification),
	notificationPreferences: many(userNotificationPreference),
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

export const twoFactorRelations = relations(twoFactor, ({ one }) => ({
	user: one(user, {
		fields: [twoFactor.userId],
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
