import { describe, expect, it } from "vitest";

import {
	addUtcBillingMonth,
	calculateCumulativeCreditRefund,
	calculateProportionalCreditRefund,
	createAnnualBillingPeriods,
	isExactBillingInterval,
	shouldApplyRefundEvent,
	shouldApplySubscriptionEvent,
} from "./events";

describe("Stripe billing event semantics", () => {
	it("uses last-valid-day semantics for a month-end annual anchor", () => {
		const periods = createAnnualBillingPeriods({
			startsAt: new Date("2028-01-31T10:30:00.000Z"),
			creditsPerPeriod: 1_000n,
		});

		expect(periods).toHaveLength(12);
		expect(periods.slice(0, 4).map((period) => period.startsAt.toISOString())).toEqual([
			"2028-01-31T10:30:00.000Z",
			"2028-02-29T10:30:00.000Z",
			"2028-03-31T10:30:00.000Z",
			"2028-04-30T10:30:00.000Z",
		]);
		expect(periods[periods.length - 1]?.endsAt.toISOString()).toBe("2029-01-31T10:30:00.000Z");
	});

	it("preserves a non-EOM anchor and clamps only months that need it", () => {
		expect(addUtcBillingMonth(new Date("2027-01-30T05:00:00.000Z"), 1).toISOString()).toBe(
			"2027-02-28T05:00:00.000Z",
		);
		expect(addUtcBillingMonth(new Date("2027-01-30T05:00:00.000Z"), 2).toISOString()).toBe(
			"2027-03-30T05:00:00.000Z",
		);
	});

	it("validates monthly and annual service windows with UTC calendar boundaries", () => {
		const leapMonthStart = new Date("2028-01-31T10:30:00.000Z");
		expect(
			isExactBillingInterval({
				interval: "month",
				startsAt: leapMonthStart,
				endsAt: new Date("2028-02-29T10:30:00.000Z"),
			}),
		).toBe(true);
		expect(
			isExactBillingInterval({
				interval: "month",
				startsAt: leapMonthStart,
				endsAt: new Date("2028-02-28T10:30:00.000Z"),
			}),
		).toBe(false);
		expect(
			isExactBillingInterval({
				interval: "month",
				startsAt: leapMonthStart,
				endsAt: new Date("2028-03-01T10:30:00.000Z"),
			}),
		).toBe(false);
		expect(
			isExactBillingInterval({
				interval: "year",
				startsAt: new Date("2028-02-29T00:00:00.000Z"),
				endsAt: new Date("2029-02-28T00:00:00.000Z"),
			}),
		).toBe(true);
		expect(
			isExactBillingInterval({
				interval: "month",
				startsAt: new Date("2027-02-28T10:30:00.000Z"),
				endsAt: new Date("2027-03-30T10:30:00.000Z"),
			}),
		).toBe(true);
		expect(
			isExactBillingInterval({
				interval: "month",
				startsAt: new Date("2027-02-28T10:30:00.000Z"),
				endsAt: new Date("2027-03-31T10:30:00.000Z"),
			}),
		).toBe(true);
		expect(
			isExactBillingInterval({
				interval: "year",
				startsAt: new Date("2031-02-28T00:00:00.000Z"),
				endsAt: new Date("2032-02-29T00:00:00.000Z"),
			}),
		).toBe(true);
	});

	it("closes annual internal periods exactly at a hidden-anchor invoice end", () => {
		const invoiceEnd = new Date("2032-02-29T00:00:00.000Z");
		const periods = createAnnualBillingPeriods({
			startsAt: new Date("2031-02-28T00:00:00.000Z"),
			endsAt: invoiceEnd,
			creditsPerPeriod: 100n,
		});
		expect(periods.at(-1)?.endsAt).toEqual(invoiceEnd);
		for (let index = 1; index < periods.length; index += 1) {
			expect(periods[index]?.startsAt).toEqual(periods[index - 1]?.endsAt);
			expect(periods[index]!.endsAt.getTime()).toBeGreaterThan(periods[index]!.startsAt.getTime());
		}
	});

	it("caps cumulative partial refunds at the original invoice credits", () => {
		expect(
			calculateProportionalCreditRefund({
				invoicePaidAmount: 10_000n,
				invoiceCredits: 1_000n,
				refundAmount: 2_500n,
				creditsAlreadyRefunded: 0n,
			}),
		).toBe(250n);
		expect(
			calculateProportionalCreditRefund({
				invoicePaidAmount: 10_000n,
				invoiceCredits: 1_000n,
				refundAmount: 9_000n,
				creditsAlreadyRefunded: 250n,
			}),
		).toBe(750n);
	});

	it("uses cumulative BigInt rounding so many tiny refunds cannot drift or exceed the purchase", () => {
		expect(
			calculateCumulativeCreditRefund({
				invoicePaidAmount: 1_000n,
				invoiceCredits: 120n,
				cumulativeSucceededRefundAmount: 1n,
			}),
		).toBe(1n);
		expect(
			calculateCumulativeCreditRefund({
				invoicePaidAmount: 1_000n,
				invoiceCredits: 120n,
				cumulativeSucceededRefundAmount: 2n,
			}),
		).toBe(1n);
		expect(
			calculateCumulativeCreditRefund({
				invoicePaidAmount: 1_000n,
				invoiceCredits: 120n,
				cumulativeSucceededRefundAmount: 50_000n,
			}),
		).toBe(120n);
	});

	it("does not let an older event reverse newer or terminal subscription state", () => {
		const newer = new Date("2026-08-13T10:00:00.000Z");
		expect(
			shouldApplySubscriptionEvent({
				currentStatus: "CANCELED",
				lastEventCreatedAt: newer,
				lastEventId: "evt_newer",
				incomingStatus: "ACTIVE",
				incomingEventCreatedAt: new Date("2026-08-13T09:00:00.000Z"),
				incomingEventId: "evt_older",
			}),
		).toBe(false);
		expect(
			shouldApplySubscriptionEvent({
				currentStatus: "CANCELED",
				lastEventCreatedAt: newer,
				lastEventId: "evt_newer",
				incomingStatus: "ACTIVE",
				incomingEventCreatedAt: new Date("2026-08-13T11:00:00.000Z"),
				incomingEventId: "evt_later",
			}),
		).toBe(false);
	});

	it("refuses to guess subscription order from opaque event IDs at the same timestamp", () => {
		const timestamp = new Date("2026-08-13T10:00:00.000Z");
		expect(() =>
			shouldApplySubscriptionEvent({
				currentStatus: "ACTIVE",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_200",
				incomingStatus: "PAST_DUE",
				incomingEventCreatedAt: timestamp,
				incomingEventId: "evt_100",
			}),
		).toThrow("STRIPE_SUBSCRIPTION_EVENT_ORDER_AMBIGUOUS");
		expect(() =>
			shouldApplySubscriptionEvent({
				currentStatus: "ACTIVE",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_100",
				incomingStatus: "PAST_DUE",
				incomingEventCreatedAt: timestamp,
				incomingEventId: "evt_200",
			}),
		).toThrow("STRIPE_SUBSCRIPTION_EVENT_ORDER_AMBIGUOUS");
	});

	it("advances a same-second refund by lifecycle state rather than opaque event ID", () => {
		const timestamp = new Date("2026-08-13T10:00:00.000Z");
		expect(
			shouldApplyRefundEvent({
				currentStatus: "PENDING",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_z_pending",
				incomingStatus: "SUCCEEDED",
				incomingEventCreatedAt: timestamp,
				incomingEventId: "evt_a_succeeded",
			}),
		).toBe(true);
		expect(
			shouldApplyRefundEvent({
				currentStatus: "SUCCEEDED",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_a_succeeded",
				incomingStatus: "FAILED",
				incomingEventCreatedAt: new Date(timestamp.getTime() + 1_000),
				incomingEventId: "evt_later_failed",
			}),
		).toBe(false);
	});
});
