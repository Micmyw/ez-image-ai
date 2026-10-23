import { describe, expect, it } from "vitest";

import type { AdminAnalyticsFacts } from "./admin-analytics";
import { buildAdminAnalyticsFunnel } from "./admin-analytics";
import {
	buildConversionFunnel,
	registrationSource,
	type ConversionEvent,
	type ConversionJob,
} from "./conversion-funnel";

const now = new Date("2026-10-21T12:00:00Z");
const createdAt = new Date("2026-10-20T12:00:00Z");
function facts(): AdminAnalyticsFacts {
	return {
		users: ["customer", "admin", "unknown"].map((id) => ({
			id,
			role: id === "admin" ? "admin" : "user",
			createdAt,
			isAnonymous: false,
			legacyGuest: false,
			organizationIds: [],
			registrationAttribution:
				id === "unknown"
					? null
					: {
							version: 1,
							registeredAt: createdAt.toISOString(),
							source: "campaign",
							utmSource: "chatgpt.com",
						},
		})),
		checkouts: [],
		payments: [],
		refunds: [],
		subscriptions: [],
		openTickets: 0,
	};
}
function event(
	name: string,
	userId: string | null = "customer",
	sessionHash = "browser",
): ConversionEvent {
	return {
		id: name,
		name,
		userId,
		sessionHash,
		internal: userId === "admin",
		path: "/",
		source: "chatgpt.com",
		medium: null,
		campaign: null,
		device: "mobile",
		productKind: "PLAN",
		errorCategory: null,
		createdAt,
	};
}
function job(id: string, status: string): ConversionJob {
	return {
		id,
		userId: "customer",
		createdAt: new Date(createdAt.getTime() + Number(id) * 1000),
		terminalAt: new Date(createdAt.getTime() + Number(id) * 1000 + 500),
		status,
		failureCode: status === "FAILED" ? "NO_USABLE_OUTPUT" : null,
		inputRejected: status === "FAILED",
	};
}
describe("customer conversion cohort", () => {
	it("separates existing customer activity and completed-job latency from browser observations", () => {
		const data = facts();
		data.users.push({ ...data.users[0]!, id: "returning", createdAt: new Date("2026-08-01Z") });
		const result = buildConversionFunnel(
			data,
			{
				events: [
					event("result_viewed"),
					event("result_viewed"),
					event("result_downloaded"),
					event("editor_generation_succeeded", "returning", "returning-browser"),
					event("result_viewed", "admin", "admin-browser"),
				],
				jobs: [
					job("1", "FAILED"),
					job("2", "SUCCEEDED"),
					{
						...job("3", "SUCCEEDED"),
						userId: "returning",
						terminalAt: new Date(createdAt.getTime() + 13000),
					},
					{ ...job("4", "RUNNING"), userId: "returning", terminalAt: null },
					{ ...job("5", "SUCCEEDED"), userId: "admin" },
				],
			},
			{ range: "7d", now },
		);
		expect(result.activity[0]).toMatchObject({
			cohort: "new",
			attemptedUsers: 1,
			jobs: 2,
			succeeded: 1,
			failed: 1,
			resultViewers: 1,
			downloaders: 1,
			latencySamples: 1,
			p50Ms: 500,
			p90Ms: 500,
		});
		expect(result.activity[1]).toMatchObject({
			cohort: "existing",
			attemptedUsers: 1,
			jobs: 2,
			succeeded: 1,
			resultViewers: 0,
			latencySamples: 1,
			p50Ms: 10000,
		});
		expect(result.totals.signups).toBe(2);
	});
	it("links visits to real registrations without treating ordinary login as signup", () => {
		const observations = {
			events: [
				{ ...event("page_viewed", null), createdAt: new Date(createdAt.getTime() - 1000) },
				event("identity_observed"),
			],
			jobs: [job("1", "SUCCEEDED")],
		};
		expect(
			buildConversionFunnel(facts(), observations, { range: "7d", now }).visitorCohort
				.registeredBrowsers,
		).toBe(0);
		observations.events.push({ ...event("registration_confirmed"), id: "registration:customer" });
		expect(
			buildConversionFunnel(facts(), observations, { range: "7d", now }).visitorCohort,
		).toEqual({
			registeredBrowsers: 1,
			successfulBrowsers: 1,
			paidBrowsers: 0,
			registrationRate: 1,
		});
		observations.events[0]!.createdAt = new Date(createdAt.getTime() + 1000);
		expect(
			buildConversionFunnel(facts(), observations, { range: "7d", now }).visitorCohort
				.registeredBrowsers,
		).toBe(0);
	});
	it("also excludes administrators in the existing source-dimension funnel", () => {
		expect(
			buildAdminAnalyticsFunnel(facts(), {
				scope: { kind: "platform" },
				range: "30d",
				groupBy: "utm_source",
				now,
			}).totals.signups,
		).toBe(2);
	});
	it("excludes internal browser history, deduplicates customers and retains unknown source", () => {
		const result = buildConversionFunnel(
			facts(),
			{
				events: [
					event("page_viewed", null, "admin-browser"),
					event("identity_observed", "admin", "admin-browser"),
					event("page_viewed"),
					event("purchase_clicked"),
					{ ...event("purchase_clicked"), id: "second-click" },
				],
				jobs: [job("1", "FAILED"), job("2", "SUCCEEDED")],
			},
			{ range: "30d", now },
		);
		expect(result.totals).toMatchObject({
			signups: 2,
			generated: 1,
			succeeded: 1,
			purchaseClicked: 1,
			checkouts: 0,
			paid: 0,
		});
		expect(result.traffic.browsers).toBe(1);
		expect(result.firstAttempt).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
		expect(result.failures).toEqual([{ reason: "INPUT_CONTENT_REJECTED", jobs: 1 }]);
		expect(result.coverage.unknownSourceUsers).toBe(1);
	});
	it("never treats browser activation, unverified, test, renewal or undated payments as paid", () => {
		const data = facts();
		const payment = {
			id: "p",
			ownerType: "USER",
			ownerId: "customer",
			userId: "customer",
			checkoutIntentId: null,
			subscriptionId: null,
			paidAt: createdAt,
			amountMicros: 1000000n,
			currency: "USD",
			renewal: false,
			evidence: "verified" as const,
			environment: "production" as const,
		};
		data.payments = [
			{ ...payment, evidence: "unknown" },
			{ ...payment, environment: "test" },
			{ ...payment, renewal: true },
			{ ...payment, paidAt: null },
		];
		const observations = { events: [event("subscription_activated")], jobs: [] };
		expect(buildConversionFunnel(data, observations, { range: "7d", now }).totals.paid).toBe(0);
		data.payments.push(payment);
		expect(buildConversionFunnel(data, observations, { range: "7d", now }).totals.paid).toBe(1);
	});
	it("uses the same registration cohort for source/device filtering, with missing devices unknown", () => {
		const result = buildConversionFunnel(
			facts(),
			{ events: [event("page_viewed")], jobs: [job("1", "SUCCEEDED")] },
			{ range: "7d", now, source: "chatgpt.com", device: "mobile" },
		);
		expect(result.totals).toMatchObject({ signups: 1, generated: 1, succeeded: 1 });
		expect(result.rows).toHaveLength(1);
		expect(
			registrationSource({
				version: 1,
				registeredAt: "date",
				source: "referral",
				referrerOrigin: "https://chatgpt.com",
			}),
		).toBe("chatgpt.com");
		expect(registrationSource(null)).toBe("unknown");
		expect(registrationSource({ version: 1, registeredAt: "date", source: "direct" })).toBe(
			"direct",
		);
	});
});
