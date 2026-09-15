import { PrismaPg } from "@prisma/adapter-pg";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	findEffectivePaidSubscription,
	ingestPaymentEvent,
	markPaymentCheckoutIntentProviderCreating,
	runSerializable,
	reserveCredits,
	settleCredits,
	releaseCredits,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileProviderPaymentEvents } from "../../../payments/provider/event-reconciliation";
import { normalizeProviderBillingEvent } from "../../../payments/provider/lifecycle-normalization";
import { applyProviderBillingFact } from "../../../payments/provider/lifecycle-reducer";
import { processProviderPaymentEvent } from "../../../payments/provider/processor";
import { requeuePreviouslyUnsupportedRefunds } from "../../../payments/provider/refund-repair";
import { grantDueBillingPeriods } from "../../../payments/provider/stripe/reducer";
import { loadUserPlanEntitlement } from "../media/lib/plan-entitlement";

const prefix = `billing-prelaunch-${crypto.randomUUID()}`;
const now = new Date();
let client: PrismaClient;

describe("production payment business regressions", () => {
	beforeAll(() => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString || connectionString === process.env.DATABASE_URL) {
			throw new Error("UNSAFE_TEST_DATABASE");
		}
		const target = new URL(connectionString);
		if (
			!["127.0.0.1", "localhost"].includes(target.hostname) ||
			target.port !== "55432" ||
			target.pathname !== "/ai_media_foundation_test"
		)
			throw new Error("UNSAFE_TEST_DATABASE");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
	});

	afterAll(async () => {
		if (!client) return;
		await client.$transaction(async (tx) => {
			const accounts = await tx.creditAccount.findMany({
				where: { ownerId: { startsWith: prefix } },
			});
			const accountIds = accounts.map(({ id }) => id);
			await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" DISABLE TRIGGER "credit_ledger_entry_immutable"`;
			try {
				await tx.creditLedgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
			} finally {
				await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" ENABLE TRIGGER "credit_ledger_entry_immutable"`;
			}
			await tx.creditReservationAllocation.deleteMany({
				where: { reservation: { accountId: { in: accountIds } } },
			});
			await tx.creditReservation.deleteMany({ where: { accountId: { in: accountIds } } });
			await tx.generationJob.deleteMany({ where: { ownerId: { startsWith: prefix } } });
			await tx.generationQuote.deleteMany({ where: { ownerId: { startsWith: prefix } } });
			await tx.creditLot.deleteMany({ where: { accountId: { in: accountIds } } });
			await tx.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
			await tx.subscriptionPaymentAdjustment.deleteMany({
				where: { subscription: { ownerId: { startsWith: prefix } } },
			});
			await tx.subscription.deleteMany({ where: { ownerId: { startsWith: prefix } } });
			await tx.purchase.deleteMany({ where: { userId: { startsWith: prefix } } });
			await tx.paymentCheckoutIntent.deleteMany({ where: { ownerId: { startsWith: prefix } } });
			await tx.paymentCustomer.deleteMany({ where: { ownerId: { startsWith: prefix } } });
			await tx.billingPlan.deleteMany({ where: { providerPriceId: { contains: prefix } } });
			const events = await tx.paymentEvent.findMany({
				where: { providerEventId: { startsWith: prefix } },
			});
			await tx.auditLog.deleteMany({ where: { targetId: { in: events.map(({ id }) => id) } } });
			await tx.outboxEvent.deleteMany({
				where: { aggregateId: { in: events.map(({ id }) => id) } },
			});
			await tx.paymentEvent.deleteMany({ where: { id: { in: events.map(({ id }) => id) } } });
			await tx.paymentReconciliationCheckpoint.deleteMany({
				where: { id: { startsWith: prefix } },
			});
			await tx.user.deleteMany({ where: { id: { startsWith: prefix } } });
		});
		await client.$disconnect();
	});

	it("keeps a canceled prepaid year usable and grants its next paid month exactly once", async () => {
		const fixture = await prepare("paypal", "year");
		const cancel = normalizeProviderBillingEvent("paypal", {
			id: `${prefix}-cancel`,
			event_type: "BILLING.SUBSCRIPTION.CANCELLED",
			create_time: now.toISOString(),
			resource: { id: fixture.fact.providerSubscriptionId, custom_id: fixture.checkout.intent.id },
		});
		await runSerializable(client, (tx) => applyProviderBillingFact(cancel, tx));
		expect(await effective(fixture.ownerId)).not.toBeNull();
		const nextMonth = new Date(addMonths(fixture.startsAt, 1).getTime() + 1000);
		await grantDueBillingPeriods({ now: nextMonth, limit: 10000 }, client);
		await grantDueBillingPeriods({ now: nextMonth, limit: 10000 }, client);
		const periods = await periodsFor(fixture.fact.providerSubscriptionId);
		expect(periods[1]?.status).toBe("ACTIVE");
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: periods[1]!.grantReferenceKey! },
			}),
		).toBe(1);
		expect(await effective(fixture.ownerId, fixture.endsAt)).toBeNull();
	});

	it("does not give expired ACTIVE subscriptions paid-model or pack-bonus eligibility", async () => {
		const fixture = await prepare("paypal", "month", {
			startsAt: addMonths(new Date(now.getTime() - 86400000), -1),
		});
		expect(await effective(fixture.ownerId)).toBeNull();
	});
	it.each(["month", "year"] as const)(
		"admits only one channel for concurrent purchases of the same %s plan",
		async (interval) => {
			const ownerId = `${prefix}-same-plan-${interval}`;
			await client.user.create({
				data: {
					id: ownerId,
					email: `${ownerId}@example.test`,
					name: "Concurrent checkout regression",
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			const results = await Promise.allSettled(
				(["paypal", "waffo"] as const).map((provider) =>
					prepare(provider, interval, { ownerId, pay: false }),
				),
			);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected?.reason).toMatchObject({ message: "PAYMENT_CHECKOUT_INTENT_CONFLICT" });
			expect(await client.paymentCheckoutIntent.count({ where: { ownerId } })).toBe(1);
		},
	);

	it.each([
		["paypal", "waffo", "month"],
		["paypal", "waffo", "year"],
		["waffo", "paypal", "month"],
		["waffo", "paypal", "year"],
	] as const)(
		"fences a refunded %s subscription until closure and its original end, then grants %s %s once",
		async (originalProvider, nextProvider, interval) => {
			const original = await prepare(originalProvider, interval);
			const attemptNext = () => prepare(nextProvider, interval, { ownerId: original.ownerId });
			await expect(attemptNext()).rejects.toThrow("PAYMENT_SUBSCRIPTION_ALREADY_EXISTS");

			const refundReceipt = await refund(
				original,
				"switch-full-refund",
				interval === "year" ? "190.00" : "19.00",
			);
			expect(await effective(original.ownerId)).toBeNull();
			await expect(attemptNext()).rejects.toThrow("PAYMENT_SUBSCRIPTION_ALREADY_EXISTS");
			await runSerializable(client, (tx) =>
				applyProviderBillingFact(
					{
						...original.fact,
						providerEventId: `${prefix}-${original.checkout.intent.id}-canceled`,
						status: "CANCELED",
						cancelAtPeriodEnd: true,
						occurredAt: now,
						payment: null,
					},
					tx,
				),
			);
			await expect(attemptNext()).rejects.toThrow("PAYMENT_SUBSCRIPTION_ALREADY_EXISTS");
			expect(
				await client.paymentCheckoutIntent.count({ where: { ownerId: original.ownerId } }),
			).toBe(1);

			const replacement = await prepare(nextProvider, interval, {
				ownerId: original.ownerId,
				checkoutAt: original.endsAt,
				startsAt: original.endsAt,
			});
			await runSerializable(client, (tx) => applyProviderBillingFact(original.fact, tx));
			await processProviderPaymentEvent({ paymentEventId: refundReceipt.id }, client);
			await runSerializable(client, (tx) => applyProviderBillingFact(replacement.fact, tx));
			const replacementSubscription = await client.subscription.findUniqueOrThrow({
				where: {
					provider_providerSubscriptionId: {
						provider: nextProvider,
						providerSubscriptionId: replacement.fact.providerSubscriptionId,
					},
				},
			});
			expect(await effective(original.ownerId, original.endsAt)).toMatchObject({
				id: replacementSubscription.id,
				status: "ACTIVE",
			});
			expect(
				await client.creditAccount.findUniqueOrThrow({
					where: { ownerType_ownerId: { ownerType: "USER", ownerId: original.ownerId } },
				}),
			).toMatchObject({ spendableCredits: 700n, reservedCredits: 0n, creditDebt: 0n });
			expect(
				await client.creditLedgerEntry.count({
					where: {
						referenceKey: `${nextProvider}-payment:${replacement.fact.payment.providerPaymentId}:period:0:grant`,
					},
				}),
			).toBe(1);
			expect(
				(await periodsFor(original.fact.providerSubscriptionId)).every(
					(period) =>
						period.status === "REFUNDED" && period.refundedCredits === period.creditAmount,
				),
			).toBe(true);
		},
	);

	it.each(["paypal", "waffo"] as const)(
		"%s does not restore paid access from an older payment after refund and a past-due callback",
		async (provider) => {
			const first = await prepare(provider, "month", {
				startsAt: addMonths(new Date(now.getTime() - 86400000), -1),
			});
			const renewal = {
				...first,
				startsAt: first.endsAt,
				endsAt: addMonths(first.endsAt, 1),
				fact: {
					...first.fact,
					providerEventId: `${first.fact.providerEventId}-renewal`,
					occurredAt: first.endsAt,
					currentPeriod: { periodStart: first.endsAt, periodEnd: addMonths(first.endsAt, 1) },
					payment: {
						...first.fact.payment,
						providerPaymentId: `${first.fact.payment.providerPaymentId}-renewal`,
						periodStart: first.endsAt,
						periodEnd: addMonths(first.endsAt, 1),
					},
				},
			};
			await runSerializable(client, (tx) => applyProviderBillingFact(renewal.fact, tx));
			expect(await loadUserPlanEntitlement(first.ownerId, { client, now })).toMatchObject({
				id: "creator",
			});
			const receipt = await refund(renewal, "latest-payment-full-refund", "19.00");
			expect(await effective(first.ownerId)).toBeNull();
			await runSerializable(client, (tx) =>
				applyProviderBillingFact(
					{
						...renewal.fact,
						providerEventId: `${first.fact.providerEventId}-past-due`,
						status: "PAST_DUE",
						occurredAt: now,
						payment: null,
					},
					tx,
				),
			);
			expect(await loadUserPlanEntitlement(first.ownerId, { client, now })).toMatchObject({
				id: "free",
			});
			await runSerializable(client, (tx) => applyProviderBillingFact(first.fact, tx));
			await runSerializable(client, (tx) => applyProviderBillingFact(renewal.fact, tx));
			await processProviderPaymentEvent({ paymentEventId: receipt.id }, client);
			expect(await effective(first.ownerId)).toBeNull();
			const periods = await periodsFor(first.fact.providerSubscriptionId);
			expect(periods).toHaveLength(2);
			expect(periods[0]).toMatchObject({ paidAmount: 19000000n, refundedAmount: 0n });
			expect(periods[1]).toMatchObject({
				status: "REFUNDED",
				paidAmount: 19000000n,
				refundedAmount: 19000000n,
				refundedCredits: 700n,
			});
			expect(
				await client.creditLedgerEntry.count({
					where: { referenceKey: periods[1]!.grantReferenceKey! },
				}),
			).toBe(1);
		},
	);

	it("fulfills a newly owned checkout with a different payer without rewriting historical ownership", async () => {
		const original = await prepare("paypal", "month");
		await client.subscription.update({
			where: {
				provider_providerSubscriptionId: {
					provider: "paypal",
					providerSubscriptionId: original.fact.providerSubscriptionId,
				},
			},
			data: { status: "EXPIRED", cancelAtPeriodEnd: true },
		});
		const replacement = await prepare("paypal", "month", {
			ownerId: original.ownerId,
			payerId: "NEW-PAYER",
		});
		expect(
			await client.purchase.findUniqueOrThrow({
				where: {
					provider_subscriptionId: {
						provider: "paypal",
						subscriptionId: replacement.fact.providerSubscriptionId,
					},
				},
			}),
		).toMatchObject({ customerId: "NEW-PAYER" });
		await runSerializable(client, (tx) =>
			applyProviderBillingFact(
				{
					...original.fact,
					payment: null,
					status: "EXPIRED",
					providerEventId: `${prefix}-old-callback`,
					occurredAt: new Date(now.getTime() + 1000),
				},
				tx,
			),
		);
		expect(
			await client.paymentCustomer.findUniqueOrThrow({
				where: {
					provider_ownerType_ownerId: {
						provider: "paypal",
						ownerType: "USER",
						ownerId: original.ownerId,
					},
				},
			}),
		).toMatchObject({ providerCustomerId: "NEW-PAYER" });
		expect(
			await client.purchase.findUniqueOrThrow({
				where: {
					provider_subscriptionId: {
						provider: "paypal",
						subscriptionId: original.fact.providerSubscriptionId,
					},
				},
			}),
		).toMatchObject({ customerId: original.fact.providerCustomerId });
	});

	it.each(["paypal", "waffo"] as const)(
		"%s full annual refund revokes current and future credits and survives payment replay",
		async (provider) => {
			const fixture = await prepare(provider, "year");
			const eventId = `${prefix}-refund-${provider}`;
			const envelope =
				provider === "paypal"
					? {
							id: eventId,
							event_type: "PAYMENT.SALE.REFUNDED",
							create_time: now.toISOString(),
							resource: {
								id: `${eventId}-refund`,
								state: "completed",
								sale_id: fixture.fact.payment.providerPaymentId,
								amount: { total: "190.00", currency: "USD" },
							},
						}
					: {
							id: eventId,
							eventType: "refund.succeeded",
							eventId: `${eventId}-refund`,
							timestamp: now.toISOString(),
							data: {
								orderId: fixture.fact.providerSubscriptionId,
								paymentId: fixture.fact.payment.providerPaymentId,
								refundStatus: "succeeded",
								amount: "190.00",
								currency: "USD",
							},
						};
			const { event } = await ingestPaymentEvent(
				{ provider, providerEventId: eventId, verifiedAt: now, envelope },
				client,
			);
			expect(await processProviderPaymentEvent({ paymentEventId: event.id }, client)).toMatchObject(
				{ outcome: "PROCESSED" },
			);
			expect(await effective(fixture.ownerId)).toBeNull();
			expect(
				await client.creditAccount.findUniqueOrThrow({
					where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
				}),
			).toMatchObject({ spendableCredits: 0n, creditDebt: 0n });
			await runSerializable(client, (tx) => applyProviderBillingFact(fixture.fact, tx));
			await processProviderPaymentEvent({ paymentEventId: event.id }, client);
			await grantDueBillingPeriods(
				{ now: new Date(addMonths(fixture.startsAt, 1).getTime() + 1000), limit: 10000 },
				client,
			);
			const periods = await periodsFor(fixture.fact.providerSubscriptionId);
			expect(periods).toHaveLength(12);
			expect(
				periods.every((period) => period.status === "REFUNDED" && period.refundedCredits === 700n),
			).toBe(true);
			expect(
				await client.creditLedgerEntry.count({
					where: { referenceKey: periods[1]!.grantReferenceKey! },
				}),
			).toBe(0);
			expect(await effective(fixture.ownerId)).toBeNull();
		},
	);

	it.each(["paypal", "waffo"] as const)(
		"%s cumulative partial refunds cannot overgrant a later annual month",
		async (provider) => {
			const fixture = await prepare(provider, "year");
			await refund(fixture, "half", "95.00");
			expect(await effective(fixture.ownerId)).not.toBeNull();
			let periods = await periodsFor(fixture.fact.providerSubscriptionId);
			expect(periods.reduce((sum, period) => sum + period.refundedCredits, 0n)).toBe(4200n);
			const seventhMonth = new Date(periods[6]!.startsAt.getTime() + 1000);
			await grantDueBillingPeriods({ now: seventhMonth, limit: 10000 }, client);
			await refund(fixture, "remainder", "95.00");
			periods = await periodsFor(fixture.fact.providerSubscriptionId);
			expect(periods.every((period) => period.status === "REFUNDED")).toBe(true);
			expect(
				await client.creditAccount.findUniqueOrThrow({
					where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
				}),
			).toMatchObject({ spendableCredits: 0n, creditDebt: 0n });
		},
	);

	it.each(["paypal", "waffo"] as const)(
		"%s refund delivered before the payment is requeued when its transaction is bound",
		async (provider) => {
			const fixture = await prepare(provider, "month", { pay: false });
			const event = await refundEvent(fixture, "early", "19.00");
			await expect(
				processProviderPaymentEvent({ paymentEventId: event.id }, client),
			).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
			await runSerializable(client, (tx) => applyProviderBillingFact(fixture.fact, tx));
			expect(
				await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
			).toMatchObject({ status: "FAILED" });
			expect(await processProviderPaymentEvent({ paymentEventId: event.id }, client)).toMatchObject(
				{ outcome: "PROCESSED" },
			);
			expect(await effective(fixture.ownerId)).toBeNull();
		},
	);

	it.each([
		{ provider: "paypal", finish: "release" },
		{ provider: "waffo", finish: "release" },
		{ provider: "paypal", finish: "settle" },
		{ provider: "waffo", finish: "settle" },
	] as const)(
		"$provider accounts for spent credits and a simultaneous refund before reservation $finish",
		async ({ provider, finish }) => {
			const fixture = await prepare(provider, "month");
			const account = await client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			});
			const spent = await reserve(fixture.ownerId, account.id, 100n);
			await settleCredits(
				{ reservationId: spent.id, amount: 100n, referenceKey: `${spent.id}:settle` },
				client,
			);
			const pending = await reserve(fixture.ownerId, account.id, 200n);
			const first = await refundEvent(fixture, "concurrent-a", "9.50");
			const second = await refundEvent(fixture, "concurrent-b", "9.50");
			await Promise.all(
				[first, second].map((event) =>
					processProviderPaymentEvent({ paymentEventId: event.id }, client),
				),
			);
			expect(
				await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
			).toMatchObject({ spendableCredits: 0n, reservedCredits: 200n, creditDebt: 100n });
			if (finish === "release")
				await releaseCredits(
					{ reservationId: pending.id, referenceKey: `${pending.id}:release` },
					client,
				);
			else
				await settleCredits(
					{ reservationId: pending.id, amount: 200n, referenceKey: `${pending.id}:settle` },
					client,
				);
			await processProviderPaymentEvent({ paymentEventId: first.id }, client);
			expect(
				await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
			).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 0n,
				creditDebt: finish === "release" ? 100n : 300n,
			});
			expect(
				await client.subscriptionPaymentAdjustment.count({
					where: { provider, providerPaymentId: fixture.fact.payment.providerPaymentId },
				}),
			).toBe(2);
		},
	);

	it("requeues a previously unsupported verified refund through Outbox exactly once", async () => {
		const fixture = await prepare("waffo", "month");
		const event = await refundEvent(fixture, "legacy-unsupported", "19.00");
		await client.paymentEvent.update({
			where: { id: event.id },
			data: {
				status: "DEAD_LETTER",
				failureReason: "PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED",
				lastErrorClass: "TERMINAL",
			},
		});
		await requeuePreviouslyUnsupportedRefunds(client);
		await requeuePreviouslyUnsupportedRefunds(client);
		expect(
			await client.outboxEvent.count({ where: { dedupeKey: `refund-support-v1:${event.id}` } }),
		).toBe(1);
		expect(await processProviderPaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
			outcome: "PROCESSED",
		});
		expect(await effective(fixture.ownerId)).toBeNull();
	});

	it("a PayPal reversal after a partial refund withdraws at most the original payment", async () => {
		const fixture = await prepare("paypal", "month");
		await refund(fixture, "partial-before-reversal", "9.50");
		const providerEventId = `${prefix}-reversal`;
		const { event } = await ingestPaymentEvent(
			{
				provider: "paypal",
				providerEventId,
				verifiedAt: now,
				envelope: {
					id: providerEventId,
					event_type: "PAYMENT.SALE.REVERSED",
					create_time: now.toISOString(),
					resource: {
						id: fixture.fact.payment.providerPaymentId,
						billing_agreement_id: fixture.fact.providerSubscriptionId,
						state: "reversed",
						amount: { total: "19.00", currency: "USD" },
					},
				},
			},
			client,
		);
		await processProviderPaymentEvent({ paymentEventId: event.id }, client);
		await processProviderPaymentEvent({ paymentEventId: event.id }, client);
		expect((await periodsFor(fixture.fact.providerSubscriptionId))[0]).toMatchObject({
			refundedCredits: 700n,
			refundedAmount: 19000000n,
		});
		expect(await effective(fixture.ownerId)).toBeNull();
	});

	it("durably resumes a paginated provider backfill without duplicating events or skipping a failed page", async () => {
		const scope = `${prefix}-reconciliation`;
		const providerEventId = `${prefix}-recovered-event`;
		const event = {
			providerEventId,
			envelope: { id: providerEventId, event_type: "PAYMENT.SALE.COMPLETED" },
		};
		const first = await reconcileProviderPaymentEvents(
			{ provider: "paypal", scope, now, maxPages: 1 },
			client,
			async () => ({ events: [event], nextCursor: "second-page" }),
		);
		expect(first).toMatchObject({ recovered: 1, completed: false });
		expect(first.continuationKey).toEqual(expect.stringContaining(`payment-backfill:${scope}:`));
		const fixedWindow = await client.paymentReconciliationCheckpoint.findUniqueOrThrow({
			where: { id: scope },
		});
		await expect(
			reconcileProviderPaymentEvents({ provider: "paypal", scope, now }, client, async (window) => {
				expect(window.cursor).toBe("second-page");
				throw new Error("NETWORK_FAILURE");
			}),
		).rejects.toThrow("NETWORK_FAILURE");
		expect(
			await client.paymentReconciliationCheckpoint.findUniqueOrThrow({ where: { id: scope } }),
		).toMatchObject({ cursor: "second-page", leaseToken: null });
		const resumed = await reconcileProviderPaymentEvents(
			{ provider: "paypal", scope, now: new Date(now.getTime() + 300_000) },
			client,
			async (window) => {
				expect(window.cursor).toBe("second-page");
				expect(window.since).toEqual(fixedWindow.windowStart);
				expect(window.until).toEqual(fixedWindow.windowEnd);
				return { events: [event], nextCursor: null };
			},
		);
		expect(resumed).toMatchObject({ recovered: 0, completed: true });
		expect(resumed.continuationKey).toBeUndefined();
		expect(await client.paymentEvent.count({ where: { providerEventId } })).toBe(1);
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `payment-event:paypal:${providerEventId}` },
			}),
		).toBe(1);
	});
});

async function reserve(ownerId: string, accountId: string, amount: bigint) {
	const quote = await client.generationQuote.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKey: "billing-refund-test",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: amount,
			costMicros: 0n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(now.getTime() + 3600000),
		},
	});
	const job = await client.generationJob.create({
		data: {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: crypto.randomUUID(),
			productKey: quote.productKey,
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: amount,
			inputSnapshot: {},
			pricingSnapshot: {},
		},
	});
	return reserveCredits(
		{ accountId, jobId: job.id, amount, referenceKey: `${job.id}:reserve` },
		client,
	);
}

function addMonths(date: Date, offset: number) {
	const value = new Date(date);
	const day = value.getUTCDate();
	value.setUTCDate(1);
	value.setUTCMonth(value.getUTCMonth() + offset);
	const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
	value.setUTCDate(Math.min(day, last));
	return value;
}

function effective(ownerId: string, at = now) {
	return findEffectivePaidSubscription({ ownerType: "USER", ownerId, now: at }, client);
}

function periodsFor(providerSubscriptionId: string) {
	return client.billingPeriod.findMany({
		where: { subscription: { providerSubscriptionId } },
		orderBy: { startsAt: "asc" },
	});
}

async function prepare(
	provider: "paypal" | "waffo",
	interval: "month" | "year",
	options: {
		ownerId?: string;
		payerId?: string;
		startsAt?: Date;
		checkoutAt?: Date;
		pay?: boolean;
	} = {},
) {
	const label = crypto.randomUUID();
	const ownerId = options.ownerId ?? `${prefix}-${label}`;
	await client.user.upsert({
		where: { id: ownerId },
		update: {},
		create: {
			id: ownerId,
			email: `${ownerId}@example.test`,
			name: "Billing regression",
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		},
	});
	const plan = await client.billingPlan.create({
		data: {
			provider,
			providerPriceId: `${prefix}-${label}`,
			name: "creator",
			priceMicros: interval === "year" ? 190000000n : 19000000n,
			creditsPerPeriod: 700n,
			currency: "USD",
			metadata: { planId: "creator", interval, version: 1 },
		},
	});
	const checkout = await createPaymentCheckoutIntent(
		{
			provider,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			billingPlanId: plan.id,
			planKey: "creator",
			interval,
			idempotencyKey: `${prefix}-${label}`,
			now: options.checkoutAt ?? now,
		},
		client,
	);
	const providerSubscriptionId = `${provider}-${prefix}-${label}`;
	await markPaymentCheckoutIntentProviderCreating(
		{ intentId: checkout.intent.id, provider },
		client,
	);
	await bindPaymentCheckoutIntentSession(
		{
			intentId: checkout.intent.id,
			provider,
			providerSessionId: providerSubscriptionId,
			providerCheckoutUrl: "https://example.test/checkout",
			expiresAt: null,
		},
		client,
	);
	const startsAt = options.startsAt ?? new Date(now.getTime() - 86400000);
	const endsAt = addMonths(startsAt, interval === "year" ? 12 : 1);
	const fact = {
		provider,
		providerEventId: `${prefix}-${label}-paid`,
		providerSubscriptionId,
		checkoutIntentId: checkout.intent.id,
		providerCustomerId:
			provider === "waffo" ? `USER:${ownerId}` : (options.payerId ?? `PAYER-${label}`),
		status: "ACTIVE" as const,
		cancelAtPeriodEnd: false,
		occurredAt: startsAt,
		currentPeriod: { periodStart: startsAt, periodEnd: endsAt },
		payment: {
			providerPaymentId: `${prefix}-${label}-payment`,
			amountMicros: plan.priceMicros,
			currency: "USD",
			periodStart: startsAt,
			periodEnd: endsAt,
		},
	};
	if (options.pay !== false)
		await runSerializable(client, (tx) => applyProviderBillingFact(fact, tx));
	return { ownerId, checkout, fact, startsAt, endsAt };
}

async function refundEvent(
	fixture: Awaited<ReturnType<typeof prepare>>,
	suffix: string,
	amount: string,
) {
	const { provider } = fixture.fact;
	const eventId = `${prefix}-${fixture.checkout.intent.id}-${suffix}`;
	const envelope =
		provider === "paypal"
			? {
					id: eventId,
					event_type: "PAYMENT.SALE.REFUNDED",
					create_time: now.toISOString(),
					resource: {
						id: `${eventId}-refund`,
						state: "completed",
						sale_id: fixture.fact.payment.providerPaymentId,
						amount: { total: amount, currency: "USD" },
					},
				}
			: {
					id: eventId,
					eventId: `${eventId}-refund`,
					eventType: "refund.succeeded",
					timestamp: now.toISOString(),
					data: {
						orderId: fixture.fact.providerSubscriptionId,
						paymentId: fixture.fact.payment.providerPaymentId,
						refundStatus: "succeeded",
						amount,
						currency: "USD",
					},
				};
	return (
		await ingestPaymentEvent(
			{ provider, providerEventId: eventId, verifiedAt: now, envelope },
			client,
		)
	).event;
}

async function refund(
	fixture: Awaited<ReturnType<typeof prepare>>,
	suffix: string,
	amount: string,
) {
	const event = await refundEvent(fixture, suffix, amount);
	expect(await processProviderPaymentEvent({ paymentEventId: event.id }, client)).toMatchObject({
		outcome: "PROCESSED",
	});
	return event;
}
