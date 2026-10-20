import {
	type AdminAnalyticsFacts,
	type AdminAnalyticsPayment,
	type AdminAnalyticsRefund,
} from "./admin-analytics";
import { classifyInitialSubscriptionPayment } from "./admin-analytics-payment-evidence";
import {
	normalizeSubscriptionPaymentEvidence,
	stripeMinorToMicros,
	type AdminPaymentEventEvidence,
	type AdminPaymentPeriodEvidence,
} from "./admin-payment-facts";
import type { AdminScope } from "./admin-scope";

/** Every statement below is static SQL. Only scope values are bound as parameters. */
export interface AdminAnalyticsQuery {
	<T>(statement: string, parameters: readonly unknown[]): Promise<T[]>;
}

// Fail explicitly before returning a partial financial report. This is an operational
// safety bound, not pagination: no successful response ever silently truncates facts.
const FACT_LIMIT = 20_000;
const rowLimit = `LIMIT ${FACT_LIMIT + 1}`;
const registered = (alias: string) => `NOT ${alias}."isAnonymous"
	AND lower(${alias}."email") NOT LIKE '%@anonymous.invalid'
	AND lower(${alias}."email") NOT LIKE '%@guest.invalid'`;
const ownerScope = (alias: string) => `($1 = 'platform'
	OR ($1 = 'organization' AND ${alias}."ownerType"::text = 'ORGANIZATION' AND ${alias}."ownerId" = $2)
	OR ($1 = 'user' AND ${alias}."ownerType"::text = 'USER' AND ${alias}."ownerId" = $2))`;
const userScope = `($1 = 'platform' OR ($1 = 'user' AND u.id = $2)
	OR ($1 = 'organization' AND EXISTS (SELECT 1 FROM "member" m WHERE m."userId" = u.id AND m."organizationId" = $2)))`;

export const ADMIN_ANALYTICS_SQL = {
	users: `SELECT u.id, u."createdAt", u."registrationAttribution", u."isAnonymous",
		false AS "legacyGuest", ARRAY(SELECT m."organizationId" FROM "member" m WHERE m."userId" = u.id) AS "organizationIds"
		FROM "user" u WHERE ${registered("u")} AND ${userScope} ${rowLimit}`,
	checkouts: `SELECT c.id, c."ownerType"::text, c."ownerId", c."createdAt", u.id AS "userId"
		FROM "payment_checkout_intent" c
		JOIN "user" u ON u.id = c."submittedByUserId" AND ${registered("u")}
		WHERE ${ownerScope("c")} ${rowLimit}`,
	subscriptions: `SELECT s.id, s."ownerType"::text, s."ownerId", s.status::text, s."createdAt",
		s."currentPeriodEnd", s."renewalDisabledAt", s."refundTerminationRequestedAt"
		FROM "subscription" s WHERE ${ownerScope("s")} ${rowLimit}`,
	oneTime: `WITH payments AS (
		SELECT 'pack:' || p.id AS id, p."ownerType"::text AS "ownerType", p."ownerId",
			p."checkoutIntentId", p.provider, p."providerPaymentId", p."paidAt", p."paidAmountMicros"::text AS "amountMicros", p.currency
		FROM "credit_pack_fulfillment" p WHERE ${ownerScope("p")}
		UNION ALL
		SELECT 'pass:' || p.id AS id, 'USER' AS "ownerType", p."ownerId",
			p."checkoutIntentId", p.provider, p."providerPaymentId", p."paidAt", p."paidAmountMicros"::text AS "amountMicros", p.currency
		FROM "image_pass_grant" p WHERE ($1 = 'platform' OR ($1 = 'user' AND p."ownerId" = $2))
	)
	SELECT p.*, u.id AS "userId", ARRAY(
		SELECT DISTINCT e."providerEnvironment" FROM "payment_event" e
		WHERE e.provider = p.provider AND e.status = 'PROCESSED' AND e."verifiedAt" IS NOT NULL
			AND (e."normalizedTransactionId" = p."providerPaymentId"
				OR e.envelope->'resource'->>'id' = p."providerPaymentId"
				OR e.envelope->'data'->>'paymentId' = p."providerPaymentId"
				OR e.envelope->'data'->'payment'->>'paymentId' = p."providerPaymentId")
			AND (e.envelope->>'event_type' = 'PAYMENT.CAPTURE.COMPLETED' OR e.envelope->>'eventType' = 'order.completed')
	) AS environments
	FROM payments p
	LEFT JOIN "payment_checkout_intent" c ON c.id = p."checkoutIntentId"
		AND c."ownerType"::text = p."ownerType" AND c."ownerId" = p."ownerId"
	LEFT JOIN "user" u ON u.id = c."submittedByUserId" AND ${registered("u")}
	${rowLimit}`,
	subscriptionPayments: `WITH groups AS (
		SELECT s.id AS "subscriptionId", s.provider, s."providerSubscriptionId", s."ownerType"::text AS "ownerType", s."ownerId", s."initialPaymentEvidence",
			MIN(p.id) AS "rootId", MIN(p."startsAt") AS "firstPeriodStartsAt",
			MIN(p."providerInvoicePaymentId") AS "providerInvoicePaymentId", MIN(p."providerInvoiceId") AS "providerInvoiceId",
			ARRAY_AGG(DISTINCT p."providerChargeId") FILTER (WHERE p."providerChargeId" IS NOT NULL) AS "chargeIds",
			ARRAY_AGG(DISTINCT p."providerPaymentIntentId") FILTER (WHERE p."providerPaymentIntentId" IS NOT NULL) AS "paymentIntentIds",
			JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
				'provider', s.provider, 'providerSubscriptionId', s."providerSubscriptionId",
				'providerInvoicePaymentId', p."providerInvoicePaymentId", 'providerInvoiceId', p."providerInvoiceId",
				'paidAmount', p."paidAmount"::text)) AS periods
		FROM "billing_period" p JOIN "subscription" s ON s.id = p."subscriptionId"
		WHERE p."paidAmount" > 0 AND ${ownerScope("s")}
		GROUP BY s.id, s.provider, s."providerSubscriptionId", s."ownerType", s."ownerId", s."initialPaymentEvidence",
			CASE WHEN s.provider = 'stripe' AND p."providerInvoiceId" IS NOT NULL THEN 'invoice:' || p."providerInvoiceId"
				WHEN p."providerInvoicePaymentId" IS NOT NULL THEN 'payment:' || p."providerInvoicePaymentId"
				WHEN p."providerInvoiceId" IS NOT NULL THEN 'invoice:' || p."providerInvoiceId" ELSE 'period:' || p.id END
		${rowLimit}
	)
	SELECT g.*, c.id AS "checkoutIntentId", COALESCE(u.id, owner_user.id) AS "userId",
		COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
			'provider', e.provider, 'providerEnvironment', e."providerEnvironment",
			'verifiedAt', e."verifiedAt", 'status', e.status,
			'envelope', CASE WHEN e.provider = 'stripe' THEN JSONB_BUILD_OBJECT(
				'type', e.envelope->'type', 'livemode', e.envelope->'livemode',
				'data', JSONB_BUILD_OBJECT('object', JSONB_BUILD_OBJECT(
					'id', e.envelope->'data'->'object'->'id',
					'subscription', e.envelope->'data'->'object'->'subscription',
					'parent', e.envelope->'data'->'object'->'parent',
					'amount_paid', e.envelope->'data'->'object'->'amount_paid',
					'currency', e.envelope->'data'->'object'->'currency',
					'billing_reason', e.envelope->'data'->'object'->'billing_reason',
					'status_transitions', e.envelope->'data'->'object'->'status_transitions')))
			WHEN e.provider = 'paypal' THEN JSONB_BUILD_OBJECT(
				'event_type', e.envelope->'event_type', 'create_time', e.envelope->'create_time',
				'resource', JSONB_BUILD_OBJECT('id', e.envelope->'resource'->'id',
					'billing_agreement_id', e.envelope->'resource'->'billing_agreement_id',
					'amount', e.envelope->'resource'->'amount', 'create_time', e.envelope->'resource'->'create_time'))
			ELSE JSONB_BUILD_OBJECT('eventType', e.envelope->'eventType', 'mode', e.envelope->'mode',
				'timestamp', e.envelope->'timestamp', 'data', JSONB_BUILD_OBJECT(
					'paymentId', e.envelope->'data'->'paymentId', 'orderId', e.envelope->'data'->'orderId',
					'amount', e.envelope->'data'->'amount', 'currency', e.envelope->'data'->'currency')) END))
			FROM "payment_event" e WHERE e.provider = g.provider AND e.status = 'PROCESSED' AND e."verifiedAt" IS NOT NULL
				AND (e."normalizedTransactionId" = g."providerInvoicePaymentId"
					OR e."normalizedTransactionId" = regexp_replace(g."providerInvoicePaymentId", '^(paypal|waffo):', '')
					OR e."normalizedTransactionId" = 'invoice:' || g."providerInvoiceId"
					OR e.envelope->'data'->'object'->>'id' = g."providerInvoiceId"
					OR e.envelope->'resource'->>'id' = regexp_replace(g."providerInvoicePaymentId", '^paypal:', '')
					OR e.envelope->'data'->>'paymentId' = regexp_replace(g."providerInvoicePaymentId", '^waffo:', ''))
		), '[]'::jsonb) AS events
	FROM groups g LEFT JOIN LATERAL (
		SELECT c.* FROM "payment_checkout_intent" c WHERE c.provider = g.provider
			AND c."ownerType"::text = g."ownerType" AND c."ownerId" = g."ownerId" AND c."productKind" = 'PLAN'
			AND ((g.provider = 'paypal' AND c."providerSessionId" = g."providerSubscriptionId")
				OR (g.provider = 'waffo' AND c."providerOrderId" = g."providerSubscriptionId"))
		LIMIT 1
	) c ON true
	LEFT JOIN "user" u ON u.id = c."submittedByUserId" AND ${registered("u")}
	LEFT JOIN "user" owner_user ON g."ownerType" = 'USER' AND owner_user.id = g."ownerId" AND ${registered("owner_user")}`,
	refunds: `SELECT 'pack-refund:' || r.id AS id, 'pack:' || p.id AS "paymentId", p."ownerType"::text AS "ownerType", p."ownerId",
		r."providerCreatedAt" AS "occurredAt", r."amountMicros"::text AS amount, r.currency, false AS "minorUnits",
		p.provider, p."providerPaymentId", NULL::text AS "providerChargeId", NULL::text AS "subscriptionId", NULL::text AS "providerPaymentIntentId"
		FROM "credit_pack_adjustment" r JOIN "credit_pack_fulfillment" p ON p.id = r."fulfillmentId"
		WHERE r.status = 'SUCCEEDED' AND ${ownerScope("p")}
		UNION ALL
		SELECT 'pass-refund:' || r.id, 'pass:' || p.id, 'USER', p."ownerId", r."occurredAt",
			r."amountMicros"::text, r.currency, false, p.provider, p."providerPaymentId", NULL::text, NULL::text, NULL::text
		FROM "image_pass_adjustment" r JOIN "image_pass_grant" p ON p.id = r."grantId"
		WHERE ($1 = 'platform' OR ($1 = 'user' AND p."ownerId" = $2))
		UNION ALL
		SELECT 'plan-refund:' || r.id, NULL::text, s."ownerType"::text, s."ownerId", r."providerCreatedAt",
			r."amountMicros"::text, r.currency, false, s.provider, r."providerPaymentId", NULL::text, s.id, NULL::text
		FROM "subscription_payment_adjustment" r JOIN "subscription" s ON s.id = r."subscriptionId"
		WHERE ${ownerScope("s")}
		UNION ALL
		SELECT DISTINCT 'stripe-refund:' || r.id, NULL::text, s."ownerType"::text, s."ownerId", r."providerCreatedAt",
			r.amount::text, r.currency, true, 'stripe', NULL::text, r."providerChargeId", s.id, r."providerPaymentIntentId"
		FROM "stripe_refund" r JOIN "billing_period" p ON p."providerChargeId" = r."providerChargeId"
			OR (r."providerPaymentIntentId" IS NOT NULL AND p."providerPaymentIntentId" = r."providerPaymentIntentId")
		JOIN "subscription" s ON s.id = p."subscriptionId"
		WHERE s.provider = 'stripe' AND r.status = 'SUCCEEDED' AND ${ownerScope("s")}
		${rowLimit}`,
	tickets: `SELECT count(*)::int AS count FROM "support_ticket" t WHERE t.status = 'OPEN' AND
		($1 = 'platform' OR ($1 = 'organization' AND t."organizationId" = $2)
			OR ($1 = 'user' AND t."createdByUserId" = $2 AND t."organizationId" IS NULL))`,
} as const;

function bounded<T>(rows: T[]): T[] {
	if (rows.length > FACT_LIMIT) throw new Error("ADMIN_ANALYTICS_DATASET_LIMIT");
	return rows;
}
function asDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}
function environment(values: Array<string | null>): "production" | "test" | "unknown" {
	const groups = new Set(
		values.map((value) =>
			["live", "prod"].includes(value ?? "")
				? "production"
				: ["sandbox", "test"].includes(value ?? "")
					? "test"
					: "unknown",
		),
	);
	return groups.size === 1 ? ([...groups][0] as "production" | "test" | "unknown") : "unknown";
}
interface OneTimeRow {
	id: string;
	ownerType: string;
	ownerId: string;
	checkoutIntentId: string;
	provider: string;
	providerPaymentId: string;
	paidAt: Date;
	amountMicros: string;
	currency: string;
	userId: string | null;
	environments: Array<string | null>;
}
interface SubscriptionRow {
	subscriptionId: string;
	provider: string;
	providerSubscriptionId: string;
	ownerType: string;
	ownerId: string;
	rootId: string;
	firstPeriodStartsAt: Date;
	providerInvoicePaymentId: string | null;
	providerInvoiceId: string | null;
	chargeIds: string[] | null;
	paymentIntentIds?: string[] | null;
	periods: Array<Omit<AdminPaymentPeriodEvidence, "paidAmount"> & { paidAmount: string }>;
	events: AdminPaymentEventEvidence[];
	checkoutIntentId: string | null;
	userId: string | null;
	initialPaymentEvidence?: unknown;
}
interface RefundRow {
	id: string;
	paymentId: string | null;
	ownerType: string;
	ownerId: string;
	occurredAt: Date;
	amount: string;
	currency: string;
	minorUnits: boolean;
	provider: string;
	providerPaymentId: string | null;
	providerChargeId: string | null;
	subscriptionId: string | null;
	providerPaymentIntentId?: string | null;
}

export async function readAdminAnalyticsFacts(
	query: AdminAnalyticsQuery,
	scope: AdminScope,
): Promise<AdminAnalyticsFacts> {
	const params = [
		scope.kind,
		scope.kind === "platform"
			? null
			: scope.kind === "organization"
				? scope.organizationId
				: scope.userId,
	];
	const [users, checkouts, subscriptions, oneTime, groups, refundRows, tickets] = await Promise.all(
		[
			query<AdminAnalyticsFacts["users"][number]>(ADMIN_ANALYTICS_SQL.users, params),
			query<AdminAnalyticsFacts["checkouts"][number]>(ADMIN_ANALYTICS_SQL.checkouts, params),
			query<AdminAnalyticsFacts["subscriptions"][number]>(
				ADMIN_ANALYTICS_SQL.subscriptions,
				params,
			),
			query<OneTimeRow>(ADMIN_ANALYTICS_SQL.oneTime, params),
			query<SubscriptionRow>(ADMIN_ANALYTICS_SQL.subscriptionPayments, params),
			query<RefundRow>(ADMIN_ANALYTICS_SQL.refunds, params),
			query<{ count: number }>(ADMIN_ANALYTICS_SQL.tickets, params),
		],
	);
	const payments: AdminAnalyticsPayment[] = bounded(oneTime).map((payment) => ({
		id: payment.id,
		ownerType: payment.ownerType,
		ownerId: payment.ownerId,
		userId: payment.userId,
		checkoutIntentId: payment.checkoutIntentId,
		subscriptionId: null,
		paidAt: asDate(payment.paidAt),
		amountMicros: BigInt(payment.amountMicros),
		currency: payment.currency.toUpperCase(),
		renewal: false,
		evidence: "verified",
		environment: environment(payment.environments),
	}));
	const byProviderId = new Map(
		oneTime.map((payment) => [`${payment.provider}:${payment.providerPaymentId}`, payment.id]),
	);
	const byCharge = new Map<string, string>();
	const byPaymentIntent = new Map<string, string>();
	for (const group of bounded(groups)) {
		const id = `plan:${group.rootId}`;
		const evidence = normalizeSubscriptionPaymentEvidence(
			group.periods.map((period) => ({
				...period,
				paidAmount: BigInt(period.paidAmount),
			})),
			group.events,
		);
		const firstPayment =
			evidence.evidence === "verified"
				? (evidence.firstPayment ??
					classifyInitialSubscriptionPayment(
						group.initialPaymentEvidence,
						evidence.providerPaymentId,
						asDate(group.firstPeriodStartsAt),
					))
				: null;
		const payment: AdminAnalyticsPayment = {
			id,
			ownerType: group.ownerType,
			ownerId: group.ownerId,
			userId: group.userId,
			checkoutIntentId: group.checkoutIntentId,
			subscriptionId: group.subscriptionId,
			paidAt: evidence.evidence === "verified" ? evidence.paidAt : null,
			amountMicros: evidence.evidence === "verified" ? evidence.amountMicros : null,
			currency: evidence.evidence === "verified" ? evidence.currency : null,
			renewal: firstPayment === null ? null : !firstPayment,
			evidence: evidence.evidence,
			environment:
				evidence.evidence === "verified" ? environment([evidence.providerEnvironment]) : "unknown",
		};
		// Earliest locally stored payment is not proof of the initial payment.
		// Providers without explicit initial/renewal receipt evidence stay unknown.
		if (group.providerInvoicePaymentId) {
			byProviderId.set(
				`${group.provider}:${group.providerInvoicePaymentId.replace(/^(paypal|waffo):/, "")}`,
				id,
			);
		}
		for (const charge of group.chargeIds ?? [])
			byCharge.set(`${group.subscriptionId}:${charge}`, id);
		for (const intent of group.paymentIntentIds ?? [])
			byPaymentIntent.set(`${group.subscriptionId}:${intent}`, id);
		payments.push(payment);
	}
	const byId = new Map(payments.map((payment) => [payment.id, payment]));
	const refunds: AdminAnalyticsRefund[] = bounded(refundRows).map((refund) => {
		const paymentId =
			refund.paymentId ??
			(refund.providerChargeId
				? byCharge.get(`${refund.subscriptionId}:${refund.providerChargeId}`)
				: undefined) ??
			(refund.providerPaymentIntentId
				? byPaymentIntent.get(`${refund.subscriptionId}:${refund.providerPaymentIntentId}`)
				: undefined) ??
			(refund.providerPaymentId
				? byProviderId.get(
						`${refund.provider}:${refund.providerPaymentId.replace(/^(paypal|waffo):/, "")}`,
					)
				: undefined) ??
			null;
		const payment = paymentId ? byId.get(paymentId) : undefined;
		return {
			id: refund.id,
			paymentId,
			ownerType: refund.ownerType,
			ownerId: refund.ownerId,
			occurredAt: asDate(refund.occurredAt),
			amountMicros: refund.minorUnits
				? stripeMinorToMicros(BigInt(refund.amount), refund.currency)
				: BigInt(refund.amount),
			currency: refund.currency.toUpperCase(),
			environment: payment?.environment ?? "unknown",
		};
	});
	return {
		users: bounded(users).map((user) => ({ ...user, createdAt: asDate(user.createdAt) })),
		checkouts: bounded(checkouts).map((checkout) => ({
			...checkout,
			createdAt: asDate(checkout.createdAt),
		})),
		subscriptions: bounded(subscriptions).map((subscription) => ({
			...subscription,
			createdAt: asDate(subscription.createdAt),
			currentPeriodEnd: subscription.currentPeriodEnd
				? asDate(subscription.currentPeriodEnd)
				: null,
			renewalDisabledAt: subscription.renewalDisabledAt
				? asDate(subscription.renewalDisabledAt)
				: null,
			refundTerminationRequestedAt: subscription.refundTerminationRequestedAt
				? asDate(subscription.refundTerminationRequestedAt)
				: null,
		})),
		payments,
		refunds,
		openTickets: Number(tickets[0]?.count ?? 0),
	};
}
