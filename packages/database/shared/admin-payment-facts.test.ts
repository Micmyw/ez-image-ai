import { describe, expect, it } from "vitest";

import {
	normalizeSubscriptionPaymentEvidence,
	stripeMinorToMicros,
	type AdminPaymentPeriodEvidence,
} from "./admin-payment-facts";

const period: AdminPaymentPeriodEvidence = {
	provider: "paypal",
	providerSubscriptionId: "I-1",
	providerInvoicePaymentId: "paypal:SALE-1",
	providerInvoiceId: null,
	paidAmount: 19_000_000n,
};
const receipt = {
	provider: "paypal",
	providerEnvironment: "sandbox",
	verifiedAt: new Date(),
	status: "PROCESSED",
	envelope: {
		event_type: "PAYMENT.SALE.COMPLETED",
		create_time: "2026-10-20T00:02:00Z",
		resource: {
			id: "SALE-1",
			billing_agreement_id: "I-1",
			create_time: "2026-10-20T00:00:00Z",
			amount: { total: "19.00", currency: "USD" },
		},
	},
};

describe("administrator historical payment evidence", () => {
	it("treats twelve annual projections as one payment and preserves provider payment time", () => {
		expect(
			normalizeSubscriptionPaymentEvidence(
				Array.from({ length: 12 }, () => period),
				[receipt],
			),
		).toMatchObject({
			evidence: "verified",
			amountMicros: 19_000_000n,
			currency: "USD",
			paidAt: new Date("2026-10-20T00:00:00Z"),
			firstPayment: null,
		});
	});
	it("does not infer money from pending, unverified, wrong-owner or conflicting receipts", () => {
		for (const event of [
			{ ...receipt, status: "FAILED" },
			{ ...receipt, verifiedAt: null },
			{
				...receipt,
				envelope: {
					...receipt.envelope,
					resource: { ...receipt.envelope.resource, billing_agreement_id: "I-OTHER" },
				},
			},
		])
			expect(normalizeSubscriptionPaymentEvidence([period], [event]).evidence).toBe("unknown");
		expect(
			normalizeSubscriptionPaymentEvidence(
				[period, { ...period, paidAmount: 18_000_000n }],
				[receipt],
			),
		).toEqual({ evidence: "unknown", reason: "PAYMENT_PROJECTION_CONFLICT" });
	});
	it("requires actual Stripe paid time and currency instead of falling back to event or plan fields", () => {
		const stripe = {
			...period,
			provider: "stripe",
			providerInvoicePaymentId: "inpay_1",
			providerInvoiceId: "in_1",
			paidAmount: 1900n,
		};
		const event = {
			...receipt,
			provider: "stripe",
			providerEnvironment: null,
			envelope: {
				type: "invoice.paid",
				livemode: false,
				created: 10,
				data: {
					object: {
						id: "in_1",
						subscription: "I-1",
						amount_paid: 1900,
						currency: "usd",
						billing_reason: "subscription_create",
						status_transitions: { paid_at: 100 },
					},
				},
			},
		};
		expect(normalizeSubscriptionPaymentEvidence([stripe], [event])).toMatchObject({
			evidence: "verified",
			amountMicros: 19_000_000n,
			firstPayment: true,
			paidAt: new Date(100_000),
		});
		event.envelope.data.object.status_transitions = {} as never;
		expect(normalizeSubscriptionPaymentEvidence([stripe], [event]).evidence).toBe("unknown");
	});
	it("separates zero, two and three decimal currencies in Stripe minor amounts", () => {
		expect(stripeMinorToMicros(100n, "JPY")).toBe(100_000_000n);
		expect(stripeMinorToMicros(100n, "USD")).toBe(1_000_000n);
		expect(stripeMinorToMicros(100n, "KWD")).toBe(100_000n);
	});
});
