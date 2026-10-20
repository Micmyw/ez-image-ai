import { describe, expect, it } from "vitest";

import {
	adminAnalyticsAttribution,
	assertAdminAnalyticsReportPeriod,
	buildAdminAnalyticsFunnel,
	buildAdminAnalyticsOverview,
	buildAdminAnalyticsReport,
	type AdminAnalyticsFacts,
	type AdminAnalyticsPayment,
	type AdminAnalyticsUser,
} from "./admin-analytics";

const now = new Date("2026-10-20T12:00:00Z");
const platform = { kind: "platform" as const };
const day = 86_400_000;
const ago = (days: number) => new Date(now.getTime() - day * days);
const attribution = (source: string | null) => ({
	version: 1,
	registeredAt: ago(1).toISOString(),
	source: source ? "campaign" : "direct",
	utmSource: source,
	utmMedium: null,
	utmCampaign: null,
	referrerOrigin: null,
	utmTerm: null,
	utmContent: null,
	country: "US",
	countrySource: "registration_proxy",
});
function user(id: string, overrides: Partial<AdminAnalyticsUser> = {}): AdminAnalyticsUser {
	return {
		id,
		createdAt: ago(1),
		isAnonymous: false,
		legacyGuest: false,
		organizationIds: [],
		registrationAttribution: attribution("google"),
		...overrides,
	};
}
function payment(
	id: string,
	overrides: Partial<AdminAnalyticsPayment> = {},
): AdminAnalyticsPayment {
	return {
		id,
		ownerType: "USER",
		ownerId: "a",
		userId: "a",
		checkoutIntentId: "a-checkout",
		subscriptionId: null,
		paidAt: ago(0.5),
		amountMicros: 1_000_000n,
		currency: "USD",
		renewal: false,
		evidence: "verified",
		environment: "production",
		...overrides,
	};
}
function facts(overrides: Partial<AdminAnalyticsFacts> = {}): AdminAnalyticsFacts {
	return {
		users: [user("a")],
		checkouts: [
			{ id: "a-checkout", ownerType: "USER", ownerId: "a", userId: "a", createdAt: ago(0.7) },
		],
		payments: [payment("p")],
		refunds: [],
		subscriptions: [],
		openTickets: 3,
		...overrides,
	};
}

describe("administration analytics business meaning", () => {
	it("deduplicates users, excludes anonymous and legacy guests, and keeps refunded historical conversion", () => {
		const data = facts({
			users: [
				user("a"),
				user("b"),
				user("guest", { isAnonymous: true }),
				user("old-guest", { legacyGuest: true }),
			],
			checkouts: [
				{ id: "c1", ownerType: "USER", ownerId: "a", userId: "a", createdAt: ago(0.8) },
				{ id: "c2", ownerType: "USER", ownerId: "a", userId: "a", createdAt: ago(0.7) },
			],
			payments: [
				payment("p"),
				payment("p2"),
				payment("renewal-only", { userId: "b", ownerId: "b", renewal: true }),
			],
			refunds: [
				{
					id: "r",
					paymentId: "p",
					ownerType: "USER",
					ownerId: "a",
					occurredAt: ago(0.1),
					amountMicros: 1_000_000n,
					currency: "USD",
					environment: "production",
				},
			],
		});
		expect(
			buildAdminAnalyticsFunnel(data, { scope: platform, range: "7d", groupBy: "utm_source", now })
				.totals,
		).toEqual({ signups: 2, checkouts: 1, paid: 1 });
	});

	it("keeps all, observed empty, and historical unknown filters distinct across seven dimensions", () => {
		const old = attribution(null);
		delete (old as Partial<typeof old>).utmTerm;
		const data = facts({
			users: [
				user("a", { registrationAttribution: attribution(null) }),
				user("b", { registrationAttribution: null }),
				user("old", { registrationAttribution: old }),
			],
		});
		const run = (filters: { utm_term?: string | null }) =>
			buildAdminAnalyticsFunnel(data, {
				scope: platform,
				range: "7d",
				groupBy: "utm_term",
				filters,
				now,
			});
		expect(run({}).totals.signups).toBe(3);
		expect(run({ utm_term: "" }).totals.signups).toBe(1);
		expect(run({ utm_term: null }).totals.signups).toBe(2);
		expect(run({ utm_term: "" }).options.utm_term).toEqual(["", null]);
		expect(adminAnalyticsAttribution(attribution(null)).country).toBe("US");
		expect(
			adminAnalyticsAttribution({ ...attribution(null), countrySource: undefined }).country,
		).toBeNull();
	});

	it("isolates organization and personal business facts even for the same member", () => {
		const data = facts({
			users: [user("a", { organizationIds: ["org-a"] }), user("b", { organizationIds: ["org-b"] })],
			payments: [
				payment("personal"),
				payment("org", { ownerType: "ORGANIZATION", ownerId: "org-a", amountMicros: 7_000_000n }),
				payment("foreign", {
					ownerType: "ORGANIZATION",
					ownerId: "org-b",
					amountMicros: 90_000_000n,
				}),
			],
		});
		expect(
			buildAdminAnalyticsOverview(data, { kind: "organization", organizationId: "org-a" }, now),
		).toMatchObject({ users: { total: 1 }, revenue30d: [{ netMicros: "7000000", orders: 1 }] });
		expect(buildAdminAnalyticsOverview(data, { kind: "user", userId: "a" }, now)).toMatchObject({
			revenue30d: [{ netMicros: "1000000", orders: 1 }],
		});
	});

	it("separates currencies, keeps exact bigint amounts, and distinguishes overview vs period refunds", () => {
		const huge = 9_007_199_254_740_993n;
		const data = facts({
			payments: [
				payment("old", { paidAt: ago(40), amountMicros: huge }),
				payment("usd", { amountMicros: huge }),
				payment("cny", { currency: "CNY", amountMicros: 6_000_000n }),
			],
			refunds: [
				{
					id: "late",
					paymentId: "old",
					ownerType: "USER",
					ownerId: "a",
					occurredAt: ago(0.1),
					amountMicros: 1_000_000n,
					currency: "USD",
					environment: "production",
				},
			],
		});
		expect(buildAdminAnalyticsOverview(data, platform, now).revenue30d).toEqual([
			{
				currency: "CNY",
				grossMicros: "6000000",
				refundedMicros: "0",
				netMicros: "6000000",
				orders: 1,
			},
			{
				currency: "USD",
				grossMicros: huge.toString(),
				refundedMicros: "0",
				netMicros: huge.toString(),
				orders: 1,
			},
		]);
		const report = buildAdminAnalyticsReport(data, { scope: platform, from: ago(1), to: now, now });
		expect(report.current.payments.revenue[1]).toEqual({
			currency: "USD",
			grossMicros: huge.toString(),
			refundedMicros: "1000000",
			netMicros: (huge - 1_000_000n).toString(),
		});
		expect(report.current.payments.firstTimePayers).toBe(0);
	});

	it("defaults to production, excludes test/unclassified money, and never invents trial or payment dates", () => {
		const data = facts({
			payments: [
				payment("live"),
				payment("test", { environment: "test", amountMicros: 99_000_000n }),
				payment("unknown", {
					environment: "unknown",
					evidence: "unknown",
					paidAt: null,
					amountMicros: null,
					currency: null,
					renewal: null,
				}),
			],
		});
		const overview = buildAdminAnalyticsOverview(data, platform, now);
		expect(overview.revenue30d[0]?.netMicros).toBe("1000000");
		expect(overview.subscriptions.trialing).toBeNull();
		expect(overview.coverage).toMatchObject({
			excludedTestPayments: 1,
			unclassifiedPayments: 1,
			unknownPaymentDates: 1,
			trialingAvailable: false,
		});
		expect(buildAdminAnalyticsOverview(data, platform, now, "test").revenue30d[0]?.netMicros).toBe(
			"99000000",
		);
		const report = buildAdminAnalyticsReport(data, {
			scope: platform,
			from: ago(1),
			to: now,
			now,
		});
		expect(report.current.payments.payingUsers).toBe(1);
		expect(report.current.payments.firstTimePayers).toBe(0);
		const testOnlyUnknownDate = buildAdminAnalyticsReport(
			facts({
				payments: [payment("live"), payment("test", { environment: "test", paidAt: null })],
			}),
			{ scope: platform, from: ago(1), to: now, now },
		);
		expect(testOnlyUnknownDate.current.payments.firstTimePayers).toBe(1);
	});

	it("uses the requested period instead of the cohort window and compares equal half-open periods", () => {
		const data = facts({
			users: [user("a", { createdAt: ago(2) })],
			payments: [payment("p", { paidAt: ago(0.2) })],
		});
		const funnel = buildAdminAnalyticsFunnel(data, {
			scope: platform,
			range: "7d",
			groupBy: "utm_source",
			now,
		});
		expect(funnel.totals.paid).toBe(1);
		const report = buildAdminAnalyticsReport(data, {
			scope: platform,
			from: ago(3),
			to: ago(1),
			now,
		});
		expect(report.current.payments.orders).toBe(0);
		expect(report.current.rates.signupToPaid).toBe(0);
		expect(report.previous?.to).toBe(ago(3).toISOString());
		expect(report.previous?.from).toBe(ago(5).toISOString());
		const empty = buildAdminAnalyticsReport(facts({ users: [], checkouts: [], payments: [] }), {
			scope: platform,
			from: ago(1),
			to: now,
			now,
		});
		expect(empty.current.rates).toEqual({ checkoutToPaid: null, signupToPaid: null });
	});

	it("rejects inverted/overlong ranges while accepting the 92-day boundary", () => {
		expect(() => assertAdminAnalyticsReportPeriod(now, ago(1))).toThrow(
			"ADMIN_ANALYTICS_INVALID_PERIOD",
		);
		expect(() => assertAdminAnalyticsReportPeriod(ago(93), now)).toThrow(
			"ADMIN_ANALYTICS_PERIOD_TOO_LONG",
		);
		expect(() => assertAdminAnalyticsReportPeriod(ago(92), now)).not.toThrow();
	});
});
