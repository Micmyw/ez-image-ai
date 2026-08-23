import { createHmac } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { createCreditGrant, ingestPaymentEvent } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { reconcileSubscriptionsWithClient } from "@repo/jobs";
import {
	createStripeWebhookHandler,
	getStripeClient,
	grantDueBillingPeriods,
	processClaimedStripePaymentEvent,
	processStripePaymentEvent,
} from "@repo/payments";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function assertSafeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	if (
		parsed.hostname !== "127.0.0.1" ||
		parsed.port !== "55432" ||
		parsed.pathname !== "/ai_media_foundation_test"
	) {
		throw new Error("TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test");
	}
	return TEST_DATABASE_URL;
}

describe("Stripe subscription credit lifecycle", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: assertSafeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => client?.$disconnect());

	it("repairs a pre-existing Purchase and replays subscription creation exactly once", async () => {
		const suffix = crypto.randomUUID();
		const user = await client.user.create({
			data: {
				id: `stripe-bind-user-${suffix}`,
				name: "Stripe binding fixture",
				email: `stripe-bind-${suffix}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_bind_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const providerSubscriptionId = `sub_bind_${suffix}`;
		const customerId = `cus_bind_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: user.id,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "incomplete",
			},
		});
		const envelope = subscriptionCreatedEnvelope({
			eventId: `evt_bind_payload_${suffix}`,
			providerSubscriptionId,
			customerId,
			planId: plan.id,
			planKey: "creator",
			ownerId: user.id,
			priceId: plan.providerPriceId,
		});
		const events = await Promise.all(
			[0, 1].map((index) =>
				client.paymentEvent.create({
					data: {
						provider: "stripe",
						providerEventId: `evt_bind_${suffix}_${index}`,
						verifiedAt: new Date(),
						envelope,
					},
				}),
			),
		);

		expect(
			await Promise.all(
				events.map((event) => processStripePaymentEvent({ paymentEventId: event.id }, client)),
			),
		).toEqual([
			{ outcome: "PROCESSED", grantsCreated: 0 },
			{ outcome: "PROCESSED", grantsCreated: 0 },
		]);
		expect(
			await processStripePaymentEvent({ paymentEventId: events[0]!.id }, client),
		).toMatchObject({
			outcome: "SKIPPED",
		});
		expect(await client.purchase.count({ where: { subscriptionId: providerSubscriptionId } })).toBe(
			1,
		);
		expect(
			await client.subscription.findUniqueOrThrow({ where: { providerSubscriptionId } }),
		).toMatchObject({
			purchaseId: purchase.id,
			ownerId: user.id,
			planId: plan.id,
			status: "ACTIVE",
		});
		expect(
			await client.auditLog.count({
				where: { action: "STRIPE_SUBSCRIPTION_BOUND", targetId: providerSubscriptionId },
			}),
		).toBe(1);
	});

	it("grants a paid monthly invoice exactly once across event replay", async () => {
		const ownerId = `stripe-monthly-${crypto.randomUUID()}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_monthly_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 1_000n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId: null,
				type: "SUBSCRIPTION",
				customerId: `cus_${crypto.randomUUID()}`,
				subscriptionId: `sub_${crypto.randomUUID()}`,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: purchase.subscriptionId!,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
				currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_${crypto.randomUUID()}`,
					type: "invoice.paid",
					created: 1_754_006_400,
					data: {
						object: {
							id: `in_${crypto.randomUUID()}`,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_${crypto.randomUUID()}`,
							amount_paid: 1_900,
							period_start: 1_754_006_400,
							period_end: 1_756_684_800,
						},
					},
				},
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
			outcome: "PROCESSED",
			grantsCreated: 1,
		});
		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
			outcome: "SKIPPED",
		});
		expect(await client.billingPeriod.count({ where: { subscriptionId: subscription.id } })).toBe(
			1,
		);
		expect(await client.creditLedgerEntry.count({ where: { type: "GRANT" } })).toBeGreaterThan(0);
	});

	it("runs a signed webhook through PaymentEvent and Outbox into the production processor", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `stripe-chain-${suffix}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_chain_${suffix}`,
				name: "creator",
				creditsPerPeriod: 321n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_chain_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const eventId = `evt_chain_${suffix}`;
		const invoiceId = `in_chain_${suffix}`;
		const chargeId = `ch_chain_${suffix}`;
		const raw = JSON.stringify({
			id: eventId,
			object: "event",
			api_version: "2026-07-29.basil",
			created: 1_800_000_000,
			type: "invoice.paid",
			data: {
				object: {
					id: invoiceId,
					object: "invoice",
					subscription: subscription.providerSubscriptionId,
					charge: chargeId,
					amount_paid: 1_900,
					period_start: 1_800_000_000,
					period_end: 1_802_678_400,
					lines: { data: [{ price: { id: plan.providerPriceId } }] },
				},
			},
		});
		const secret = `whsec_${suffix}`;
		process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
		const handler = createStripeWebhookHandler({
			stripe: getStripeClient(),
			webhookSecret: secret,
			persist: (input) => ingestPaymentEvent(input, client),
		});
		const signature = createStripeTestSignature(raw, secret);

		expect(
			(
				await handler(
					new Request("https://example.test/webhooks/payments", {
						method: "POST",
						headers: { "stripe-signature": signature },
						body: raw,
					}),
				)
			).status,
		).toBe(204);
		const paymentEvent = await client.paymentEvent.findUniqueOrThrow({
			where: { provider_providerEventId: { provider: "stripe", providerEventId: eventId } },
		});
		expect(paymentEvent.normalizedTransactionId).toBe(`invoice:${invoiceId}`);
		expect(
			await client.outboxEvent.findUniqueOrThrow({
				where: { dedupeKey: `payment-event:stripe:${eventId}` },
			}),
		).toMatchObject({
			eventType: "PAYMENT_EVENT_RECEIVED",
			payload: { paymentEventId: paymentEvent.id },
		});
		expect(
			await processStripePaymentEvent({ paymentEventId: paymentEvent.id }, client),
		).toMatchObject({ outcome: "PROCESSED", grantsCreated: 1 });
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { providerInvoiceId: invoiceId } }),
		).toMatchObject({ providerChargeId: chargeId, creditAmount: 321n });
	});

	it("persists and processes an invoice and refund that share a charge", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `stripe-shared-charge-${suffix}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_shared_charge_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 10_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_shared_charge_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const chargeId = `ch_shared_charge_${suffix}`;
		const invoiceId = `in_shared_charge_${suffix}`;
		const refundId = `re_shared_charge_${suffix}`;
		const invoice = await ingestPaymentEvent(
			{
				provider: "stripe",
				providerEventId: `evt_invoice_shared_${suffix}`,
				normalizedTransactionId: `invoice:${invoiceId}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_invoice_shared_${suffix}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: invoiceId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 1_000,
							period_start: 1_800_000_000,
							period_end: 1_802_678_400,
							lines: { data: [{ price: { id: plan.providerPriceId } }] },
						},
					},
				},
			},
			client,
		);
		const refund = await ingestPaymentEvent(
			{
				provider: "stripe",
				providerEventId: `evt_refund_shared_${suffix}`,
				normalizedTransactionId: `refund:${refundId}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_refund_shared_${suffix}`,
					type: "refund.created",
					created: 1_800_000_001,
					data: { object: { id: refundId, charge: chargeId, amount: 500 } },
				},
			},
			client,
		);

		expect(invoice.replayed).toBe(false);
		expect(refund.replayed).toBe(false);
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: { in: [invoice.event.id, refund.event.id] } },
			}),
		).toBe(2);
		expect(
			await processStripePaymentEvent({ paymentEventId: invoice.event.id }, client),
		).toMatchObject({
			outcome: "PROCESSED",
		});
		expect(
			await processStripePaymentEvent({ paymentEventId: refund.event.id }, client),
		).toMatchObject({
			outcome: "PROCESSED",
		});
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { providerChargeId: chargeId } }),
		).toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("turns the spent part of a Stripe refund into debt and caps multiple refunds", async () => {
		const ownerId = `stripe-refund-${crypto.randomUUID()}`;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const grantReferenceKey = `billing-period:${crypto.randomUUID()}:grant`;
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey },
			client,
		);
		await client.creditAccount.update({
			where: { id: account.id },
			data: { spendableCredits: 0n },
		});
		await client.creditLot.updateMany({
			where: { accountId: account.id },
			data: { remainingAmount: 0n },
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_refund_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 10_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_${crypto.randomUUID()}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const period = await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date("2026-08-01T00:00:00.000Z"),
				endsAt: new Date("2026-09-01T00:00:00.000Z"),
				status: "ACTIVE",
				creditAmount: 100n,
				grantReferenceKey,
				providerInvoiceId: `in_${crypto.randomUUID()}`,
				providerChargeId: `ch_${crypto.randomUUID()}`,
				paidAmount: 1_000n,
			},
		});

		for (const [index, amount] of [400, 900].entries()) {
			const event = await client.paymentEvent.create({
				data: {
					provider: "stripe",
					providerEventId: `evt_refund_${crypto.randomUUID()}`,
					verifiedAt: new Date(),
					envelope: {
						id: `evt_refund_payload_${index}`,
						type: "refund.created",
						created: 1_754_006_500 + index,
						data: { object: { id: `re_${index}`, charge: period.providerChargeId, amount } },
					},
				},
			});
			await processStripePaymentEvent({ paymentEventId: event.id }, client);
		}

		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			creditDebt: 100n,
		});
		expect(
			await client.billingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
		).toMatchObject({
			refundedAmount: 1_000n,
			refundedCredits: 100n,
		});
	});

	it("schedules annual credits monthly and grants only a due paid period", async () => {
		const ownerId = `stripe-annual-${crypto.randomUUID()}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_annual_${crypto.randomUUID()}`,
				name: "studio",
				creditsPerPeriod: 500n,
				priceMicros: 790_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "year", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_annual_${crypto.randomUUID()}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_annual_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_payload_${crypto.randomUUID()}`,
					type: "invoice.paid",
					created: 1_833_000_000,
					data: {
						object: {
							id: `in_annual_${crypto.randomUUID()}`,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_annual_${crypto.randomUUID()}`,
							amount_paid: 79_000,
							period_start: 1_833_000_600,
							period_end: 1_864_536_600,
						},
					},
				},
			},
		});
		await processStripePaymentEvent({ paymentEventId: event.id }, client);
		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: subscription.id },
			orderBy: { startsAt: "asc" },
		});
		expect(periods).toHaveLength(12);
		expect(periods[1]?.startsAt.getUTCDate()).toBeLessThanOrEqual(29);
		expect(periods[2]?.startsAt.getUTCDate()).toBe(periods[0]?.startsAt.getUTCDate());
		expect(await client.creditLedgerEntry.count({ where: { account: { ownerId } } })).toBe(1);
		const grantResult = await grantDueBillingPeriods(
			{ now: new Date(periods[1]!.startsAt.getTime() + 1_000) },
			client,
		);
		expect(grantResult.granted).toBeGreaterThanOrEqual(1);
		expect(await client.creditLedgerEntry.count({ where: { account: { ownerId } } })).toBe(2);
	});

	it("voids all future annual periods after a full refund", async () => {
		const ownerId = `annual-refund-${crypto.randomUUID()}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_annual_refund_${crypto.randomUUID()}`,
				name: "studio",
				creditsPerPeriod: 100n,
				priceMicros: 120_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "year", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_annual_refund_${crypto.randomUUID()}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const invoiceId = `in_annual_refund_${crypto.randomUUID()}`;
		const chargeId = `ch_annual_refund_${crypto.randomUUID()}`;
		const paid = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_paid_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_paid_annual_refund",
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: invoiceId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 12_000,
							period_start: 1_800_000_000,
							period_end: 1_831_536_000,
							lines: { data: [{ price: { id: plan.providerPriceId } }] },
						},
					},
				},
			},
		});
		await processStripePaymentEvent({ paymentEventId: paid.id }, client);
		const refund = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_refund_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_refund_annual",
					type: "refund.created",
					created: 1_800_000_100,
					data: { object: { id: `re_${crypto.randomUUID()}`, charge: chargeId, amount: 12_000 } },
				},
			},
		});
		await processStripePaymentEvent({ paymentEventId: refund.id }, client);
		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: subscription.id },
			orderBy: { startsAt: "asc" },
		});
		expect(periods).toHaveLength(12);
		expect(periods.every((period) => period.status === "REFUNDED")).toBe(true);
		expect(
			await grantDueBillingPeriods({ now: new Date("2030-01-01T00:00:00.000Z") }, client),
		).toEqual({ granted: 0 });
	});

	it("rounds multiple partial annual refunds from the cumulative invoice total", async () => {
		const ownerId = `annual-partial-refund-${crypto.randomUUID()}`;
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_annual_partial_${crypto.randomUUID()}`,
				name: "studio",
				creditsPerPeriod: 10n,
				priceMicros: 10_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "year", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_annual_partial_${crypto.randomUUID()}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const chargeId = `ch_annual_partial_${crypto.randomUUID()}`;
		const invoiceId = `in_annual_partial_${crypto.randomUUID()}`;
		const paid = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_annual_partial_paid_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_payload_${crypto.randomUUID()}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: invoiceId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 1_000,
							period_start: 1_800_000_000,
							period_end: 1_831_536_000,
							lines: { data: [{ price: { id: plan.providerPriceId } }] },
						},
					},
				},
			},
		});
		await processStripePaymentEvent({ paymentEventId: paid.id }, client);

		for (const index of [0, 1]) {
			const refund = await client.paymentEvent.create({
				data: {
					provider: "stripe",
					providerEventId: `evt_annual_partial_refund_${crypto.randomUUID()}`,
					verifiedAt: new Date(),
					envelope: {
						id: `evt_annual_partial_refund_payload_${index}`,
						type: "refund.created",
						created: 1_800_000_100 + index,
						data: {
							object: {
								id: `re_annual_partial_${crypto.randomUUID()}`,
								charge: chargeId,
								amount: 1,
							},
						},
					},
				},
			});
			await processStripePaymentEvent({ paymentEventId: refund.id }, client);
		}

		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: subscription.id },
			orderBy: { startsAt: "asc" },
		});
		expect(periods.reduce((sum, period) => sum + period.refundedCredits, 0n)).toBe(1n);
		expect(periods[0]).toMatchObject({ refundedAmount: 2n, refundedCredits: 1n });
		expect(periods.slice(1).every((period) => period.refundedCredits === 0n)).toBe(true);
	});

	it("expires past due at grace end and canceled only after paid-through", async () => {
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_deadlines_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const now = new Date("2026-09-01T00:00:00.000Z");
		const common = {
			ownerType: "USER" as const,
			provider: "stripe",
			planId: plan.id,
		};
		const canceledDue = await client.subscription.create({
			data: {
				...common,
				ownerId: `canceled-due-${crypto.randomUUID()}`,
				providerSubscriptionId: `sub_canceled_due_${crypto.randomUUID()}`,
				status: "CANCELED",
				currentPeriodEnd: now,
			},
		});
		const canceledPaidThrough = await client.subscription.create({
			data: {
				...common,
				ownerId: `canceled-future-${crypto.randomUUID()}`,
				providerSubscriptionId: `sub_canceled_future_${crypto.randomUUID()}`,
				status: "CANCELED",
				currentPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
			},
		});
		const pastDueExpired = await client.subscription.create({
			data: {
				...common,
				ownerId: `past-due-expired-${crypto.randomUUID()}`,
				providerSubscriptionId: `sub_past_due_expired_${crypto.randomUUID()}`,
				status: "PAST_DUE",
				currentPeriodEnd: new Date("2026-09-30T00:00:00.000Z"),
				graceEndsAt: now,
			},
		});
		const pastDueGrace = await client.subscription.create({
			data: {
				...common,
				ownerId: `past-due-grace-${crypto.randomUUID()}`,
				providerSubscriptionId: `sub_past_due_grace_${crypto.randomUUID()}`,
				status: "PAST_DUE",
				currentPeriodEnd: new Date("2026-08-31T00:00:00.000Z"),
				graceEndsAt: new Date("2026-09-02T00:00:00.000Z"),
			},
		});

		expect(await reconcileSubscriptionsWithClient({ now }, client)).toMatchObject({ expired: 2 });
		const subscriptions = await client.subscription.findMany({
			where: {
				id: { in: [canceledDue.id, canceledPaidThrough.id, pastDueExpired.id, pastDueGrace.id] },
			},
		});
		expect(Object.fromEntries(subscriptions.map((item) => [item.id, item.status]))).toEqual({
			[canceledDue.id]: "EXPIRED",
			[canceledPaidThrough.id]: "CANCELED",
			[pastDueExpired.id]: "EXPIRED",
			[pastDueGrace.id]: "PAST_DUE",
		});
	});

	it("keeps paid-through credits on cancellation and ignores a stale reactivation", async () => {
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_cancel_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				type: "SUBSCRIPTION",
				customerId: `cus_cancel_${crypto.randomUUID()}`,
				subscriptionId: `sub_cancel_${crypto.randomUUID()}`,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `cancel-user-${crypto.randomUUID()}`,
				provider: "stripe",
				providerSubscriptionId: purchase.subscriptionId!,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				lastProviderEventAt: new Date("2026-08-13T10:00:00.000Z"),
			},
		});
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: subscription.ownerId },
		});
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: `paid-through-${subscription.id}` },
			client,
		);
		for (const [type, created, status] of [
			["customer.subscription.deleted", 1_786_616_400, "canceled"],
			["customer.subscription.updated", 1_786_612_800, "active"],
		] as const) {
			const event = await client.paymentEvent.create({
				data: {
					provider: "stripe",
					providerEventId: `evt_cancel_${crypto.randomUUID()}`,
					verifiedAt: new Date(),
					envelope: {
						id: `evt_payload_${crypto.randomUUID()}`,
						type,
						created,
						data: { object: { id: subscription.providerSubscriptionId, status } },
					},
				},
			});
			await processStripePaymentEvent({ paymentEventId: event.id }, client);
		}
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			status: "CANCELED",
		});
		expect(await client.purchase.findUnique({ where: { id: purchase.id } })).not.toBeNull();
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).toMatchObject({
			spendableCredits: 100n,
		});
	});

	it("fences a stale worker after a newer lease is claimed", async () => {
		const leaseB = `lease-b-${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				status: "PROCESSING",
				processingToken: leaseB,
				processingLeasedUntil: new Date("2030-01-01T00:05:00.000Z"),
				envelope: { id: "evt_lease", type: "noop", created: 1, data: { object: {} } },
			},
		});
		expect(
			await processClaimedStripePaymentEvent(
				{
					paymentEventId: event.id,
					processingToken: "lease-a",
					now: new Date("2030-01-01T00:00:00.000Z"),
				},
				client,
			),
		).toMatchObject({ outcome: "SKIPPED" });
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PROCESSING",
			processingToken: leaseB,
		});
	});

	it("applies a scheduled server-mapped plan only on the next paid invoice", async () => {
		const ownerId = `plan-change-${crypto.randomUUID()}`;
		const oldPlan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_old_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const newPlan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_new_${crypto.randomUUID()}`,
				name: "studio",
				creditsPerPeriod: 900n,
				priceMicros: 79_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_change_${crypto.randomUUID()}`,
				planId: oldPlan.id,
				scheduledPlanId: newPlan.id,
				status: "ACTIVE",
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_change_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_change",
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: `in_change_${crypto.randomUUID()}`,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_change_${crypto.randomUUID()}`,
							amount_paid: 7_900,
							period_start: 1_800_000_000,
							period_end: 1_802_678_400,
							lines: { data: [{ price: { id: newPlan.providerPriceId } }] },
						},
					},
				},
			},
		});
		await processStripePaymentEvent({ paymentEventId: event.id }, client);
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: newPlan.id,
			scheduledPlanId: null,
		});
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { subscriptionId: subscription.id } }),
		).toMatchObject({ creditAmount: 900n });
	});

	it("does not let a stale subscription event schedule a plan change", async () => {
		const suffix = crypto.randomUUID();
		const oldPlan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_stale_old_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const newPlan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_stale_new_${suffix}`,
				name: "studio",
				creditsPerPeriod: 900n,
				priceMicros: 79_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `stale-plan-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `sub_stale_plan_${suffix}`,
				planId: oldPlan.id,
				status: "ACTIVE",
				lastProviderEventAt: new Date("2026-09-01T00:00:00.000Z"),
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_stale_plan_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_stale_plan_${suffix}`,
					type: "customer.subscription.updated",
					created: 1_778_284_800,
					data: {
						object: {
							id: subscription.providerSubscriptionId,
							status: "active",
							items: { data: [{ price: { id: newPlan.providerPriceId } }] },
						},
					},
				},
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
			outcome: "PROCESSED",
		});
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: oldPlan.id,
			scheduledPlanId: null,
		});
	});

	it("does not let a stale invoice failure override a newer active subscription event", async () => {
		const suffix = crypto.randomUUID();
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_failure_fence_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `failure-fence-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `sub_failure_fence_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
				lastProviderEventAt: new Date("2026-09-01T00:00:00.000Z"),
				lastProviderEventId: `evt_active_${suffix}`,
			},
		});
		const staleFailure = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_failure_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_failure_${suffix}`,
					type: "invoice.payment_failed",
					created: 1_778_284_799,
					data: {
						object: {
							subscription: subscription.providerSubscriptionId,
							grace_ends_at: 1_780_963_200,
						},
					},
				},
			},
		});

		expect(
			await processStripePaymentEvent({ paymentEventId: staleFailure.id }, client),
		).toMatchObject({ outcome: "PROCESSED" });
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			status: "ACTIVE",
			lastProviderEventId: `evt_active_${suffix}`,
			graceEndsAt: null,
		});
	});

	it("clears a scheduled change when a newer mapped event returns to the active plan", async () => {
		const suffix = crypto.randomUUID();
		const planA = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_revert_a_${suffix}`,
				name: "creator",
				creditsPerPeriod: 111n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const planB = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_revert_b_${suffix}`,
				name: "studio",
				creditsPerPeriod: 999n,
				priceMicros: 79_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `plan-revert-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `sub_plan_revert_${suffix}`,
				planId: planA.id,
				status: "ACTIVE",
			},
		});
		async function processPlanUpdate(input: {
			label: string;
			created: number;
			providerPriceId: string;
		}) {
			const event = await client.paymentEvent.create({
				data: {
					provider: "stripe",
					providerEventId: `evt_plan_revert_${suffix}_${input.label}`,
					verifiedAt: new Date(),
					envelope: {
						id: `evt_plan_revert_${suffix}_${input.label}`,
						type: "customer.subscription.updated",
						created: input.created,
						data: {
							object: {
								id: subscription.providerSubscriptionId,
								status: "active",
								items: { data: [{ price: { id: input.providerPriceId } }] },
							},
						},
					},
				},
			});
			expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
				outcome: "PROCESSED",
			});
		}

		await processPlanUpdate({
			label: "schedule-b",
			created: 1_800_000_100,
			providerPriceId: planB.providerPriceId,
		});
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: planA.id,
			scheduledPlanId: planB.id,
		});

		await processPlanUpdate({
			label: "return-a",
			created: 1_800_000_200,
			providerPriceId: planA.providerPriceId,
		});
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: planA.id,
			scheduledPlanId: null,
		});

		await processPlanUpdate({
			label: "stale-b",
			created: 1_800_000_150,
			providerPriceId: planB.providerPriceId,
		});
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: planA.id,
			scheduledPlanId: null,
		});

		const invoice = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_plan_revert_invoice_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_plan_revert_invoice_${suffix}`,
					type: "invoice.paid",
					created: 1_800_000_300,
					data: {
						object: {
							id: `in_plan_revert_${suffix}`,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_plan_revert_${suffix}`,
							amount_paid: 1_900,
							period_start: 1_800_000_300,
							period_end: 1_802_678_700,
							lines: { data: [{ price: { id: planA.providerPriceId } }] },
						},
					},
				},
			},
		});
		expect(await processStripePaymentEvent({ paymentEventId: invoice.id }, client)).toMatchObject({
			outcome: "PROCESSED",
			grantsCreated: 1,
		});
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { subscriptionId: subscription.id } }),
		).toMatchObject({ creditAmount: 111n });
	});
});

function subscriptionCreatedEnvelope(input: {
	eventId: string;
	providerSubscriptionId: string;
	customerId: string;
	planId: string;
	planKey: string;
	ownerId: string;
	priceId: string;
}) {
	return {
		id: input.eventId,
		type: "customer.subscription.created",
		created: 1_800_000_000,
		data: {
			object: {
				id: input.providerSubscriptionId,
				customer: input.customerId,
				status: "active",
				current_period_start: 1_800_000_000,
				current_period_end: 1_802_678_400,
				items: { data: [{ price: { id: input.priceId } }] },
				metadata: {
					billing_plan_id: input.planId,
					plan_key: input.planKey,
					owner_type: "USER",
					owner_id: input.ownerId,
					submitted_by_user_id: input.ownerId,
				},
			},
		},
	};
}

function createStripeTestSignature(payload: string, secret: string): string {
	const timestamp = Math.floor(Date.now() / 1_000);
	const signature = createHmac("sha256", secret)
		.update(`${timestamp}.${payload}`, "utf8")
		.digest("hex");
	return `t=${timestamp},v1=${signature}`;
}
