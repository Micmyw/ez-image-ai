import { describe, expect, it } from "vitest";

import {
	classifyInitialSubscriptionPayment,
	freezeInitialSubscriptionPaymentEvidence,
} from "./admin-analytics-payment-evidence";

const initial = {
	periodStart: new Date("2026-10-01T00:00:00Z"),
	periodEnd: new Date("2026-11-01T00:00:00Z"),
};
const payment = { ...initial, providerPaymentId: "first-payment" };

describe("initial subscription payment provenance", () => {
	it("freezes a new trusted checkout, then fills only its matching first payment", () => {
		const pending = freezeInitialSubscriptionPaymentEvidence({
			existing: null,
			subscriptionCreated: true,
			checkoutIntentId: "checkout",
			initialPeriod: initial,
			payment: null,
		});
		expect(pending).toMatchObject({ checkoutIntentId: "checkout", providerPaymentId: null });
		const completed = freezeInitialSubscriptionPaymentEvidence({
			existing: pending,
			subscriptionCreated: false,
			checkoutIntentId: null,
			initialPeriod: null,
			payment,
		});
		expect(
			classifyInitialSubscriptionPayment(completed, "first-payment", initial.periodStart),
		).toBe(true);
		expect(classifyInitialSubscriptionPayment(completed, "renewal", initial.periodEnd)).toBe(false);
		expect(
			classifyInitialSubscriptionPayment(completed, "conflicting-payment", initial.periodStart),
		).toBeNull();
	});
	it("does not backfill historical subscriptions or overwrite first evidence on renewal/replay", () => {
		expect(
			freezeInitialSubscriptionPaymentEvidence({
				existing: null,
				subscriptionCreated: false,
				checkoutIntentId: "old",
				initialPeriod: initial,
				payment,
			}),
		).toBeNull();
		const frozen = freezeInitialSubscriptionPaymentEvidence({
			existing: null,
			subscriptionCreated: true,
			checkoutIntentId: "new",
			initialPeriod: initial,
			payment,
		});
		const renewal = {
			periodStart: initial.periodEnd,
			periodEnd: new Date("2026-12-01T00:00:00Z"),
			providerPaymentId: "renewal",
		};
		expect(
			freezeInitialSubscriptionPaymentEvidence({
				existing: frozen,
				subscriptionCreated: false,
				checkoutIntentId: "other",
				initialPeriod: renewal,
				payment: renewal,
			}),
		).toEqual(frozen);
		expect(
			classifyInitialSubscriptionPayment(null, "first-payment", initial.periodStart),
		).toBeNull();
	});
});
