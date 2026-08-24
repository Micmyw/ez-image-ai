import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
	normalizeStripeInvoice,
	normalizeStripeInvoicePayment,
	normalizeStripeInvoicePaymentFailed,
	normalizeStripeRefund,
	normalizeStripeSubscription,
} from "./normalization";

describe("Stripe 2026-07-29.dahlia billing normalization", () => {
	it("uses the subscription item's billing period and price", () => {
		const subscription = {
			id: "sub_current_contract",
			object: "subscription",
			created: 1_800_000_000,
			customer: "cus_current_contract",
			status: "active",
			cancel_at_period_end: false,
			metadata: {
				billing_plan_id: "plan_internal",
				plan_key: "creator",
				owner_type: "USER",
				owner_id: "user_123",
				submitted_by_user_id: "user_123",
				secret_note: "must-not-survive-normalization",
			},
			items: {
				data: [
					{
						id: "si_current_contract",
						current_period_start: 1_800_000_100,
						current_period_end: 1_802_678_500,
						price: { id: "price_current_contract" },
					},
				],
			},
			// These legacy fields are deliberately wrong. Dahlia moved the period to items.
			current_period_start: 1,
			current_period_end: 2,
		} as unknown as Stripe.Subscription;

		expect(
			normalizeStripeSubscription(subscription, {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:00:00.000Z"),
				changeId: "evt_subscription_current_contract",
			}),
		).toEqual({
			kind: "SUBSCRIPTION",
			providerSubscriptionId: "sub_current_contract",
			customerId: "cus_current_contract",
			status: "ACTIVE",
			cancelAtPeriodEnd: false,
			currentPeriodStart: new Date(1_800_000_100_000),
			currentPeriodEnd: new Date(1_802_678_500_000),
			priceId: "price_current_contract",
			binding: {
				billingPlanId: "plan_internal",
				planKey: "creator",
				ownerType: "USER",
				ownerId: "user_123",
				submittedByUserId: "user_123",
			},
			context: {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:00:00.000Z"),
				changeId: "evt_subscription_current_contract",
			},
		});
	});

	it("uses the non-proration subscription line period instead of the invoice window", () => {
		const invoice = {
			id: "in_current_contract",
			object: "invoice",
			created: 1_800_000_000,
			amount_paid: 1_900,
			customer: "cus_current_contract",
			currency: "usd",
			billing_reason: "subscription_cycle",
			// Invoice-level dates describe the invoice item window, not the paid
			// subscription service period used for entitlement scheduling.
			period_start: 1_700_000_000,
			period_end: 1_700_000_100,
			parent: {
				type: "subscription_details",
				quote_details: null,
				subscription_details: {
					subscription: "sub_current_contract",
					metadata: null,
				},
			},
			lines: {
				data: [
					{
						id: "il_current_contract",
						period: { start: 1_800_000_000, end: 1_802_678_400 },
						parent: {
							type: "subscription_item_details",
							invoice_item_details: null,
							subscription_item_details: {
								invoice_item: null,
								proration: false,
								proration_details: null,
								subscription: "sub_current_contract",
								subscription_item: "si_current_contract",
							},
						},
						pricing: {
							type: "price_details",
							price_details: {
								price: "price_current_contract",
								product: "prod_current_contract",
							},
							unit_amount_decimal: "1900",
						},
					},
				],
			},
			// Legacy fields must not override the current API shape.
			subscription: "sub_wrong",
			charge: "ch_wrong",
		} as unknown as Stripe.Invoice;

		expect(
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_current_contract",
						providerChargeId: "ch_current_contract",
						providerPaymentIntentId: "pi_current_contract",
						amountPaid: 1_900n,
					},
				],
				{
					origin: "WEBHOOK",
					changeAt: new Date("2027-01-15T00:01:00.000Z"),
					changeId: "evt_invoice_current_contract",
				},
			),
		).toEqual({
			kind: "PAID_INVOICE",
			billingReason: "SUBSCRIPTION_CYCLE",
			providerInvoiceId: "in_current_contract",
			providerSubscriptionId: "sub_current_contract",
			customerId: "cus_current_contract",
			providerInvoicePaymentId: "inpay_current_contract",
			providerChargeId: "ch_current_contract",
			providerPaymentIntentId: "pi_current_contract",
			priceId: "price_current_contract",
			amountPaid: 1_900n,
			currency: "USD",
			periodStart: new Date(1_800_000_000_000),
			periodEnd: new Date(1_802_678_400_000),
			context: {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:01:00.000Z"),
				changeId: "evt_invoice_current_contract",
			},
		});
	});

	it("rejects a proration-only paid invoice instead of granting full plan entitlement", () => {
		const invoice = {
			id: "in_proration_only",
			amount_paid: 950,
			customer: "cus_proration_only",
			currency: "usd",
			billing_reason: "subscription_cycle",
			period_start: 1_800_000_000,
			period_end: 1_802_678_400,
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: "sub_proration_only" },
			},
			lines: {
				has_more: false,
				data: [
					{
						id: "il_proration_only",
						period: { start: 1_801_000_000, end: 1_802_678_400 },
						parent: {
							type: "subscription_item_details",
							invoice_item_details: null,
							subscription_item_details: {
								invoice_item: "ii_proration_only",
								proration: true,
								proration_details: { credited_items: null },
								subscription: "sub_proration_only",
								subscription_item: "si_proration_only",
							},
						},
						pricing: {
							type: "price_details",
							price_details: { price: "price_annual", product: "prod_annual" },
							unit_amount_decimal: "950",
						},
					},
				],
			},
		} as unknown as Stripe.Invoice;

		expect(() =>
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_proration_only",
						providerChargeId: "ch_proration_only",
						providerPaymentIntentId: "pi_proration_only",
						amountPaid: 950n,
					},
				],
				{
					origin: "WEBHOOK",
					changeAt: new Date("2027-01-15T00:01:00.000Z"),
					changeId: "evt_proration_only",
				},
			),
		).toThrow("STRIPE_INVOICE_PRORATION_UNSUPPORTED");
	});

	it("rejects a mixed recurring and same-price proration invoice", () => {
		const subscriptionLine = (id: string, proration: boolean) => ({
			id,
			period: { start: 1_800_000_000, end: 1_831_536_000 },
			parent: {
				type: "subscription_item_details",
				invoice_item_details: null,
				subscription_item_details: {
					invoice_item: proration ? `ii_${id}` : null,
					proration,
					proration_details: proration ? { credited_items: null } : null,
					subscription: "sub_mixed_proration",
					subscription_item: "si_mixed_proration",
				},
			},
			pricing: {
				type: "price_details",
				price_details: { price: "price_mixed_proration", product: "prod_mixed_proration" },
				unit_amount_decimal: proration ? "-500" : "7900",
			},
		});
		const invoice = {
			id: "in_mixed_proration",
			amount_paid: 7_400,
			customer: "cus_mixed_proration",
			currency: "usd",
			billing_reason: "subscription_cycle",
			period_start: 1_800_000_000,
			period_end: 1_831_536_000,
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: "sub_mixed_proration" },
			},
			lines: {
				has_more: false,
				data: [
					subscriptionLine("il_mixed_recurring", false),
					subscriptionLine("il_mixed_proration", true),
				],
			},
		} as unknown as Stripe.Invoice;

		expect(() =>
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_mixed_proration",
						providerChargeId: "ch_mixed_proration",
						providerPaymentIntentId: "pi_mixed_proration",
						amountPaid: 7_400n,
					},
				],
				{
					origin: "WEBHOOK",
					changeAt: new Date("2027-01-15T00:01:00.000Z"),
					changeId: "evt_mixed_proration",
				},
			),
		).toThrow("STRIPE_INVOICE_PRORATION_UNSUPPORTED");
	});

	it.each(["subscription_update", "manual", "subscription_threshold", null])(
		"rejects billing reason %s instead of granting a full subscription entitlement",
		(billingReason) => {
			const invoice = {
				id: `in_reason_${billingReason ?? "missing"}`,
				amount_paid: 1_900,
				customer: "cus_reason",
				currency: "usd",
				billing_reason: billingReason,
				parent: {
					type: "subscription_details",
					subscription_details: { subscription: "sub_reason" },
				},
				lines: {
					has_more: false,
					data: [
						{
							id: "il_reason",
							period: { start: 1_800_000_000, end: 1_802_678_400 },
							parent: {
								type: "subscription_item_details",
								subscription_item_details: {
									invoice_item: null,
									proration: false,
									proration_details: null,
									subscription: "sub_reason",
									subscription_item: "si_reason",
								},
							},
							pricing: {
								type: "price_details",
								price_details: { price: "price_reason", product: "prod_reason" },
							},
						},
					],
				},
			} as unknown as Stripe.Invoice;

			expect(() =>
				normalizeStripeInvoice(
					invoice,
					[
						{
							providerInvoicePaymentId: "inpay_reason",
							providerChargeId: "ch_reason",
							providerPaymentIntentId: "pi_reason",
							amountPaid: 1_900n,
						},
					],
					{
						origin: "WEBHOOK",
						changeAt: new Date("2027-01-15T00:01:00.000Z"),
						changeId: "evt_reason",
					},
				),
			).toThrow("STRIPE_INVOICE_BILLING_REASON_UNSUPPORTED");
		},
	);

	it("accepts subscription_create as an explicit full-entitlement reason", () => {
		const invoice = strictInvoiceFixture({ billing_reason: "subscription_create" });
		expect(
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_strict",
						providerChargeId: "ch_strict",
						providerPaymentIntentId: "pi_strict",
						amountPaid: 1_900n,
					},
				],
				{
					origin: "WEBHOOK",
					changeAt: new Date("2027-01-15T00:01:00.000Z"),
					changeId: "evt_strict",
				},
			),
		).toMatchObject({ kind: "PAID_INVOICE", billingReason: "SUBSCRIPTION_CREATE" });
	});

	it("rejects any extra invoice line instead of hiding it from refund allocation", () => {
		const strict = strictInvoiceFixture();
		const invoice = {
			...strict,
			lines: {
				...strict.lines,
				data: [
					...strict.lines.data,
					{
						id: "il_extra",
						amount: 500,
						period: { start: 1_800_000_000, end: 1_802_678_400 },
						parent: {
							type: "invoice_item_details",
							invoice_item_details: {
								invoice_item: "ii_extra",
								proration: false,
								proration_details: null,
								subscription: "sub_strict",
							},
						},
						pricing: null,
					},
				],
			},
		} as unknown as Stripe.Invoice;

		expect(() =>
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_strict",
						providerChargeId: "ch_strict",
						providerPaymentIntentId: "pi_strict",
						amountPaid: 1_900n,
					},
				],
				{
					origin: "WEBHOOK",
					changeAt: new Date("2027-01-15T00:01:00.000Z"),
					changeId: "evt_strict_extra_line",
				},
			),
		).toThrow("STRIPE_INVOICE_SUBSCRIPTION_LINE_AMBIGUOUS");
	});

	it("keeps the invoice customer on a payment-failed fact", () => {
		const invoice = {
			id: "in_payment_failed",
			customer: { id: "cus_payment_failed" },
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: "sub_payment_failed" },
			},
		} as unknown as Stripe.Invoice;

		expect(
			normalizeStripeInvoicePaymentFailed(invoice, {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:03:00.000Z"),
				changeId: "evt_invoice_payment_failed",
			}),
		).toMatchObject({
			kind: "INVOICE_PAYMENT_FAILED",
			providerInvoiceId: "in_payment_failed",
			providerSubscriptionId: "sub_payment_failed",
			customerId: "cus_payment_failed",
		});
	});

	it("rejects an invoice fact without a customer binding", () => {
		const invoice = {
			id: "in_customer_missing",
			customer: null,
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: "sub_customer_missing" },
			},
		} as unknown as Stripe.Invoice;

		expect(() =>
			normalizeStripeInvoicePaymentFailed(invoice, {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:04:00.000Z"),
				changeId: "evt_invoice_customer_missing",
			}),
		).toThrow("STRIPE_INVOICE_CUSTOMER_MISSING");
	});

	it("rejects a paid PaymentRecord as reviewable instead of pretending it has a charge", () => {
		const payment = {
			id: "inpay_payment_record",
			object: "invoice_payment",
			amount_paid: 1_900,
			amount_requested: 1_900,
			created: 1_800_000_000,
			currency: "usd",
			invoice: "in_payment_record",
			is_default: false,
			livemode: false,
			payment: { type: "payment_record", payment_record: "pyr_payment_record" },
			status: "paid",
			status_transitions: { paid_at: 1_800_000_001, canceled_at: null },
		} satisfies Stripe.InvoicePayment;

		expect(() => normalizeStripeInvoicePayment(payment)).toThrow(
			"STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED",
		);
	});

	it("rejects an invoice whose line summary is incomplete", () => {
		const invoice = {
			id: "in_incomplete_lines",
			amount_paid: 1_900,
			customer: "cus_incomplete_lines",
			currency: "usd",
			period_start: 1_800_000_000,
			period_end: 1_802_678_400,
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: "sub_incomplete_lines" },
			},
			lines: {
				has_more: true,
				data: [{ pricing: { price_details: { price: "price_incomplete_lines" } } }],
			},
		} as unknown as Stripe.Invoice;

		expect(() =>
			normalizeStripeInvoice(
				invoice,
				[
					{
						providerInvoicePaymentId: "inpay_incomplete_lines",
						providerChargeId: "ch_incomplete_lines",
						providerPaymentIntentId: null,
						amountPaid: 1_900n,
					},
				],
				{
					origin: "RECONCILIATION",
					changeAt: new Date("2027-01-15T00:00:00.000Z"),
					changeId: "stripe-reconcile:lines",
				},
			),
		).toThrow("STRIPE_INVOICE_LINES_INCOMPLETE");
	});

	it.each([
		["pending", "PENDING"],
		["requires_action", "REQUIRES_ACTION"],
		["succeeded", "SUCCEEDED"],
		["failed", "FAILED"],
		["canceled", "CANCELED"],
	] as const)("maps the %s refund state without treating it as success", (status, expected) => {
		const refund = {
			id: `re_${status}`,
			object: "refund",
			amount: 500,
			charge: "ch_current_contract",
			created: 1_800_000_010,
			currency: "usd",
			payment_intent: "pi_current_contract",
			status,
			metadata: { secret_note: "must-not-survive-normalization" },
		} as unknown as Stripe.Refund;

		expect(
			normalizeStripeRefund(refund, {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:02:00.000Z"),
				changeId: `evt_refund_${status}`,
			}),
		).toEqual({
			kind: "REFUND",
			providerRefundId: `re_${status}`,
			providerChargeId: "ch_current_contract",
			providerPaymentIntentId: "pi_current_contract",
			amount: 500n,
			currency: "USD",
			status: expected,
			providerCreatedAt: new Date(1_800_000_010_000),
			context: {
				origin: "WEBHOOK",
				changeAt: new Date("2027-01-15T00:02:00.000Z"),
				changeId: `evt_refund_${status}`,
			},
		});
	});
});

function strictInvoiceFixture(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
	return {
		id: "in_strict",
		amount_paid: 1_900,
		customer: "cus_strict",
		currency: "usd",
		billing_reason: "subscription_cycle",
		parent: {
			type: "subscription_details",
			subscription_details: { subscription: "sub_strict" },
		},
		lines: {
			has_more: false,
			data: [
				{
					id: "il_strict",
					period: { start: 1_800_000_000, end: 1_802_678_400 },
					parent: {
						type: "subscription_item_details",
						subscription_item_details: {
							invoice_item: null,
							proration: false,
							proration_details: null,
							subscription: "sub_strict",
							subscription_item: "si_strict",
						},
					},
					pricing: {
						type: "price_details",
						price_details: { price: "price_strict", product: "prod_strict" },
						unit_amount_decimal: "1900",
					},
				},
			],
		},
		...overrides,
	} as unknown as Stripe.Invoice;
}
