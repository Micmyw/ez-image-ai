import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { normalizeStripePaymentEvent } from "./event-normalizer";

describe("Stripe payment event normalization boundary", () => {
	it("uses InvoicePayment for a Dahlia invoice and drops non-allowlisted raw fields", async () => {
		const listInvoicePayments = vi.fn().mockResolvedValue([
			{
				id: "inpay_current",
				status: "paid",
				amount_paid: 1_900,
				payment: {
					type: "payment_intent",
					payment_intent: { id: "pi_current", latest_charge: "ch_current" },
				},
			} as unknown as Stripe.InvoicePayment,
		]);
		const normalized = await normalizeStripePaymentEvent(
			{
				id: "evt_current_invoice",
				type: "invoice.paid",
				created: 1_800_000_000,
				api_version: "2026-07-29.dahlia",
				data: {
					object: {
						id: "in_current",
						customer: "cus_current",
						amount_paid: 1_900,
						currency: "usd",
						billing_reason: "subscription_cycle",
						period_start: 1_800_000_000,
						period_end: 1_802_678_400,
						parent: {
							type: "subscription_details",
							subscription_details: { subscription: "sub_current" },
						},
						lines: {
							data: [
								{
									period: { start: 1_800_000_000, end: 1_802_678_400 },
									parent: {
										type: "subscription_item_details",
										subscription_item_details: {
											invoice_item: null,
											proration: false,
											proration_details: null,
											subscription: "sub_current",
											subscription_item: "si_current",
										},
									},
									pricing: {
										type: "price_details",
										price_details: { price: "price_current" },
									},
								},
							],
						},
						metadata: { secret_note: "must-not-cross-boundary" },
					},
				},
			},
			{ billingSource: { listInvoicePayments } },
		);

		expect(listInvoicePayments).toHaveBeenCalledWith("in_current");
		expect(normalized.fact).toMatchObject({
			kind: "PAID_INVOICE",
			customerId: "cus_current",
			providerInvoicePaymentId: "inpay_current",
			providerPaymentIntentId: "pi_current",
			providerChargeId: "ch_current",
		});
		expect(
			JSON.stringify(normalized, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			),
		).not.toContain("must-not-cross-boundary");
	});

	it("maps explicit legacy subscription-line fields without inventing entitlement data", async () => {
		const normalized = await normalizeStripePaymentEvent({
			id: "evt_legacy_invoice",
			type: "invoice.paid",
			created: 1_800_000_001,
			api_version: "2026-07-29.basil",
			data: {
				object: {
					id: "in_legacy",
					customer: "cus_legacy",
					subscription: "sub_legacy",
					charge: "ch_legacy",
					payment_intent: "pi_legacy",
					amount_paid: 1_900,
					currency: "usd",
					billing_reason: "subscription_cycle",
					period_start: 1,
					period_end: 2,
					lines: {
						has_more: false,
						data: [
							{
								id: "il_legacy",
								subscription: "sub_legacy",
								subscription_item: "si_legacy",
								proration: false,
								period: { start: 1_800_000_000, end: 1_802_678_400 },
								price: { id: "price_legacy" },
							},
						],
					},
				},
			},
		});

		expect(normalized.fact).toMatchObject({
			kind: "PAID_INVOICE",
			periodStart: new Date(1_800_000_000_000),
			periodEnd: new Date(1_802_678_400_000),
		});
	});

	it("fails closed when a legacy line omits explicit proration or period fields", async () => {
		await expect(
			normalizeStripePaymentEvent({
				id: "evt_legacy_invoice_incomplete",
				type: "invoice.paid",
				created: 1_800_000_001,
				api_version: "2026-07-29.basil",
				data: {
					object: {
						id: "in_legacy_incomplete",
						customer: "cus_legacy_incomplete",
						subscription: "sub_legacy_incomplete",
						charge: "ch_legacy_incomplete",
						amount_paid: 1_900,
						currency: "usd",
						billing_reason: "subscription_cycle",
						lines: { data: [{ price: { id: "price_legacy_incomplete" } }] },
					},
				},
			}),
		).rejects.toThrow("STRIPE_INVOICE_SUBSCRIPTION_LINE_INVALID");
	});

	it("requires a server-side InvoicePayment source for the current API", async () => {
		await expect(
			normalizeStripePaymentEvent({
				id: "evt_current_invoice_without_source",
				type: "invoice.paid",
				created: 1_800_000_000,
				api_version: "2026-07-29.dahlia",
				data: { object: { id: "in_current_without_source" } },
			}),
		).rejects.toThrow("STRIPE_INVOICE_PAYMENT_SOURCE_REQUIRED");
	});

	it("preserves a terminal InvoicePayment normalization code instead of masking it as a source failure", async () => {
		const listInvoicePayments = vi.fn().mockResolvedValue([
			{
				id: "inpay_payment_record",
				status: "paid",
				amount_paid: 1_900,
				payment: { type: "payment_record", payment_record: "pr_external" },
			} as unknown as Stripe.InvoicePayment,
		]);

		await expect(
			normalizeStripePaymentEvent(
				{
					id: "evt_payment_record",
					type: "invoice.paid",
					created: 1_800_000_000,
					api_version: "2026-07-29.dahlia",
					data: { object: { id: "in_payment_record" } },
				},
				{ billingSource: { listInvoicePayments } },
			),
		).rejects.toThrow("STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED");
	});

	it("never infers a missing refund status as succeeded", async () => {
		await expect(
			normalizeStripePaymentEvent({
				id: "evt_refund_without_status",
				type: "refund.created",
				created: 1_800_000_000,
				api_version: "2026-07-29.dahlia",
				data: {
					object: {
						id: "re_without_status",
						charge: "ch_without_status",
						amount: 100,
						currency: "usd",
						created: 1_800_000_000,
						status: null,
					},
				},
			}),
		).rejects.toThrow("STRIPE_REFUND_STATUS_UNSUPPORTED");
	});
});
