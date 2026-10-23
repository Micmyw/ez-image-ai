import { growthExperimentVariant } from "@repo/config/growth-experiments";
import { describe, expect, it } from "vitest";

import type { AdminAnalyticsFacts, AdminAnalyticsPayment } from "./admin-analytics";
import { buildConversionExperiments } from "./conversion-experiments";
import type { ConversionEvent } from "./conversion-funnel";

const from = new Date("2026-10-01Z");
const to = new Date("2026-10-23Z");
const date = (day: number) => new Date(Date.UTC(2026, 9, day));
const hash = `sha256:${"a".repeat(64)}`;
const variant = growthExperimentVariant("pricing-default-v1", hash);
function event(
	name = "experiment_exposed",
	day = 2,
	browser = hash,
	userId: string | null = "u",
): ConversionEvent {
	return {
		id: `${name}:${day}:${browser}`,
		sessionHash: browser,
		userId,
		internal: false,
		name,
		path: "/pricing",
		source: "google",
		medium: null,
		campaign: null,
		device: "desktop",
		productKind: null,
		errorCategory: null,
		createdAt: date(day),
		diagnostics: {
			experimentId: "pricing-default-v1",
			variant: growthExperimentVariant("pricing-default-v1", browser),
		},
	};
}
function facts(): AdminAnalyticsFacts {
	return {
		users: ["u", "v", "admin"].map((id) => ({
			id,
			role: id === "admin" ? "admin" : "user",
			createdAt: from,
			isAnonymous: false,
			legacyGuest: false,
			organizationIds: [],
			registrationAttribution: null,
		})),
		checkouts: [{ id: "c", userId: "u", ownerType: "USER", ownerId: "u", createdAt: date(3) }],
		payments: [
			{
				id: "p",
				userId: "u",
				ownerType: "USER",
				ownerId: "u",
				checkoutIntentId: "c",
				subscriptionId: null,
				paidAt: date(4),
				amountMicros: 1_000_000n,
				currency: "USD",
				renewal: false,
				evidence: "verified",
				environment: "production",
			},
		],
		refunds: [],
		subscriptions: [],
		openTickets: 0,
	};
}
function row(data = facts(), events = [event()], start = from) {
	return buildConversionExperiments(data, events, start, to, {})[0]!.variants.find(
		(r) => r.variant === variant,
	)!;
}
describe("experiment conversion evidence", () => {
	it("deduplicates repeated exposures/clicks and counts a verified exact checkout only once", () => {
		expect(
			row(facts(), [
				event(),
				event("experiment_exposed", 5),
				event("experiment_clicked", 3),
				event("experiment_clicked", 4),
				event("purchase_clicked", 3),
			]),
		).toMatchObject({
			exposed: 1,
			clicked: 1,
			purchaseClicked: 1,
			checkouts: 1,
			paid: 1,
			mature: 1,
			maturePaid: 1,
		});
	});
	it.each<Partial<AdminAnalyticsPayment>>([
		{ environment: "test" },
		{ evidence: "unknown" },
		{ renewal: true },
		{ amountMicros: 0n },
		{ paidAt: null },
		{ paidAt: date(1) },
		{ paidAt: date(9) },
		{ checkoutIntentId: "unrelated" },
		{ ownerId: "v" },
	])("rejects nonqualifying payment %s", (patch) => {
		const data = facts();
		Object.assign(data.payments[0]!, patch);
		expect(row(data).paid).toBe(0);
	});
	it("does not attribute pre-exposure checkouts even if paid afterwards", () => {
		const data = facts();
		data.checkouts[0]!.createdAt = date(1);
		expect(row(data)).toMatchObject({ checkouts: 0, paid: 0 });
	});
	it("uses a click as direct exposure evidence and excludes administrators and forged variants", () => {
		expect(row(facts(), [event("experiment_clicked")])).toMatchObject({ exposed: 1, clicked: 1 });
		expect(
			row(facts(), [event(), { ...event("identity_observed", 5), internal: true }]).exposed,
		).toBe(0);
		expect(row(facts(), [event("experiment_exposed", 2, hash, "admin")]).exposed).toBe(0);
		expect(
			row(facts(), [
				{
					...event(),
					diagnostics: {
						experimentId: "pricing-default-v1",
						variant: variant === "annual" ? "monthly" : "annual",
					},
				},
			]).exposed,
		).toBe(0);
	});
	it("retains earliest exposure outside the selected range instead of re-enrolling returning browsers", () => {
		expect(row(facts(), [event(), event("experiment_exposed", 5)], date(4)).exposed).toBe(0);
	});
	it("keeps immature cohorts separate and never fabricates an account for an anonymous browser", () => {
		expect(row(facts(), [event("experiment_exposed", 22)])).toMatchObject({
			exposed: 1,
			mature: 0,
			maturePaid: 0,
		});
		expect(row(facts(), [event("experiment_exposed", 2, hash, null)])).toMatchObject({
			exposed: 1,
			linked: 0,
			paid: 0,
		});
	});
	it("reports shared-browser and multi-browser account ambiguity without double crediting money", () => {
		expect(row(facts(), [event(), event("identity_observed", 3, hash, "v")])).toMatchObject({
			exposed: 1,
			ambiguous: 1,
			paid: 0,
		});
		const result = buildConversionExperiments(
			facts(),
			[event(), event("experiment_exposed", 3, `sha256:${"b".repeat(64)}`)],
			from,
			to,
			{},
		)[0]!;
		expect(result.variants.reduce((n, r) => n + r.ambiguous, 0)).toBe(2);
		expect(result.variants.reduce((n, r) => n + r.paid, 0)).toBe(0);
	});
	it("filters cohorts by the exposure source and device", () => {
		const result = buildConversionExperiments(
			facts(),
			[event(), { ...event("experiment_clicked", 3), source: "direct" }],
			from,
			to,
			{ source: "google", device: "desktop" },
		);
		expect(result[0]!.variants.find((r) => r.variant === variant)?.clicked).toBe(1);
		expect(
			buildConversionExperiments(facts(), [event()], from, to, {
				source: "bing",
			})[0]!.variants.every((r) => r.exposed === 0),
		).toBe(true);
	});
});
