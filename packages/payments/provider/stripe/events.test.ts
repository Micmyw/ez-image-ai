import { describe, expect, it } from "vitest";

import {
	addUtcBillingMonth,
	calculateProportionalCreditRefund,
	createAnnualBillingPeriods,
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

	it("uses the event ID as a deterministic tie-breaker for equal provider timestamps", () => {
		const timestamp = new Date("2026-08-13T10:00:00.000Z");
		expect(
			shouldApplySubscriptionEvent({
				currentStatus: "ACTIVE",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_200",
				incomingStatus: "PAST_DUE",
				incomingEventCreatedAt: timestamp,
				incomingEventId: "evt_100",
			}),
		).toBe(false);
		expect(
			shouldApplySubscriptionEvent({
				currentStatus: "ACTIVE",
				lastEventCreatedAt: timestamp,
				lastEventId: "evt_100",
				incomingStatus: "PAST_DUE",
				incomingEventCreatedAt: timestamp,
				incomingEventId: "evt_200",
			}),
		).toBe(true);
	});
});
