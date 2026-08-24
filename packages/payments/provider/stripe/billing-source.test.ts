import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { createStripeBillingSource } from "./billing-source";

describe("Stripe billing source", () => {
	it("pages subscriptions with the durable sweep cutoff and cursor", async () => {
		const list = vi.fn().mockResolvedValue({
			data: [
				{
					id: "sub_page_2",
					object: "subscription",
					created: 1_800_000_000,
					customer: "cus_page_2",
					status: "active",
					cancel_at_period_end: false,
					metadata: {},
					items: {
						data: [
							{
								id: "si_page_2",
								current_period_start: 1_800_000_000,
								current_period_end: 1_802_678_400,
								price: { id: "price_page_2" },
							},
						],
					},
				},
			],
			has_more: true,
		});
		const source = createStripeBillingSource({
			subscriptions: { list },
		} as unknown as Stripe);
		const cutoff = new Date("2027-01-15T12:00:00.000Z");

		await expect(
			source.listSubscriptionsPage({
				cutoff,
				cursor: "sub_page_1",
				limit: 25,
				sweepId: "sweep_fixed",
			}),
		).resolves.toMatchObject({ hasMore: true, nextCursor: "sub_page_2" });
		expect(list).toHaveBeenCalledWith({
			status: "all",
			created: { lte: Math.floor(cutoff.getTime() / 1_000) },
			starting_after: "sub_page_1",
			limit: 25,
		});
	});

	it("lists paid invoice payments and normalizes their charge instead of reading invoice.charge", async () => {
		const invoicesList = vi.fn().mockResolvedValue({
			data: [
				{
					id: "in_page_1",
					object: "invoice",
					created: 1_800_000_000,
					amount_paid: 1_900,
					customer: "cus_page_1",
					currency: "usd",
					billing_reason: "subscription_cycle",
					period_start: 1_800_000_000,
					period_end: 1_802_678_400,
					parent: {
						type: "subscription_details",
						quote_details: null,
						subscription_details: {
							subscription: "sub_page_1",
							metadata: null,
						},
					},
					lines: {
						data: [
							{
								id: "il_page_1",
								period: { start: 1_800_000_000, end: 1_802_678_400 },
								parent: {
									type: "subscription_item_details",
									subscription_item_details: {
										invoice_item: null,
										proration: false,
										proration_details: null,
										subscription: "sub_page_1",
										subscription_item: "si_page_1",
									},
								},
								pricing: {
									type: "price_details",
									price_details: { price: "price_page_1", product: "prod_page_1" },
									unit_amount_decimal: "1900",
								},
							},
						],
					},
					charge: "ch_removed_field",
				},
			],
			has_more: false,
		});
		const invoicePaymentsList = vi.fn().mockResolvedValue({
			data: [
				{
					id: "inpay_page_1",
					object: "invoice_payment",
					invoice: "in_page_1",
					status: "paid",
					amount_paid: 1_900,
					payment: {
						type: "payment_intent",
						payment_intent: { id: "pi_page_1", latest_charge: "ch_page_1" },
					},
				},
			],
			has_more: false,
		});
		const source = createStripeBillingSource({
			invoices: { list: invoicesList },
			invoicePayments: { list: invoicePaymentsList },
		} as unknown as Stripe);

		await expect(
			source.listPaidInvoicesPage({
				cutoff: new Date("2027-01-15T12:00:00.000Z"),
				cursor: null,
				limit: 25,
				sweepId: "sweep_fixed",
				requestTimeoutMs: 4_321,
			}),
		).resolves.toMatchObject({
			facts: [
				{
					providerInvoiceId: "in_page_1",
					providerInvoicePaymentId: "inpay_page_1",
					providerChargeId: "ch_page_1",
					providerPaymentIntentId: "pi_page_1",
				},
			],
		});
		expect(invoicesList).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }), {
			timeout: 4_321,
		});
		expect(invoicePaymentsList).toHaveBeenCalledWith(
			{
				invoice: "in_page_1",
				status: "paid",
				limit: 100,
				expand: ["data.payment.payment_intent.latest_charge"],
			},
			{ timeout: 4_321 },
		);
	});

	it("propagates Stripe API failures instead of downgrading them to object issues", async () => {
		const providerFailure = new Error("stripe invoice-payments API unavailable");
		const source = createStripeBillingSource({
			invoices: {
				list: vi.fn().mockResolvedValue({
					data: [
						{
							id: "in_api_failure",
							customer: "cus_api_failure",
							parent: {
								type: "subscription_details",
								subscription_details: { subscription: "sub_api_failure" },
							},
							lines: { has_more: false, data: [] },
						},
					],
					has_more: false,
				}),
			},
			invoicePayments: { list: vi.fn().mockRejectedValue(providerFailure) },
		} as unknown as Stripe);

		await expect(
			source.listPaidInvoicesPage({
				cutoff: new Date("2027-01-15T12:00:00.000Z"),
				cursor: null,
				limit: 25,
				sweepId: "sweep_api_failure",
			}),
		).rejects.toBe(providerFailure);
	});

	it("isolates unsupported paid invoices and still returns later subscription invoices", async () => {
		const makeInvoice = (id: string, subscription: string | null) => ({
			id,
			amount_paid: 1_900,
			customer: `cus_${id}`,
			currency: "usd",
			billing_reason: "subscription_cycle",
			period_start: 1_800_000_000,
			period_end: 1_802_678_400,
			parent: subscription
				? {
						type: "subscription_details",
						subscription_details: { subscription },
					}
				: null,
			lines: {
				has_more: false,
				data: [
					{
						period: { start: 1_800_000_000, end: 1_802_678_400 },
						parent: {
							type: "subscription_item_details",
							subscription_item_details: {
								invoice_item: null,
								proration: false,
								proration_details: null,
								subscription,
								subscription_item: `si_${id}`,
							},
						},
						pricing: { price_details: { price: `price_${id}` } },
					},
				],
			},
		});
		const invoicesList = vi.fn().mockResolvedValue({
			data: [
				makeInvoice("in_payment_record", "sub_payment_record"),
				makeInvoice("in_one_off", null),
				makeInvoice("in_subscription", "sub_valid"),
			],
			has_more: false,
		});
		const invoicePaymentsList = vi.fn(async ({ invoice }: { invoice: string }) => ({
			data: [
				invoice === "in_payment_record"
					? {
							id: "inpay_payment_record",
							status: "paid",
							amount_paid: 1_900,
							payment: { type: "payment_record", payment_record: "pyr_unsupported" },
						}
					: {
							id: `inpay_${invoice}`,
							status: "paid",
							amount_paid: 1_900,
							payment: {
								type: "payment_intent",
								payment_intent: {
									id: `pi_${invoice}`,
									latest_charge: `ch_${invoice}`,
								},
							},
						},
			],
			has_more: false,
		}));
		const source = createStripeBillingSource({
			invoices: { list: invoicesList },
			invoicePayments: { list: invoicePaymentsList },
		} as unknown as Stripe);

		await expect(
			source.listPaidInvoicesPage({
				cutoff: new Date("2027-01-15T12:00:00.000Z"),
				cursor: null,
				limit: 25,
				sweepId: "sweep_isolated",
			}),
		).resolves.toMatchObject({
			facts: [{ providerInvoiceId: "in_subscription" }],
			issues: [
				{
					code: "STRIPE_INVOICE_PAYMENT_METHOD_UNSUPPORTED",
					entityType: "INVOICE",
					providerObjectId: "in_payment_record",
				},
				{
					code: "STRIPE_SUBSCRIPTION_ID_MISSING",
					entityType: "INVOICE",
					providerObjectId: "in_one_off",
				},
			],
			hasMore: false,
			nextCursor: "in_subscription",
		});
	});

	it("stops invoice-payment lookups at the absolute reconciliation deadline", async () => {
		const dateNow = vi
			.spyOn(Date, "now")
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(2_000)
			.mockReturnValueOnce(5_000);
		const makeInvoice = (id: string) => ({
			id,
			amount_paid: 1_900,
			customer: `cus_${id}`,
			currency: "usd",
			billing_reason: "subscription_cycle",
			period_start: 1_800_000_000,
			period_end: 1_802_678_400,
			parent: {
				type: "subscription_details",
				subscription_details: { subscription: `sub_${id}` },
			},
			lines: {
				has_more: false,
				data: [
					{
						period: { start: 1_800_000_000, end: 1_802_678_400 },
						parent: {
							type: "subscription_item_details",
							subscription_item_details: {
								invoice_item: null,
								proration: false,
								proration_details: null,
								subscription: `sub_${id}`,
								subscription_item: `si_${id}`,
							},
						},
						pricing: { price_details: { price: `price_${id}` } },
					},
				],
			},
		});
		const invoicesList = vi.fn().mockResolvedValue({
			data: [makeInvoice("in_deadline_1"), makeInvoice("in_deadline_2")],
			has_more: false,
		});
		const invoicePaymentsList = vi.fn(async ({ invoice }: { invoice: string }) => ({
			data: [
				{
					id: `inpay_${invoice}`,
					status: "paid",
					amount_paid: 1_900,
					payment: {
						type: "payment_intent",
						payment_intent: { id: `pi_${invoice}`, latest_charge: `ch_${invoice}` },
					},
				},
			],
			has_more: false,
		}));
		const source = createStripeBillingSource({
			invoices: { list: invoicesList },
			invoicePayments: { list: invoicePaymentsList },
		} as unknown as Stripe);

		try {
			await expect(
				source.listPaidInvoicesPage({
					cutoff: new Date("2027-01-15T12:00:00.000Z"),
					cursor: null,
					limit: 25,
					sweepId: "sweep_deadline",
					requestTimeoutMs: 10_000,
					requestDeadlineAtMs: 5_000,
				}),
			).rejects.toThrow("STRIPE_RECONCILIATION_RUN_DEADLINE_REACHED");
			expect(invoicesList).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }), {
				timeout: 4_000,
			});
			expect(invoicePaymentsList).toHaveBeenCalledTimes(1);
			expect(invoicePaymentsList).toHaveBeenCalledWith(expect.anything(), { timeout: 3_000 });
		} finally {
			dateNow.mockRestore();
		}
	});
});
