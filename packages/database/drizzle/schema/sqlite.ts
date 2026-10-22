import { createId as cuid } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
	check,
	customType,
	index,
	primaryKey,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const sqliteBigInt = customType<{ data: bigint; driverData: string }>({
	dataType: () => "integer",
	fromDriver: (value) => BigInt(value),
	toDriver: (value) => value.toString(),
});
// Tables
export const mediaOwnerStorageFence = sqliteTable(
	"media_owner_storage_fence",
	{
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		revision: sqliteBigInt("revision").notNull().default(0n),
	},
	(table) => [primaryKey({ columns: [table.ownerType, table.ownerId] })],
);

export const mediaWorkflowPhaseOwner = sqliteTable(
	"media_workflow_phase_owner",
	{
		phaseKey: text("phaseKey")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		phaseKind: text("phaseKind").notNull(),
		subjectId: text("subjectId").notNull(),
		generation: integer("generation").notNull(),
		workflowId: text("workflowId").notNull(),
		epoch: integer("epoch").notNull().default(1),
		leasedUntil: integer("leasedUntil", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex("media_workflow_phase_owner_phaseKind_subjectId_generation_key").on(
			table.phaseKind,
			table.subjectId,
			table.generation,
		),
		index("media_workflow_phase_owner_leasedUntil_idx").on(table.leasedUntil),
	],
);

export const user = sqliteTable("user", {
	id: text("id")
		.$defaultFn(() => cuid())
		.primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
	image: text("image"),
	createdAt: integer("createdAt", { mode: "timestamp" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	updatedAt: integer("updatedAt", { mode: "timestamp" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
	role: text("role"),
	banned: integer("banned", { mode: "boolean" }),
	twoFactorEnabled: integer("twoFactorEnabled", { mode: "boolean" }).default(false),
	banReason: text("banReason"),
	banExpires: integer("banExpires", { mode: "timestamp" }),
	onboardingComplete: integer("onboardingComplete", { mode: "boolean" }).notNull().default(false),
	paymentsCustomerId: text("paymentsCustomerId"),
	locale: text("locale"),
	lastActiveOrganizationId: text("lastActiveOrganizationId"),
	isAnonymous: integer("isAnonymous", { mode: "boolean" }).default(false).notNull(),
	registrationAttribution: text("registrationAttribution", { mode: "json" }),
});

export const session = sqliteTable(
	"session",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
		ipAddress: text("ipAddress"),
		userAgent: text("userAgent"),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		impersonatedBy: text("impersonatedBy"),
		activeOrganizationId: text("activeOrganizationId"),
		token: text("token").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
	},
	(table) => [uniqueIndex("session_token_idx").on(table.token)],
);

export const account = sqliteTable("account", {
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
	expiresAt: integer("expiresAt", { mode: "timestamp" }),
	password: text("password"),
	accessTokenExpiresAt: integer("accessTokenExpiresAt", {
		mode: "timestamp",
	}),
	refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
		mode: "timestamp",
	}),
	scope: text("scope"),
	createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
	id: text("id")
		.$defaultFn(() => cuid())
		.primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
	createdAt: integer("createdAt", { mode: "timestamp" }),
	updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

export const passkey = sqliteTable("passkey", {
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
	backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
	transports: text("transports"),
	createdAt: integer("createdAt", { mode: "timestamp" }),
	aaguid: text("aaguid"),
});

export const twoFactor = sqliteTable("twoFactor", {
	id: text("id")
		.$defaultFn(() => cuid())
		.primaryKey(),
	secret: text("secret").notNull(),
	backupCodes: text("backupCodes").notNull(),
	verified: integer("verified", { mode: "boolean" }).default(false).notNull(),
	userId: text("userId")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	failedVerificationCount: integer("failedVerificationCount").default(0),
	lockedUntil: integer("lockedUntil", { mode: "timestamp" }),
});

export const organization = sqliteTable(
	"organization",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		logo: text("logo"),
		createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
		metadata: text("metadata"),
		paymentsCustomerId: text("paymentsCustomerId"),
	},
	(table) => [uniqueIndex("organization_slug_idx").on(table.slug)],
);

export const member = sqliteTable(
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
		createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
	},
	(table) => [uniqueIndex("member_user_org_idx").on(table.userId, table.organizationId)],
);

export const invitation = sqliteTable(
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
		expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		inviterId: text("inviterId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitation_organizationId_idx").on(table.organizationId),
		index("invitation_email_idx").on(table.email),
	],
);

export const purchase = sqliteTable(
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
		type: text({ enum: ["SUBSCRIPTION", "ONE_TIME"] }).notNull(),
		productKind: text("productKind", { enum: ["PLAN", "CREDIT_PACK", "IMAGE_PASS"] })
			.default("PLAN")
			.notNull(),
		provider: text("provider").default("stripe").notNull(),
		customerId: text("customerId").notNull(),
		subscriptionId: text("subscriptionId"),
		priceId: text("priceId").notNull(),
		status: text("status"),
		attribution: text("attribution", { mode: "json" }),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" }).default(sql`CURRENT_TIMESTAMP`),
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

export const billingPlan = sqliteTable(
	"billing_plan",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		providerPriceId: text("providerPriceId").notNull(),
		productKind: text("productKind", { enum: ["PLAN", "CREDIT_PACK", "IMAGE_PASS"] })
			.default("PLAN")
			.notNull(),
		name: text("name").notNull(),
		creditsPerPeriod: sqliteBigInt("creditsPerPeriod").notNull(),
		priceMicros: sqliteBigInt("priceMicros").notNull(),
		currency: text("currency").notNull(),
		active: integer("active", { mode: "boolean" }).default(true).notNull(),
		version: integer("version").default(1).notNull(),
		metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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

export const subscription = sqliteTable(
	"subscription",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		provider: text("provider").notNull(),
		providerSubscriptionId: text("providerSubscriptionId").notNull(),
		planId: text("planId")
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		purchaseId: text("purchaseId").references(() => purchase.id, { onDelete: "set null" }),
		status: text("status", {
			enum: ["PENDING", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"],
		}).notNull(),
		currentPeriodStart: integer("currentPeriodStart", { mode: "timestamp" }),
		currentPeriodEnd: integer("currentPeriodEnd", { mode: "timestamp" }),
		cancelAtPeriodEnd: integer("cancelAtPeriodEnd", { mode: "boolean" }).default(false).notNull(),
		cancellationRequestedAt: integer("cancellationRequestedAt", { mode: "timestamp" }),
		renewalDisabledAt: integer("renewalDisabledAt", { mode: "timestamp" }),
		cancellationError: text("cancellationError"),
		scheduledPlanId: text("scheduledPlanId"),
		lastProviderEventAt: integer("lastProviderEventAt", { mode: "timestamp" }),
		lastProviderEventId: text("lastProviderEventId"),
		lastReconciliationSweepId: text("lastReconciliationSweepId"),
		lastReconciliationAppliedSweepId: text("lastReconciliationAppliedSweepId"),
		lastReconciledAt: integer("lastReconciledAt", { mode: "timestamp" }),
		graceEndsAt: integer("graceEndsAt", { mode: "timestamp" }),
		refundTerminationRequestedAt: integer("refundTerminationRequestedAt", { mode: "timestamp" }),
		refundTerminationPaymentId: text("refundTerminationPaymentId"),
		refundTerminationEnvironment: text("refundTerminationEnvironment"),
		refundTerminatedAt: integer("refundTerminatedAt", { mode: "timestamp" }),
		refundTerminationError: text("refundTerminationError"),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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

export const paymentCustomer = sqliteTable(
	"payment_customer",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		providerCustomerId: text("providerCustomerId").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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

export const paymentCheckoutIntent = sqliteTable(
	"payment_checkout_intent",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		provider: text("provider").notNull(),
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		submittedByUserId: text("submittedByUserId").notNull(),
		productKind: text("productKind", { enum: ["PLAN", "CREDIT_PACK", "IMAGE_PASS"] })
			.default("PLAN")
			.notNull(),
		billingPlanId: text("billingPlanId")
			.notNull()
			.references(() => billingPlan.id, { onDelete: "restrict" }),
		planKey: text("planKey").notNull(),
		interval: text("interval").notNull(),
		idempotencyKey: text("idempotencyKey").notNull(),
		providerSessionId: text("providerSessionId"),
		providerOrderId: text("providerOrderId"),
		providerCheckoutUrl: text("providerCheckoutUrl"),
		checkoutRecovery: text("checkoutRecovery", { mode: "json" }),
		attribution: text("attribution", { mode: "json" }),
		activeScopeKey: text("activeScopeKey"),
		creditPackCatalogVersion: text("creditPackCatalogVersion"),
		creditPackPricingVersion: text("creditPackPricingVersion"),
		creditPackSubscriberEligibilityVersion: text("creditPackSubscriberEligibilityVersion"),
		creditPackBaseCredits: sqliteBigInt("creditPackBaseCredits"),
		creditPackBonusCredits: sqliteBigInt("creditPackBonusCredits"),
		creditPackTotalCredits: sqliteBigInt("creditPackTotalCredits"),
		creditPackExpiryMonths: integer("creditPackExpiryMonths"),
		creditPackSubscriberBonusEligible: integer("creditPackSubscriberBonusEligible", {
			mode: "boolean",
		}),
		creditPackSubscriberSubscriptionId: text("creditPackSubscriberSubscriptionId"),
		creditPackSubscriberPlanKey: text("creditPackSubscriberPlanKey"),
		creditPackEligibilityEvaluatedAt: integer("creditPackEligibilityEvaluatedAt", {
			mode: "timestamp",
		}),
		status: text("status", {
			enum: [
				"CREATED",
				"PROVIDER_CREATING",
				"PROVIDER_PENDING",
				"COMPLETED",
				"EXPIRED",
				"CANCELED",
				"REVIEW",
			],
		})
			.default("CREATED")
			.notNull(),
		expiresAt: integer("expiresAt", { mode: "timestamp" }),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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
			sql`(${table.productKind} = 'PLAN' AND ${table.creditPackCatalogVersion} IS NULL AND ${table.creditPackPricingVersion} IS NULL AND ${table.creditPackSubscriberEligibilityVersion} IS NULL AND ${table.creditPackBaseCredits} IS NULL AND ${table.creditPackBonusCredits} IS NULL AND ${table.creditPackTotalCredits} IS NULL AND ${table.creditPackExpiryMonths} IS NULL AND ${table.creditPackSubscriberBonusEligible} IS NULL AND ${table.creditPackSubscriberSubscriptionId} IS NULL AND ${table.creditPackSubscriberPlanKey} IS NULL AND ${table.creditPackEligibilityEvaluatedAt} IS NULL) OR (${table.productKind} = 'CREDIT_PACK' AND ${table.provider} IN ('paypal', 'waffo') AND ${table.interval} = 'one-time' AND NULLIF(${table.creditPackCatalogVersion}, '') IS NOT NULL AND NULLIF(${table.creditPackPricingVersion}, '') IS NOT NULL AND NULLIF(${table.creditPackSubscriberEligibilityVersion}, '') IS NOT NULL AND ${table.creditPackBaseCredits} > 0 AND ${table.creditPackBonusCredits} >= 0 AND ${table.creditPackTotalCredits} = ${table.creditPackBaseCredits} + ${table.creditPackBonusCredits} AND ${table.creditPackExpiryMonths} = 6 AND ${table.creditPackSubscriberBonusEligible} IS NOT NULL AND ${table.creditPackEligibilityEvaluatedAt} IS NOT NULL AND ((${table.creditPackSubscriberBonusEligible} = 0 AND ${table.creditPackBonusCredits} = 0 AND ${table.creditPackSubscriberSubscriptionId} IS NULL AND ${table.creditPackSubscriberPlanKey} IS NULL) OR (${table.creditPackSubscriberBonusEligible} = 1 AND ${table.creditPackBonusCredits} > 0 AND NULLIF(${table.creditPackSubscriberSubscriptionId}, '') IS NOT NULL AND NULLIF(${table.creditPackSubscriberPlanKey}, '') IS NOT NULL)))`,
		),
	],
);

export const paymentCheckoutIntentIdempotencyAlias = sqliteTable(
	"payment_checkout_intent_idempotency_alias",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		idempotencyKey: text("idempotencyKey").notNull(),
		checkoutIntentId: text("checkoutIntentId")
			.notNull()
			.references(() => paymentCheckoutIntent.id, { onDelete: "cascade" }),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
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

export const creditPackFulfillment = sqliteTable(
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
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		provider: text("provider").notNull(),
		providerOrderId: text("providerOrderId").notNull(),
		providerPaymentId: text("providerPaymentId").notNull(),
		paidAmountMicros: sqliteBigInt("paidAmountMicros").notNull(),
		currency: text("currency").notNull(),
		baseCredits: sqliteBigInt("baseCredits").notNull(),
		bonusCredits: sqliteBigInt("bonusCredits").notNull(),
		grantedCredits: sqliteBigInt("grantedCredits").notNull(),
		refundedAmountMicros: sqliteBigInt("refundedAmountMicros").default(0n).notNull(),
		refundedCredits: sqliteBigInt("refundedCredits").default(0n).notNull(),
		grantReferenceKey: text("grantReferenceKey").notNull(),
		paidAt: integer("paidAt", { mode: "timestamp" }).notNull(),
		expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
		status: text("status", { enum: ["FULFILLED", "PARTIALLY_REFUNDED", "REFUNDED"] })
			.default("FULFILLED")
			.notNull(),
		fulfilledAt: integer("fulfilledAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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

export const creditPackAdjustment = sqliteTable(
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
		amountMicros: sqliteBigInt("amountMicros").notNull(),
		currency: text("currency").notNull(),
		status: text("status", {
			enum: ["PENDING", "REQUIRES_ACTION", "SUCCEEDED", "FAILED", "CANCELED"],
		}).notNull(),
		providerCreatedAt: integer("providerCreatedAt", { mode: "timestamp" }).notNull(),
		lastProviderChangeAt: integer("lastProviderChangeAt", { mode: "timestamp" }).notNull(),
		lastProviderChangeId: text("lastProviderChangeId").notNull(),
		finalizedCredits: sqliteBigInt("finalizedCredits").default(0n).notNull(),
		creditsFinalizedAt: integer("creditsFinalizedAt", { mode: "timestamp" }),
		refundReferenceKey: text("refundReferenceKey"),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
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

export const notification = sqliteTable(
	"notification",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: text({ enum: ["WELCOME", "APP_UPDATE", "MODERATION_ALERT"] }).notNull(),
		data: text("data", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$default(() => ({})),
		link: text("link"),
		read: integer("read", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: integer("updatedAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$onUpdate(() => new Date()),
	},
	(table) => [index("notification_userId_idx").on(table.userId)],
);

export const userNotificationPreference = sqliteTable(
	"user_notification_preference",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		userId: text("userId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		type: text({ enum: ["WELCOME", "APP_UPDATE", "MODERATION_ALERT"] }).notNull(),
		target: text({ enum: ["IN_APP", "EMAIL"] }).notNull(),
		createdAt: integer("createdAt", { mode: "timestamp" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
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
	growthEvents: many(growthEvent),
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
	supportTickets: many(supportTicket),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
	members: many(member),
	invitations: many(invitation),
	purchases: many(purchase),
	supportTickets: many(supportTicket),
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
	mediaSubscription: one(subscription),
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

export const subscriptionRelations = relations(subscription, ({ one }) => ({
	purchase: one(purchase, { fields: [subscription.purchaseId], references: [purchase.id] }),
	plan: one(billingPlan, { fields: [subscription.planId], references: [billingPlan.id] }),
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

// Durable moderation outages and administrator review; private media stays in the existing lifecycle.
export const moderationIncident = sqliteTable(
	"moderation_incident",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		activeKey: text("activeKey").unique(),
		provider: text("provider").notNull(),
		stage: text("stage").notNull(),
		status: text("status").notNull().default("OPEN"),
		lastErrorCode: text("lastErrorCode").notNull(),
		failureCount: integer("failureCount").notNull().default(0),
		firstFailureAt: integer("firstFailureAt", { mode: "timestamp_ms" }).notNull(),
		lastFailureAt: integer("lastFailureAt", { mode: "timestamp_ms" }).notNull(),
		recoveredAt: integer("recoveredAt", { mode: "timestamp_ms" }),
		acknowledgedAt: integer("acknowledgedAt", { mode: "timestamp_ms" }),
		alertedAt: integer("alertedAt", { mode: "timestamp_ms" }),
		acknowledgedBy: text("acknowledgedBy"),
	},
	(table) => [
		index("moderation_incident_status_lastFailureAt_idx").on(table.status, table.lastFailureAt),
	],
);
export const moderationReview = sqliteTable(
	"moderation_review",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		targetType: text("targetType").notNull(),
		targetId: text("targetId").notNull(),
		provider: text("provider").notNull(),
		stage: text("stage").notNull(),
		attemptEpoch: text("attemptEpoch").notNull(),
		lastErrorCode: text("lastErrorCode").notNull(),
		incidentId: text("incidentId").references(() => moderationIncident.id, {
			onDelete: "set null",
		}),
		status: text("status").notNull().default("RETRYING"),
		bypassed: integer("bypassed", { mode: "boolean" }).notNull().default(false),
		failureCount: integer("failureCount").notNull().default(0),
		observedFailures: integer("observedFailures").notNull().default(0),
		version: integer("version").notNull().default(0),
		firstFailureAt: integer("firstFailureAt", { mode: "timestamp_ms" }).notNull(),
		lastFailureAt: integer("lastFailureAt", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.notNull()
			.$onUpdate(() => new Date()),
		resolvedAt: integer("resolvedAt", { mode: "timestamp_ms" }),
		resolvedBy: text("resolvedBy"),
		resolutionReason: text("resolutionReason"),
	},
	(table) => [
		uniqueIndex("moderation_review_targetType_targetId_key").on(table.targetType, table.targetId),
		index("moderation_review_status_updatedAt_idx").on(table.status, table.updatedAt),
	],
);
export const moderationIncidentTarget = sqliteTable(
	"moderation_incident_target",
	{
		incidentId: text("incidentId")
			.notNull()
			.references(() => moderationIncident.id, { onDelete: "cascade" }),
		targetType: text("targetType").notNull(),
		targetId: text("targetId").notNull(),
	},
	(table) => [primaryKey({ columns: [table.incidentId, table.targetType, table.targetId] })],
);

// Machine principals are separate from Better Auth users and cannot sign in.
export const adminServiceAccount = sqliteTable(
	"admin_service_account",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		name: text("name").notNull(),
		scope: text("scope", { mode: "json" }).notNull(),
		scopeKey: text("scopeKey").notNull(),
		permissions: text("permissions", { mode: "json" })
			.$type<string[]>()
			.default(sql`'[]'`)
			.notNull(),
		disabledAt: integer("disabledAt", { mode: "timestamp_ms" }),
		createdByUserId: text("createdByUserId").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("admin_service_account_scopeKey_createdAt_idx").on(table.scopeKey, table.createdAt),
	],
);

export const adminApiKey = sqliteTable(
	"admin_api_key",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		serviceAccountId: text("serviceAccountId")
			.notNull()
			.references(() => adminServiceAccount.id, { onDelete: "restrict", onUpdate: "cascade" }),
		name: text("name").notNull(),
		keyHash: text("keyHash").notNull().unique(),
		keyPrefix: text("keyPrefix").notNull(),
		expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
		revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
		lastUsedAt: integer("lastUsedAt", { mode: "timestamp_ms" }),
		createdByUserId: text("createdByUserId").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
	},
	(table) => [
		index("admin_api_key_serviceAccountId_createdAt_idx").on(
			table.serviceAccountId,
			table.createdAt,
		),
	],
);

// Execution journal only; financial entries remain in the existing credit ledger.
export const adminExecution = sqliteTable(
	"admin_execution",
	{
		id: text("id").primaryKey(),
		actorId: text("actorId").notNull(),
		actorType: text("actorType").notNull(),
		credentialId: text("credentialId"),
		scope: text("scope", { mode: "json" }).notNull(),
		scopeKey: text("scopeKey").notNull(),
		operation: text("operation").notNull(),
		inputHash: text("inputHash").notNull(),
		targetId: text("targetId"),
		status: text("status").notNull(),
		response: text("response", { mode: "json" }),
		errorCode: text("errorCode"),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
		completedAt: integer("completedAt", { mode: "timestamp_ms" }),
	},
	(table) => [
		index("admin_execution_actorId_scopeKey_createdAt_idx").on(
			table.actorId,
			table.scopeKey,
			table.createdAt,
		),
		index("admin_execution_operation_createdAt_idx").on(table.operation, table.createdAt),
	],
);

export const adminBotConfig = sqliteTable("admin_bot_config", {
	id: text("id").primaryKey(),
	payload: text("payload", { mode: "json" }).notNull(),
	encryptedSecrets: text("encryptedSecrets"),
	version: integer("version").default(1).notNull(),
	updatedBy: text("updatedBy").notNull(),
	createdAt: integer("createdAt", { mode: "timestamp_ms" })
		.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
		.notNull(),
	updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
		.$onUpdate(() => new Date())
		.notNull(),
});

// Once-only best-effort delivery claim, not a reliable retry queue.
export const adminBotReceipt = sqliteTable("admin_bot_receipt", {
	id: text("id").primaryKey(),
	eventKey: text("eventKey").notNull().unique(),
	event: text("event").notNull(),
	status: text("status").notNull(),
	results: text("results", { mode: "json" }),
	createdAt: integer("createdAt", { mode: "timestamp_ms" })
		.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
		.notNull(),
	completedAt: integer("completedAt", { mode: "timestamp_ms" }),
});

export const supportTicket = sqliteTable(
	"support_ticket",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		createdByUserId: text("createdByUserId")
			.notNull()
			.references(() => user.id, { onDelete: "cascade", onUpdate: "cascade" }),
		organizationId: text("organizationId").references(() => organization.id, {
			onDelete: "cascade",
			onUpdate: "cascade",
		}),
		subject: text("subject").notNull(),
		status: text("status").default("OPEN").notNull(),
		requestKey: text("requestKey").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		uniqueIndex("support_ticket_createdByUserId_requestKey_key").on(
			table.createdByUserId,
			table.requestKey,
		),
		index("support_ticket_createdByUserId_updatedAt_idx").on(
			table.createdByUserId,
			table.updatedAt,
		),
		index("support_ticket_organizationId_updatedAt_idx").on(table.organizationId, table.updatedAt),
		index("support_ticket_status_updatedAt_idx").on(table.status, table.updatedAt),
	],
);

export const supportTicketMessage = sqliteTable(
	"support_ticket_message",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		ticketId: text("ticketId")
			.notNull()
			.references(() => supportTicket.id, { onDelete: "cascade", onUpdate: "cascade" }),
		authorType: text("authorType").notNull(),
		authorId: text("authorId").notNull(),
		body: text("body").notNull(),
		requestKey: text("requestKey").notNull(),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("support_ticket_message_ticketId_requestKey_key").on(
			table.ticketId,
			table.requestKey,
		),
		index("support_ticket_message_ticketId_createdAt_idx").on(table.ticketId, table.createdAt),
	],
);

export const adminRefundRequest = sqliteTable(
	"admin_refund_request",
	{
		id: text("id")
			.$defaultFn(() => cuid())
			.primaryKey(),
		paymentKey: text("paymentKey").notNull().unique(),
		orderNo: text("orderNo").notNull(),
		ownerType: text("ownerType", { enum: ["USER", "ORGANIZATION"] }).notNull(),
		ownerId: text("ownerId").notNull(),
		provider: text("provider").notNull(),
		providerEnvironment: text("providerEnvironment").notNull(),
		productKind: text("productKind", { enum: ["PLAN", "CREDIT_PACK", "IMAGE_PASS"] }).notNull(),
		providerPaymentId: text("providerPaymentId").notNull(),
		providerOrderId: text("providerOrderId"),
		subscriptionId: text("subscriptionId"),
		amountMicros: sqliteBigInt("amountMicros").notNull(),
		currency: text("currency").notNull(),
		status: text("status").default("PENDING").notNull(),
		providerRequestId: text("providerRequestId").notNull().unique(),
		providerRefundId: text("providerRefundId"),
		reason: text("reason"),
		cancelSubscription: integer("cancelSubscription", { mode: "boolean" }).default(false).notNull(),
		requestedBy: text("requestedBy").notNull(),
		processingToken: text("processingToken"),
		processingLeasedUntil: integer("processingLeasedUntil", { mode: "timestamp_ms" }),
		providerAcceptedAt: integer("providerAcceptedAt", { mode: "timestamp_ms" }),
		completedAt: integer("completedAt", { mode: "timestamp_ms" }),
		lastError: text("lastError"),
		result: text("result", { mode: "json" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.default(sql`(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`)
			.notNull(),
		updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("admin_refund_request_ownerType_ownerId_createdAt_idx").on(
			table.ownerType,
			table.ownerId,
			table.createdAt,
		),
		index("admin_refund_request_status_updatedAt_idx").on(table.status, table.updatedAt),
	],
);

export const adminServiceAccountRelations = relations(adminServiceAccount, ({ many }) => ({
	keys: many(adminApiKey),
}));

export const adminApiKeyRelations = relations(adminApiKey, ({ one }) => ({
	account: one(adminServiceAccount, {
		fields: [adminApiKey.serviceAccountId],
		references: [adminServiceAccount.id],
	}),
}));

export const supportTicketRelations = relations(supportTicket, ({ one, many }) => ({
	createdByUser: one(user, {
		fields: [supportTicket.createdByUserId],
		references: [user.id],
	}),
	organization: one(organization, {
		fields: [supportTicket.organizationId],
		references: [organization.id],
	}),
	messages: many(supportTicketMessage),
}));

export const supportTicketMessageRelations = relations(supportTicketMessage, ({ one }) => ({
	ticket: one(supportTicket, {
		fields: [supportTicketMessage.ticketId],
		references: [supportTicket.id],
	}),
}));

export const growthEvent = sqliteTable(
	"growth_event",
	{
		id: text("id").primaryKey(),
		sessionHash: text("sessionHash").notNull(),
		userId: text("userId").references(() => user.id, { onDelete: "cascade", onUpdate: "cascade" }),
		internal: integer("internal", { mode: "boolean" }).notNull().default(false),
		name: text("name").notNull(),
		path: text("path"),
		source: text("source"),
		medium: text("medium"),
		campaign: text("campaign"),
		device: text("device").notNull(),
		productKind: text("productKind"),
		errorCategory: text("errorCategory"),
		diagnostics: text("diagnostics", { mode: "json" }),
		createdAt: integer("createdAt", { mode: "timestamp_ms" })
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index("growth_event_createdAt_idx").on(table.createdAt),
		index("growth_event_sessionHash_createdAt_idx").on(table.sessionHash, table.createdAt),
		index("growth_event_userId_createdAt_idx").on(table.userId, table.createdAt),
	],
);

export const growthEventRelations = relations(growthEvent, ({ one }) => ({
	user: one(user, { fields: [growthEvent.userId], references: [user.id] }),
}));

export const trafficAggregate = sqliteTable(
	"traffic_aggregate",
	{
		hour: integer("hour", { mode: "timestamp_ms" }).notNull(),
		path: text("path").notNull(),
		source: text("source").notNull(),
		device: text("device").notNull(),
		views: integer("views").notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.hour, table.path, table.source, table.device] })],
);
