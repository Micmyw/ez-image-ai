import { adminScopeAllowsOwner, type AdminScope } from "./admin-scope";

export const ADMIN_ANALYTICS_RANGES = {
	"24h": 86_400_000,
	"7d": 604_800_000,
	"30d": 2_592_000_000,
} as const;
export const ADMIN_ANALYTICS_DIMENSIONS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
	"referrer",
	"country",
] as const;
export type AdminAnalyticsDimension = (typeof ADMIN_ANALYTICS_DIMENSIONS)[number];
export type AdminAnalyticsRange = keyof typeof ADMIN_ANALYTICS_RANGES;
export type AdminAnalyticsFilters = Partial<Record<AdminAnalyticsDimension, string | null>>;
export type AdminAnalyticsEnvironment = "production" | "test";
export const ADMIN_ANALYTICS_REPORT_MAX_DAYS = 92;

export interface AdminAnalyticsUser {
	id: string;
	role?: string | null;
	createdAt: Date;
	isAnonymous: boolean;
	legacyGuest: boolean;
	organizationIds: string[];
	registrationAttribution: unknown;
}
export interface AdminAnalyticsCheckout {
	id: string;
	ownerType: string;
	ownerId: string;
	userId: string | null;
	createdAt: Date;
}
/** One confirmed payment, never one monthly credit-grant projection. */
export interface AdminAnalyticsPayment {
	id: string;
	ownerType: string;
	ownerId: string;
	userId: string | null;
	checkoutIntentId: string | null;
	subscriptionId: string | null;
	paidAt: Date | null;
	amountMicros: bigint | null;
	currency: string | null;
	renewal: boolean | null;
	evidence: "verified" | "unknown";
	environment: AdminAnalyticsEnvironment | "unknown";
}
export interface AdminAnalyticsRefund {
	id: string;
	paymentId: string | null;
	ownerType: string;
	ownerId: string;
	occurredAt: Date;
	amountMicros: bigint;
	currency: string;
	environment: AdminAnalyticsEnvironment | "unknown";
}
export interface AdminAnalyticsSubscription {
	id: string;
	ownerType: string;
	ownerId: string;
	status: string;
	createdAt: Date;
	currentPeriodEnd: Date | null;
	renewalDisabledAt: Date | null;
	refundTerminationRequestedAt: Date | null;
}
export interface AdminAnalyticsFacts {
	users: AdminAnalyticsUser[];
	checkouts: AdminAnalyticsCheckout[];
	payments: AdminAnalyticsPayment[];
	refunds: AdminAnalyticsRefund[];
	subscriptions: AdminAnalyticsSubscription[];
	openTickets: number;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** null is unknown; "" is an observed untagged value. Missing historical fields stay unknown. */
export function adminAnalyticsAttribution(
	value: unknown,
): Record<AdminAnalyticsDimension, string | null> {
	const snapshot = record(value);
	const keys: Record<AdminAnalyticsDimension, string> = {
		utm_source: "utmSource",
		utm_medium: "utmMedium",
		utm_campaign: "utmCampaign",
		utm_term: "utmTerm",
		utm_content: "utmContent",
		referrer: "referrerOrigin",
		country: "country",
	};
	const valid = snapshot?.version === 1 && typeof snapshot.registeredAt === "string";
	return Object.fromEntries(
		ADMIN_ANALYTICS_DIMENSIONS.map((dimension) => {
			const key = keys[dimension];
			if (!valid || !(key in snapshot!)) return [dimension, null];
			if (dimension === "country") {
				return [
					dimension,
					snapshot!.countrySource === "registration_proxy" && typeof snapshot![key] === "string"
						? snapshot![key]
						: null,
				];
			}
			if (snapshot!.source === "unknown") return [dimension, null];
			const text = snapshot![key];
			return [dimension, text === null ? "" : typeof text === "string" ? text : null];
		}),
	) as Record<AdminAnalyticsDimension, string | null>;
}

function scopedFacts(facts: AdminAnalyticsFacts, scope: AdminScope): AdminAnalyticsFacts {
	const owner = (value: { ownerType: string; ownerId: string }) =>
		adminScopeAllowsOwner(scope, value);
	return {
		users: facts.users.filter(
			(user) =>
				!user.isAnonymous &&
				!user.legacyGuest &&
				(scope.kind === "platform" ||
					(scope.kind === "user"
						? user.id === scope.userId
						: user.organizationIds.includes(scope.organizationId))),
		),
		checkouts: facts.checkouts.filter(owner),
		payments: facts.payments.filter(owner),
		refunds: facts.refunds.filter(owner),
		subscriptions: facts.subscriptions.filter(owner),
		openTickets: facts.openTickets,
	};
}
function coverage(facts: AdminAnalyticsFacts, environment: AdminAnalyticsEnvironment) {
	return {
		unknownPaymentFacts: facts.payments.filter((payment) => payment.evidence === "unknown").length,
		unknownPaymentDates: facts.payments.filter((payment) => !payment.paidAt).length,
		unknownPaymentUsers: facts.payments.filter((payment) => !payment.userId).length,
		unknownRenewalKinds: facts.payments.filter((payment) => payment.renewal === null).length,
		unknownAttributionUsers: facts.users.filter((user) =>
			Object.values(adminAnalyticsAttribution(user.registrationAttribution)).every(
				(value) => value === null,
			),
		).length,
		trialingAvailable: false as const,
		excludedTestPayments:
			environment === "production"
				? facts.payments.filter((payment) => payment.environment === "test").length
				: 0,
		unclassifiedPayments: facts.payments.filter((payment) => payment.environment === "unknown")
			.length,
		unclassifiedRefunds: facts.refunds.filter(
			(refund) => refund.environment === "unknown" || !refund.paymentId,
		).length,
		unlinkedCheckoutPayments: facts.payments.filter((payment) => !payment.checkoutIntentId).length,
		unclassifiedSubscriptions: facts.subscriptions.filter(
			(subscription) =>
				!facts.payments.some(
					(payment) =>
						payment.subscriptionId === subscription.id && payment.environment !== "unknown",
				),
		).length,
	};
}
function selectEnvironment(
	facts: AdminAnalyticsFacts,
	environment: AdminAnalyticsEnvironment,
): AdminAnalyticsFacts {
	return {
		...facts,
		payments: facts.payments.filter((payment) => payment.environment === environment),
		refunds: facts.refunds.filter((refund) => refund.environment === environment),
		subscriptions: facts.subscriptions.filter((subscription) =>
			facts.payments.some(
				(payment) =>
					payment.subscriptionId === subscription.id && payment.environment === environment,
			),
		),
	};
}
function isActive(subscription: AdminAnalyticsSubscription, now: Date) {
	return (
		subscription.status === "ACTIVE" &&
		!subscription.refundTerminationRequestedAt &&
		subscription.currentPeriodEnd !== null &&
		subscription.currentPeriodEnd > now
	);
}
function inWindow(date: Date | null, from: Date, to: Date) {
	return date !== null && date >= from && date < to;
}
const ratio = (part: number, whole: number) =>
	whole ? Math.round((part / whole) * 10_000) / 10_000 : null;
function money(
	map: Map<string, { gross: bigint; refunded: bigint; orders: number }>,
	currency: string,
) {
	const code = currency.toUpperCase();
	const existing = map.get(code) ?? { gross: 0n, refunded: 0n, orders: 0 };
	map.set(code, existing);
	return existing;
}
function paymentMoney(payment: AdminAnalyticsPayment) {
	return (
		payment.evidence === "verified" && payment.amountMicros !== null && payment.currency !== null
	);
}

export function buildAdminAnalyticsOverview(
	facts: AdminAnalyticsFacts,
	scope: AdminScope,
	now = new Date(),
	environment: AdminAnalyticsEnvironment = "production",
) {
	const scoped = scopedFacts(facts, scope);
	const data = selectEnvironment(scoped, environment);
	const since = new Date(now.getTime() - ADMIN_ANALYTICS_RANGES["30d"]);
	const payments = data.payments.filter(
		(payment) => inWindow(payment.paidAt, since, now) && paymentMoney(payment),
	);
	const totals = new Map<string, { gross: bigint; refunded: bigint; orders: number }>();
	for (const payment of payments) {
		const item = money(totals, payment.currency!);
		item.gross += payment.amountMicros!;
		item.orders++;
		item.refunded += data.refunds
			.filter(
				(refund) =>
					refund.paymentId === payment.id &&
					refund.currency.toUpperCase() === payment.currency!.toUpperCase() &&
					refund.occurredAt < now,
			)
			.reduce((sum, refund) => sum + refund.amountMicros, 0n);
	}
	return {
		generatedAt: now.toISOString(),
		environment,
		users: {
			total: data.users.length,
			new24h: data.users.filter((user) =>
				inWindow(user.createdAt, new Date(now.getTime() - ADMIN_ANALYTICS_RANGES["24h"]), now),
			).length,
		},
		revenue30d: [...totals]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([currency, value]) => ({
				currency,
				grossMicros: value.gross.toString(),
				refundedMicros: value.refunded.toString(),
				netMicros: (value.gross - value.refunded).toString(),
				orders: value.orders,
			})),
		revenueBasis: "payments_in_last_30d_less_their_recorded_refunds" as const,
		subscriptions: {
			active: data.subscriptions.filter((subscription) => isActive(subscription, now)).length,
			trialing: null,
		},
		openTickets: data.openTickets,
		coverage: coverage(scoped, environment),
	};
}

export interface AdminAnalyticsFunnelInput {
	scope: AdminScope;
	range: AdminAnalyticsRange;
	groupBy: AdminAnalyticsDimension;
	filters?: AdminAnalyticsFilters;
	now?: Date;
	environment?: AdminAnalyticsEnvironment;
}
export function buildAdminAnalyticsFunnel(
	facts: AdminAnalyticsFacts,
	input: AdminAnalyticsFunnelInput,
) {
	const now = input.now ?? new Date();
	const environment = input.environment ?? "production";
	const scoped = scopedFacts(facts, input.scope);
	const data = selectEnvironment(scoped, environment);
	const since = new Date(now.getTime() - ADMIN_ANALYTICS_RANGES[input.range]);
	const cohort = data.users.filter(
		(user) => user.role !== "admin" && inWindow(user.createdAt, since, now),
	);
	const filters = input.filters ?? {};
	const users = cohort.filter((user) => {
		const attribution = adminAnalyticsAttribution(user.registrationAttribution);
		return ADMIN_ANALYTICS_DIMENSIONS.every(
			(dimension) =>
				filters[dimension] === undefined || filters[dimension] === attribution[dimension],
		);
	});
	const checkoutUsers = new Set(
		data.checkouts
			.filter((checkout) => checkout.createdAt < now)
			.map((checkout) => checkout.userId)
			.filter(Boolean),
	);
	const paidUsers = new Set(
		data.payments
			.filter(
				(payment) => payment.renewal === false && (payment.paidAt === null || payment.paidAt < now),
			)
			.map((payment) => payment.userId)
			.filter(Boolean),
	);
	const counts = (group: AdminAnalyticsUser[]) => ({
		signups: group.length,
		checkouts: group.filter((user) => checkoutUsers.has(user.id)).length,
		paid: group.filter((user) => paidUsers.has(user.id)).length,
	});
	const groups = new Map<string | null, AdminAnalyticsUser[]>();
	for (const user of users) {
		const value = adminAnalyticsAttribution(user.registrationAttribution)[input.groupBy];
		const group = groups.get(value) ?? [];
		group.push(user);
		groups.set(value, group);
	}
	const rows = [...groups]
		.map(([value, group]) => ({ value, ...counts(group) }))
		.sort((a, b) => b.signups - a.signups || String(a.value).localeCompare(String(b.value)));
	const options = Object.fromEntries(
		ADMIN_ANALYTICS_DIMENSIONS.map((dimension) => [
			dimension,
			[
				...new Set(
					cohort.map((user) => adminAnalyticsAttribution(user.registrationAttribution)[dimension]),
				),
			]
				.sort((a, b) => String(a).localeCompare(String(b)))
				.slice(0, 50),
		]),
	) as Record<AdminAnalyticsDimension, Array<string | null>>;
	return {
		environment,
		range: input.range,
		since: since.toISOString(),
		asOf: now.toISOString(),
		groupBy: input.groupBy,
		totals: counts(users),
		rows: rows.slice(0, 100),
		rowsTruncated: rows.length > 100,
		options,
		basis: "registration_cohort_lifetime_nonrenewal_payments" as const,
		countryBasis: "consented_registration_proxy" as const,
		coverage: coverage({ ...scoped, users: cohort }, environment),
	};
}

export interface AdminAnalyticsReportInput {
	scope: AdminScope;
	from: Date;
	to: Date;
	compare?: boolean;
	now?: Date;
	environment?: AdminAnalyticsEnvironment;
}
export function assertAdminAnalyticsReportPeriod(from: Date, to: Date) {
	const span = to.getTime() - from.getTime();
	if (!Number.isFinite(span) || span <= 0) throw new Error("ADMIN_ANALYTICS_INVALID_PERIOD");
	if (span > ADMIN_ANALYTICS_REPORT_MAX_DAYS * 86_400_000)
		throw new Error("ADMIN_ANALYTICS_PERIOD_TOO_LONG");
}
function reportPeriod(
	data: AdminAnalyticsFacts,
	from: Date,
	to: Date,
	uncertainPayers: ReadonlySet<string>,
) {
	const users = data.users.filter((user) => inWindow(user.createdAt, from, to));
	const checkouts = data.checkouts.filter((checkout) => inWindow(checkout.createdAt, from, to));
	const paid = data.payments.filter((payment) => inWindow(payment.paidAt, from, to));
	const nonrenewalPaidBeforeEnd = data.payments.filter(
		(payment) => payment.renewal === false && payment.paidAt !== null && payment.paidAt < to,
	);
	const paidCheckouts = new Set(
		nonrenewalPaidBeforeEnd.map((payment) => payment.checkoutIntentId).filter(Boolean),
	);
	const payingUsers = new Set(
		paid.map((payment) => payment.userId).filter((id): id is string => id !== null),
	);
	// An undated older payment prevents a claim that a payer is first-ever.
	const earlierPayers = new Set(
		data.payments
			.filter((payment) => payment.paidAt === null || payment.paidAt < from)
			.map((payment) => payment.userId)
			.filter(Boolean),
	);
	const cohortPaidUsers = new Set(
		nonrenewalPaidBeforeEnd.map((payment) => payment.userId).filter(Boolean),
	);
	const revenue = new Map<string, { gross: bigint; refunded: bigint; orders: number }>();
	for (const payment of paid) {
		if (paymentMoney(payment)) {
			const item = money(revenue, payment.currency!);
			item.gross += payment.amountMicros!;
			item.orders++;
		}
	}
	for (const refund of data.refunds.filter((refund) => inWindow(refund.occurredAt, from, to))) {
		money(revenue, refund.currency).refunded += refund.amountMicros;
	}
	return {
		from: from.toISOString(),
		to: to.toISOString(),
		users: { new: users.length },
		checkout: {
			users: new Set(checkouts.map((checkout) => checkout.userId).filter(Boolean)).size,
			orders: checkouts.length,
		},
		payments: {
			orders: paid.length,
			newPurchases: paid.filter((payment) => payment.renewal === false).length,
			renewals: paid.filter((payment) => payment.renewal === true).length,
			unknownPurchaseKinds: paid.filter((payment) => payment.renewal === null).length,
			payingUsers: payingUsers.size,
			firstTimePayers: [...payingUsers].filter(
				(user) => !earlierPayers.has(user) && !uncertainPayers.has(user),
			).length,
			revenue: [...revenue]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([currency, value]) => ({
					currency,
					grossMicros: value.gross.toString(),
					refundedMicros: value.refunded.toString(),
					netMicros: (value.gross - value.refunded).toString(),
				})),
		},
		rates: {
			checkoutToPaid: ratio(
				checkouts.filter((checkout) => paidCheckouts.has(checkout.id)).length,
				checkouts.length,
			),
			signupToPaid: ratio(
				users.filter((user) => cohortPaidUsers.has(user.id)).length,
				users.length,
			),
		},
		subscriptions: {
			new: data.subscriptions.filter((subscription) => inWindow(subscription.createdAt, from, to))
				.length,
			canceled: data.subscriptions.filter(
				(subscription) =>
					subscription.status === "CANCELED" && inWindow(subscription.renewalDisabledAt, from, to),
			).length,
		},
	};
}
export function buildAdminAnalyticsReport(
	facts: AdminAnalyticsFacts,
	input: AdminAnalyticsReportInput,
) {
	assertAdminAnalyticsReportPeriod(input.from, input.to);
	const now = input.now ?? new Date();
	const environment = input.environment ?? "production";
	const scoped = scopedFacts(facts, input.scope);
	const data = selectEnvironment(scoped, environment);
	const span = input.to.getTime() - input.from.getTime();
	const uncertainPayers = new Set(
		scoped.payments
			.filter(
				(payment) =>
					payment.environment === "unknown" ||
					(payment.environment === environment && payment.paidAt === null),
			)
			.map((payment) => payment.userId)
			.filter((userId): userId is string => userId !== null),
	);
	return {
		generatedAt: now.toISOString(),
		environment,
		current: reportPeriod(data, input.from, input.to, uncertainPayers),
		previous:
			input.compare === false
				? null
				: reportPeriod(data, new Date(input.from.getTime() - span), input.from, uncertainPayers),
		subscriptionsActiveNow: data.subscriptions.filter((subscription) => isActive(subscription, now))
			.length,
		revenueBasis: "payments_by_paid_at_refunds_by_occurred_at" as const,
		cancellationBasis: "currently_canceled_with_recorded_renewal_disabled_at" as const,
		coverage: coverage(scoped, environment),
	};
}
