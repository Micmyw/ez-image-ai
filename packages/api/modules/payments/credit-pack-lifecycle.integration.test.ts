import { PrismaPg } from "@prisma/adapter-pg";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	ingestPaymentEvent,
	markPaymentCheckoutIntentProviderCreating,
	reserveCredits,
	settleCredits,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { processProviderPaymentEvent } from "@repo/payments";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const PROCESS_NOW = new Date("2026-09-01T00:00:00.000Z");

describe("credit-pack payment lifecycle", () => {
	let client: PrismaClient;
	const ownerIds: string[] = [];
	const billingPlanIds: string[] = [];

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		await cleanupFixtures(client, ownerIds, billingPlanIds);
		await client.$disconnect();
	});

	it("fulfills two concurrent PayPal deliveries once from the frozen subscriber snapshot", async () => {
		const fixture = await createPackCheckout(client, {
			label: "concurrent",
			orderId: `ORDER-${RUN_ID}`,
			paidAt: new Date("2026-08-31T14:15:16.123Z"),
			subscriberBonusEligible: true,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);

		const first = await ingestCaptureEvent(client, fixture, {
			providerEventId: `capture-response-${RUN_ID}`,
			captureId: `CAPTURE-${RUN_ID}`,
			amount: "59.00",
		});
		const webhookReplay = await ingestCaptureEvent(client, fixture, {
			providerEventId: `webhook-capture-${RUN_ID}`,
			captureId: `CAPTURE-${RUN_ID}`,
			amount: "59.00",
		});

		const results = await Promise.all([
			processProviderPaymentEvent({ paymentEventId: first.id, now: PROCESS_NOW }, client, {
				attempt: 1,
				maxAttempts: 3,
			}),
			processProviderPaymentEvent({ paymentEventId: webhookReplay.id, now: PROCESS_NOW }, client, {
				attempt: 1,
				maxAttempts: 3,
			}),
		]);

		expect(results.map(({ outcome }) => outcome)).toEqual(["PROCESSED", "PROCESSED"]);
		expect(results.reduce((sum, result) => sum + result.grantsCreated, 0)).toBe(1);
		const fulfillment = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
			include: { purchase: true },
		});
		expect(fulfillment).toMatchObject({
			provider: "paypal",
			providerOrderId: fixture.orderId,
			providerPaymentId: `CAPTURE-${RUN_ID}`,
			baseCredits: 1_500n,
			bonusCredits: 300n,
			grantedCredits: 1_800n,
			paidAmountMicros: 59_000_000n,
			currency: "USD",
			status: "FULFILLED",
			purchase: {
				type: "ONE_TIME",
				productKind: "CREDIT_PACK",
				subscriptionId: null,
			},
		});
		expect(fulfillment.expiresAt).toEqual(new Date("2027-02-28T14:15:16.123Z"));
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_800n, creditDebt: 0n });
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: fulfillment.grantReferenceKey, type: "GRANT" },
			}),
		).toBe(1);
		expect(
			await client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
			}),
		).toMatchObject({ status: "COMPLETED", activeScopeKey: null });

		const partialRefund = await ingestRefundEvent(client, fixture, {
			providerEventId: `refund-half-${RUN_ID}`,
			refundId: `REFUND-HALF-${RUN_ID}`,
			captureId: `CAPTURE-${RUN_ID}`,
			amount: "29.50",
		});
		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: partialRefund.id, now: new Date("2026-09-02T00:00:00Z") },
				client,
			),
		).resolves.toMatchObject({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.creditPackFulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } }),
		).resolves.toMatchObject({
			refundedAmountMicros: 29_500_000n,
			refundedCredits: 900n,
			status: "PARTIALLY_REFUNDED",
		});

		const finalRefund = await ingestRefundEvent(client, fixture, {
			providerEventId: `refund-final-${RUN_ID}`,
			refundId: `REFUND-FINAL-${RUN_ID}`,
			captureId: `CAPTURE-${RUN_ID}`,
			amount: "29.50",
		});
		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: finalRefund.id, now: new Date("2026-09-03T00:00:00Z") },
				client,
			),
		).resolves.toMatchObject({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.creditPackFulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } }),
		).resolves.toMatchObject({
			refundedAmountMicros: 59_000_000n,
			refundedCredits: 1_800n,
			status: "REFUNDED",
		});
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: fulfillment.purchaseId! } }),
		).resolves.toMatchObject({ status: "refunded", productKind: "CREDIT_PACK" });
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 0n, creditDebt: 0n });
	});

	it("requeues only the matching PayPal refund after its capture is fulfilled", async () => {
		const fixture = await createPackCheckout(client, {
			label: "refund-before-fulfillment",
			orderId: `ORDER-REFUND-BEFORE-FULFILLMENT-${RUN_ID}`,
			paidAt: new Date("2026-09-01T00:00:00Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const captureId = `CAPTURE-REFUND-BEFORE-FULFILLMENT-${RUN_ID}`;
		const refund = await ingestRefundEvent(client, fixture, {
			providerEventId: `refund-before-fulfillment-${RUN_ID}`,
			refundId: `REFUND-BEFORE-FULFILLMENT-${RUN_ID}`,
			captureId,
			amount: "59.00",
		});
		const unrelatedRefund = await ingestRefundEvent(client, fixture, {
			providerEventId: `refund-unrelated-capture-${RUN_ID}`,
			refundId: `REFUND-UNRELATED-CAPTURE-${RUN_ID}`,
			captureId: `CAPTURE-UNRELATED-${RUN_ID}`,
			amount: "1.00",
		});

		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: refund.id, now: new Date("2026-09-02T01:00:00Z") },
				client,
				{ attempt: 1, maxAttempts: 2 },
			),
		).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		await expect(
			processProviderPaymentEvent(
				{
					paymentEventId: unrelatedRefund.id,
					now: new Date("2026-09-02T01:02:00Z"),
				},
				client,
				{ attempt: 1, maxAttempts: 1 },
			),
		).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: refund.id } }),
		).resolves.toMatchObject({
			status: "FAILED",
			attemptCount: 1,
			lastErrorClass: "TRANSIENT",
			failureReason: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING",
		});
		expect(
			await client.creditPackFulfillment.count({
				where: { checkoutIntentId: fixture.checkoutIntentId },
			}),
		).toBe(0);
		expect(await client.creditAccount.count({ where: { ownerId: fixture.ownerId } })).toBe(0);

		const payment = await ingestCaptureEvent(client, fixture, {
			providerEventId: `capture-after-refund-${RUN_ID}`,
			captureId,
			amount: "59.00",
		});
		const failureTransactionStarted = deferred();
		const releaseFailureTransaction = deferred();
		const refundClient = blockTransactionCall(client, 2, {
			onBlocked: failureTransactionStarted.resolve,
			release: releaseFailureTransaction.promise,
		});
		let refundFailure: unknown;
		const refundProcessing = processProviderPaymentEvent(
			{ paymentEventId: refund.id, now: new Date("2026-09-02T01:01:00Z") },
			refundClient,
			{ attempt: 2, maxAttempts: 2 },
		).catch((error: unknown) => {
			refundFailure = error;
		});
		await failureTransactionStarted.promise;
		try {
			await expect(
				client.paymentEvent.findUniqueOrThrow({ where: { id: refund.id } }),
			).resolves.toMatchObject({ status: "PROCESSING", attemptCount: 1 });
			await expect(
				processProviderPaymentEvent(
					{ paymentEventId: payment.id, now: new Date("2026-09-02T02:00:00Z") },
					client,
				),
			).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
			await expect(
				client.paymentEvent.findUniqueOrThrow({ where: { id: refund.id } }),
			).resolves.toMatchObject({ status: "PROCESSING", attemptCount: 1 });
			expect(
				await client.outboxEvent.count({
					where: { eventType: "PAYMENT_EVENT_RECEIVED", aggregateId: refund.id },
				}),
			).toBe(1);
		} finally {
			releaseFailureTransaction.resolve();
			await refundProcessing;
		}
		expect(refundFailure).toMatchObject({
			message: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING",
		});

		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: refund.id } }),
		).resolves.toMatchObject({ status: "FAILED", attemptCount: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: unrelatedRefund.id } }),
		).resolves.toMatchObject({ status: "DEAD_LETTER", attemptCount: 1 });
		expect(
			await client.outboxEvent.count({
				where: { eventType: "PAYMENT_EVENT_RECEIVED", aggregateId: refund.id },
			}),
		).toBe(2);
		expect(
			await client.outboxEvent.count({
				where: { eventType: "PAYMENT_EVENT_RECEIVED", aggregateId: unrelatedRefund.id },
			}),
		).toBe(1);

		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: refund.id, now: new Date("2026-09-03T00:00:00Z") },
				client,
			),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: refund.id, now: new Date("2026-09-03T00:01:00Z") },
				client,
			),
		).resolves.toEqual({ outcome: "SKIPPED", grantsCreated: 0 });

		const fulfillment = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
		});
		expect(fulfillment).toMatchObject({
			provider: "paypal",
			providerPaymentId: captureId,
			grantedCredits: 1_500n,
			refundedCredits: 1_500n,
			refundedAmountMicros: 59_000_000n,
			status: "REFUNDED",
		});
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 0n });
		const adjustment = await client.creditPackAdjustment.findUniqueOrThrow({
			where: {
				provider_providerAdjustmentId: {
					provider: "paypal",
					providerAdjustmentId: `REFUND-BEFORE-FULFILLMENT-${RUN_ID}`,
				},
			},
		});
		expect(adjustment).toMatchObject({
			fulfillmentId: fulfillment.id,
			finalizedCredits: 1_500n,
			status: "SUCCEEDED",
		});
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: adjustment.refundReferenceKey! },
			}),
		).toBe(1);
	});

	it("moves a reliably correlated checkout to review when its payment event is dead-lettered", async () => {
		const fixture = await createPackCheckout(client, {
			label: "wrong-amount",
			orderId: `ORDER-WRONG-${RUN_ID}`,
			paidAt: new Date("2026-09-01T01:00:00Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const activeScopeKey = (
			await client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
				select: { activeScopeKey: true },
			})
		).activeScopeKey;
		expect(activeScopeKey).not.toBeNull();
		const event = await ingestCaptureEvent(client, fixture, {
			providerEventId: `wrong-amount-${RUN_ID}`,
			captureId: `CAPTURE-WRONG-${RUN_ID}`,
			amount: "58.99",
		});

		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: event.id, now: new Date("2026-09-01T01:01:00Z") },
				client,
			),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		expect(
			await client.creditPackFulfillment.count({
				where: { checkoutIntentId: fixture.checkoutIntentId },
			}),
		).toBe(0);
		expect(await client.purchase.count({ where: { userId: fixture.ownerId } })).toBe(0);
		expect(await client.creditAccount.count({ where: { ownerId: fixture.ownerId } })).toBe(0);
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "CREDIT_PACK_AMOUNT_MISMATCH",
		});
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
			}),
		).resolves.toMatchObject({ status: "REVIEW", activeScopeKey });
	});

	it("persists a succeeded refund adjustment even when cumulative rounding produces no new credit delta", async () => {
		const fixture = await createPackCheckout(client, {
			label: "zero-credit-delta",
			orderId: `ORDER-ZERO-DELTA-${RUN_ID}`,
			paidAt: new Date("2026-09-01T02:00:00Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const payment = await ingestCaptureEvent(client, fixture, {
			providerEventId: `capture-zero-delta-${RUN_ID}`,
			captureId: `CAPTURE-ZERO-DELTA-${RUN_ID}`,
			amount: "59.00",
		});
		await processProviderPaymentEvent(
			{ paymentEventId: payment.id, now: new Date("2026-09-01T02:01:00Z") },
			client,
		);

		for (const [sequence, refundId] of [
			[1, `REFUND-MICRO-A-${RUN_ID}`],
			[2, `REFUND-MICRO-B-${RUN_ID}`],
		] as const) {
			const refund = await ingestRefundEvent(client, fixture, {
				providerEventId: `refund-micro-${sequence}-${RUN_ID}`,
				refundId,
				captureId: `CAPTURE-ZERO-DELTA-${RUN_ID}`,
				amount: "0.000001",
			});
			await expect(
				processProviderPaymentEvent(
					{
						paymentEventId: refund.id,
						now: new Date(`2026-09-0${sequence + 1}T02:01:00Z`),
					},
					client,
				),
			).resolves.toMatchObject({ outcome: "PROCESSED", grantsCreated: 0 });
		}

		const fulfillment = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
			include: { adjustments: { orderBy: { providerAdjustmentId: "asc" } }, purchase: true },
		});
		expect(fulfillment).toMatchObject({
			refundedAmountMicros: 2n,
			refundedCredits: 1n,
			status: "PARTIALLY_REFUNDED",
			purchase: { status: "partially_refunded" },
		});
		expect(fulfillment.adjustments).toHaveLength(2);
		expect(fulfillment.adjustments.map(({ finalizedCredits }) => finalizedCredits)).toEqual([
			1n,
			0n,
		]);
		for (const adjustment of fulfillment.adjustments) {
			expect(adjustment.creditsFinalizedAt).not.toBeNull();
			expect(adjustment.refundReferenceKey).toBe(
				`credit-pack-adjustment:${adjustment.id}:refund:v1`,
			);
		}
	});

	it("turns a full refund of already-consumed pack credits into credit debt", async () => {
		const fixture = await createPackCheckout(client, {
			label: "consumed-refund",
			orderId: `ORDER-CONSUMED-${RUN_ID}`,
			paidAt: new Date("2026-09-01T03:00:00Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const payment = await ingestCaptureEvent(client, fixture, {
			providerEventId: `capture-consumed-${RUN_ID}`,
			captureId: `CAPTURE-CONSUMED-${RUN_ID}`,
			amount: "59.00",
		});
		await processProviderPaymentEvent(
			{ paymentEventId: payment.id, now: new Date("2026-09-01T03:01:00Z") },
			client,
		);

		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
		});
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				productKey: "credit-pack-refund-test",
				catalogVersion: "test-v1",
				pricingVersion: "test-v1",
				credits: 250n,
				costMicros: 0n,
				inputSnapshot: { kind: "test" },
				pricingSnapshot: { kind: "test" },
				expiresAt: new Date("2026-09-01T04:00:00Z"),
			},
		});
		const job = await client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId: fixture.ownerId,
				submittedByUserId: fixture.ownerId,
				quoteId: quote.id,
				idempotencyKey: `consume-pack-${RUN_ID}`,
				productKey: quote.productKey,
				catalogVersion: quote.catalogVersion,
				pricingVersion: quote.pricingVersion,
				creditsReserved: 250n,
				inputSnapshot: { kind: "test" },
				pricingSnapshot: { kind: "test" },
			},
		});
		const reservation = await reserveCredits(
			{
				accountId: account.id,
				jobId: job.id,
				amount: 250n,
				referenceKey: `credit-pack-consume:${job.id}:reserve`,
			},
			client,
		);
		await settleCredits(
			{
				reservationId: reservation.id,
				amount: 250n,
				referenceKey: `credit-pack-consume:${job.id}:settle`,
			},
			client,
		);

		const refund = await ingestRefundEvent(client, fixture, {
			providerEventId: `refund-consumed-${RUN_ID}`,
			refundId: `REFUND-CONSUMED-${RUN_ID}`,
			captureId: `CAPTURE-CONSUMED-${RUN_ID}`,
			amount: "59.00",
		});
		await expect(
			processProviderPaymentEvent(
				{ paymentEventId: refund.id, now: new Date("2026-09-02T03:00:00Z") },
				client,
			),
		).resolves.toMatchObject({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).resolves.toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 250n });
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: account.id, type: "DEBT_INCURRED", amount: 250n },
			}),
		).toBe(1);
	});

	it("fulfills a Waffo Credit Pack order from its frozen checkout snapshot", async () => {
		const fixture = await createPackCheckout(client, {
			label: "waffo-success",
			provider: "waffo",
			orderId: `WAFFO-ORDER-SUCCESS-${RUN_ID}`,
			paidAt: new Date("2026-08-31T10:15:16.123Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const payment = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-success-${RUN_ID}`,
			paymentId: `WAFFO-PAYMENT-SUCCESS-${RUN_ID}`,
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: payment.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });

		const fulfillment = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
			include: { purchase: true },
		});
		expect(fulfillment).toMatchObject({
			provider: "waffo",
			providerOrderId: fixture.orderId,
			providerPaymentId: `WAFFO-PAYMENT-SUCCESS-${RUN_ID}`,
			baseCredits: 1_500n,
			bonusCredits: 0n,
			grantedCredits: 1_500n,
			paidAmountMicros: 59_000_000n,
			currency: "USD",
			status: "FULFILLED",
			purchase: {
				type: "ONE_TIME",
				productKind: "CREDIT_PACK",
				provider: "waffo",
				customerId: `USER:${fixture.ownerId}`,
				subscriptionId: null,
				status: "completed",
			},
		});
		expect(fulfillment.expiresAt).toEqual(new Date("2027-02-28T10:15:16.123Z"));
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_500n, reservedCredits: 0n, creditDebt: 0n });
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
			}),
		).resolves.toMatchObject({
			providerOrderId: fixture.orderId,
			status: "COMPLETED",
			activeScopeKey: null,
		});
	});

	it("processes Waffo payment deliveries with different event IDs but grants once", async () => {
		const fixture = await createPackCheckout(client, {
			label: "waffo-replay",
			provider: "waffo",
			orderId: `WAFFO-ORDER-REPLAY-${RUN_ID}`,
			paidAt: new Date("2026-08-31T11:15:16.123Z"),
			subscriberBonusEligible: true,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const paymentId = `WAFFO-PAYMENT-REPLAY-${RUN_ID}`;
		const first = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-delivery-a-${RUN_ID}`,
			paymentId,
		});
		const replay = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-delivery-b-${RUN_ID}`,
			paymentId,
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: first.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
		await expect(
			processProviderPaymentEvent({ paymentEventId: replay.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });

		const fulfillment = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
		});
		expect(
			await client.creditPackFulfillment.count({
				where: { checkoutIntentId: fixture.checkoutIntentId },
			}),
		).toBe(1);
		expect(await client.purchase.count({ where: { userId: fixture.ownerId } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: fulfillment.grantReferenceKey, type: "GRANT" },
			}),
		).toBe(1);
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_800n, creditDebt: 0n });
		await expect(
			client.paymentEvent.findMany({
				where: { id: { in: [first.id, replay.id] } },
				orderBy: { providerEventId: "asc" },
				select: { status: true },
			}),
		).resolves.toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
	});

	it("dead-letters a Waffo Credit Pack payment with the wrong buyer identity", async () => {
		const fixture = await createPackCheckout(client, {
			label: "waffo-wrong-buyer",
			provider: "waffo",
			orderId: `WAFFO-ORDER-WRONG-BUYER-${RUN_ID}`,
			paidAt: new Date("2026-08-31T12:15:16.123Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const event = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-wrong-buyer-${RUN_ID}`,
			paymentId: `WAFFO-PAYMENT-WRONG-BUYER-${RUN_ID}`,
			buyerIdentity: `USER:not-${fixture.ownerId}`,
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: event.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "CREDIT_PACK_OWNER_MISMATCH",
		});
		expect(
			await client.creditPackFulfillment.count({
				where: { checkoutIntentId: fixture.checkoutIntentId },
			}),
		).toBe(0);
		expect(await client.purchase.count({ where: { userId: fixture.ownerId } })).toBe(0);
		expect(await client.creditAccount.count({ where: { ownerId: fixture.ownerId } })).toBe(0);
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
			}),
		).resolves.toMatchObject({ status: "PROVIDER_PENDING", providerOrderId: null });
	});

	it("moves a reliably correlated Waffo checkout to review after a terminal payment mismatch", async () => {
		const fixture = await createPackCheckout(client, {
			label: "waffo-review",
			provider: "waffo",
			orderId: `WAFFO-ORDER-REVIEW-${RUN_ID}`,
			paidAt: new Date("2026-08-31T12:45:16.123Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const activeScopeKey = (
			await client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
				select: { activeScopeKey: true },
			})
		).activeScopeKey;
		expect(activeScopeKey).not.toBeNull();
		const event = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-review-${RUN_ID}`,
			paymentId: `WAFFO-PAYMENT-REVIEW-${RUN_ID}`,
			amount: "58.99",
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: event.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "CREDIT_PACK_AMOUNT_MISMATCH",
		});
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: fixture.checkoutIntentId },
			}),
		).resolves.toMatchObject({ status: "REVIEW", activeScopeKey });
		expect(
			await client.creditPackFulfillment.count({
				where: { checkoutIntentId: fixture.checkoutIntentId },
			}),
		).toBe(0);
		expect(await client.purchase.count({ where: { userId: fixture.ownerId } })).toBe(0);
		expect(await client.creditAccount.count({ where: { ownerId: fixture.ownerId } })).toBe(0);
	});

	it("dead-letters a Waffo providerOrderId binding conflict without granting credits", async () => {
		const sharedOrderId = `WAFFO-ORDER-CONFLICT-${RUN_ID}`;
		const boundFixture = await createPackCheckout(client, {
			label: "waffo-order-bound",
			provider: "waffo",
			orderId: sharedOrderId,
			paidAt: new Date("2026-08-31T13:15:16.123Z"),
			subscriberBonusEligible: false,
			bindProviderOrderId: true,
		});
		const fixture = await createPackCheckout(client, {
			label: "waffo-order-conflict",
			provider: "waffo",
			orderId: `WAFFO-ORDER-UNBOUND-${RUN_ID}`,
			paidAt: new Date("2026-08-31T13:16:16.123Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(boundFixture.ownerId, fixture.ownerId);
		billingPlanIds.push(boundFixture.billingPlanId, fixture.billingPlanId);
		const event = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-order-conflict-${RUN_ID}`,
			paymentId: `WAFFO-PAYMENT-ORDER-CONFLICT-${RUN_ID}`,
			orderId: sharedOrderId,
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: event.id, now: PROCESS_NOW }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "CREDIT_PACK_CHECKOUT_ORDER_CONFLICT",
		});
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({ where: { id: fixture.checkoutIntentId } }),
		).resolves.toMatchObject({ status: "PROVIDER_PENDING", providerOrderId: null });
		await expect(
			client.paymentCheckoutIntent.findUniqueOrThrow({
				where: { id: boundFixture.checkoutIntentId },
			}),
		).resolves.toMatchObject({ status: "PROVIDER_PENDING", providerOrderId: sharedOrderId });
		expect(
			await client.creditPackFulfillment.count({
				where: { ownerId: { in: [boundFixture.ownerId, fixture.ownerId] } },
			}),
		).toBe(0);
		expect(
			await client.purchase.count({
				where: { userId: { in: [boundFixture.ownerId, fixture.ownerId] } },
			}),
		).toBe(0);
		expect(
			await client.creditAccount.count({
				where: { ownerId: { in: [boundFixture.ownerId, fixture.ownerId] } },
			}),
		).toBe(0);
	});

	it("dead-letters Waffo refund events without changing the fulfilled pack ledger", async () => {
		const fixture = await createPackCheckout(client, {
			label: "waffo-refund-review",
			provider: "waffo",
			orderId: `WAFFO-ORDER-REFUND-${RUN_ID}`,
			paidAt: new Date("2026-08-31T14:15:16.123Z"),
			subscriberBonusEligible: false,
		});
		ownerIds.push(fixture.ownerId);
		billingPlanIds.push(fixture.billingPlanId);
		const payment = await ingestWaffoPaymentEvent(client, fixture, {
			providerEventId: `waffo-paid-before-refund-${RUN_ID}`,
			paymentId: `WAFFO-PAYMENT-REFUND-${RUN_ID}`,
		});
		await processProviderPaymentEvent({ paymentEventId: payment.id, now: PROCESS_NOW }, client);

		const fulfillmentBefore = await client.creditPackFulfillment.findUniqueOrThrow({
			where: { checkoutIntentId: fixture.checkoutIntentId },
			select: {
				id: true,
				purchaseId: true,
				status: true,
				refundedAmountMicros: true,
				refundedCredits: true,
				grantedCredits: true,
				providerOrderId: true,
				providerPaymentId: true,
			},
		});
		expect(fulfillmentBefore.purchaseId).not.toBeNull();
		const purchaseBefore = await client.purchase.findUniqueOrThrow({
			where: { id: fulfillmentBefore.purchaseId! },
			select: { status: true, productKind: true, type: true, customerId: true },
		});
		const accountBefore = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
			select: { spendableCredits: true, reservedCredits: true, creditDebt: true },
		});
		const ledgerCountBefore = await client.creditLedgerEntry.count({
			where: { account: { ownerType: "USER", ownerId: fixture.ownerId } },
		});
		for (const [suffix, eventType] of [
			["succeeded", "refund.succeeded"],
			["failed", "refund.failed"],
		] as const) {
			const refund = await ingestWaffoRefundEvent(client, fixture, {
				providerEventId: `waffo-refund-${suffix}-${RUN_ID}`,
				refundId: `WAFFO-REFUND-${suffix.toUpperCase()}-${RUN_ID}`,
				paymentId: fulfillmentBefore.providerPaymentId,
				eventType,
			});

			await expect(
				processProviderPaymentEvent(
					{ paymentEventId: refund.id, now: new Date("2026-09-01T01:00:00Z") },
					client,
				),
			).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
			await expect(
				client.paymentEvent.findUniqueOrThrow({ where: { id: refund.id } }),
			).resolves.toMatchObject({
				status: "DEAD_LETTER",
				failureReason: "PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED",
			});
		}
		await expect(
			client.creditPackFulfillment.findUniqueOrThrow({
				where: { id: fulfillmentBefore.id },
				select: {
					id: true,
					purchaseId: true,
					status: true,
					refundedAmountMicros: true,
					refundedCredits: true,
					grantedCredits: true,
					providerOrderId: true,
					providerPaymentId: true,
				},
			}),
		).resolves.toEqual(fulfillmentBefore);
		await expect(
			client.purchase.findUniqueOrThrow({
				where: { id: fulfillmentBefore.purchaseId! },
				select: { status: true, productKind: true, type: true, customerId: true },
			}),
		).resolves.toEqual(purchaseBefore);
		await expect(
			client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId: fixture.ownerId } },
				select: { spendableCredits: true, reservedCredits: true, creditDebt: true },
			}),
		).resolves.toEqual(accountBefore);
		expect(
			await client.creditPackAdjustment.count({
				where: { fulfillmentId: fulfillmentBefore.id },
			}),
		).toBe(0);
		expect(
			await client.creditLedgerEntry.count({
				where: { account: { ownerType: "USER", ownerId: fixture.ownerId } },
			}),
		).toBe(ledgerCountBefore);
	});
});

interface PackCheckoutFixture {
	ownerId: string;
	billingPlanId: string;
	checkoutIntentId: string;
	orderId: string;
	paidAt: Date;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function blockTransactionCall(
	client: PrismaClient,
	callNumber: number,
	barrier: { onBlocked: () => void; release: Promise<void> },
): PrismaClient {
	let transactionCalls = 0;
	const transaction = client.$transaction.bind(client) as (...args: unknown[]) => Promise<unknown>;
	return new Proxy(client, {
		get(target, property) {
			if (property === "$transaction") {
				return async (...args: unknown[]) => {
					transactionCalls += 1;
					if (transactionCalls === callNumber) {
						barrier.onBlocked();
						await barrier.release;
					}
					return transaction(...args);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as PrismaClient;
}

async function createPackCheckout(
	client: PrismaClient,
	input: {
		label: string;
		provider?: "paypal" | "waffo";
		orderId: string;
		paidAt: Date;
		subscriberBonusEligible: boolean;
		bindProviderOrderId?: boolean;
	},
): Promise<PackCheckoutFixture> {
	const provider = input.provider ?? "paypal";
	const ownerId = `credit-pack-${input.label}-${RUN_ID}`;
	const billingPlanId = `credit-pack-plan-${input.label}-${RUN_ID}`;
	await client.user.create({
		data: {
			id: ownerId,
			name: "Credit Pack Test Owner",
			email: `${ownerId}@example.test`,
			emailVerified: true,
			createdAt: PROCESS_NOW,
			updatedAt: PROCESS_NOW,
		},
	});
	await client.billingPlan.create({
		data: {
			id: billingPlanId,
			provider,
			providerPriceId: `PROD-${input.label.toUpperCase()}-${RUN_ID}`,
			productKind: "CREDIT_PACK",
			name: "credits-1500",
			creditsPerPeriod: 1_500n,
			priceMicros: 59_000_000n,
			currency: "USD",
			version: 1,
			metadata: {
				version: 1,
				productKind: "CREDIT_PACK",
				packKey: "credits-1500",
				catalogVersion: "2026-09-06.1",
				pricingVersion: "2026-09-06.1",
				expiryMonths: 6,
			},
		},
	});
	const checkout = await createPaymentCheckoutIntent(
		{
			provider,
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKind: "CREDIT_PACK",
			billingPlanId,
			planKey: "credits-1500",
			interval: "one-time",
			idempotencyKey: `checkout-${input.label}-${RUN_ID}`,
			now: new Date(input.paidAt.getTime() - 60_000),
			creditPackSnapshot: {
				catalogVersion: "2026-09-06.1",
				pricingVersion: "2026-09-06.1",
				subscriberEligibilityVersion: "2026-09-06.1",
				baseCredits: 1_500n,
				bonusCredits: input.subscriberBonusEligible ? 300n : 0n,
				totalCredits: input.subscriberBonusEligible ? 1_800n : 1_500n,
				expiryMonths: 6,
				subscriberBonusEligible: input.subscriberBonusEligible,
				subscriberSubscriptionId: input.subscriberBonusEligible ? `SUB-${RUN_ID}` : null,
				subscriberPlanKey: input.subscriberBonusEligible ? "creator" : null,
				eligibilityEvaluatedAt: new Date(input.paidAt.getTime() - 60_000),
			},
		},
		client,
	);
	await markPaymentCheckoutIntentProviderCreating(
		{ intentId: checkout.intent.id, provider },
		client,
	);
	const providerSessionId =
		provider === "paypal" ? input.orderId : `WAFFO-SESSION-${input.label}-${RUN_ID}`;
	await bindPaymentCheckoutIntentSession(
		{
			intentId: checkout.intent.id,
			provider,
			providerSessionId,
			...(input.bindProviderOrderId ? { providerOrderId: input.orderId } : {}),
			providerCheckoutUrl:
				provider === "paypal"
					? `https://www.sandbox.paypal.com/checkoutnow?token=${input.orderId}`
					: `https://checkout.waffo.example.test/${providerSessionId}`,
		},
		client,
	);
	return {
		ownerId,
		billingPlanId,
		checkoutIntentId: checkout.intent.id,
		orderId: input.orderId,
		paidAt: input.paidAt,
	};
}

async function ingestCaptureEvent(
	client: PrismaClient,
	fixture: PackCheckoutFixture,
	input: { providerEventId: string; captureId: string; amount: string },
) {
	const result = await ingestPaymentEvent(
		{
			provider: "paypal",
			providerEventId: input.providerEventId,
			normalizedTransactionId: input.captureId,
			verifiedAt: PROCESS_NOW,
			receivedAt: PROCESS_NOW,
			envelope: {
				id: input.providerEventId,
				event_type: "PAYMENT.CAPTURE.COMPLETED",
				create_time: PROCESS_NOW.toISOString(),
				resource: {
					id: input.captureId,
					status: "COMPLETED",
					final_capture: true,
					create_time: fixture.paidAt.toISOString(),
					custom_id: fixture.checkoutIntentId,
					payer_id: `PAYER-${fixture.ownerId}`,
					amount: { currency_code: "USD", value: input.amount },
					supplementary_data: { related_ids: { order_id: fixture.orderId } },
				},
			},
		},
		client,
	);
	return result.event;
}

async function ingestRefundEvent(
	client: PrismaClient,
	fixture: PackCheckoutFixture,
	input: {
		providerEventId: string;
		refundId: string;
		captureId: string;
		amount: string;
	},
) {
	const occurredAt = new Date(fixture.paidAt.getTime() + 86_400_000);
	const result = await ingestPaymentEvent(
		{
			provider: "paypal",
			providerEventId: input.providerEventId,
			normalizedTransactionId: input.refundId,
			verifiedAt: occurredAt,
			receivedAt: occurredAt,
			envelope: {
				id: input.providerEventId,
				event_type: "PAYMENT.CAPTURE.REFUNDED",
				create_time: occurredAt.toISOString(),
				resource: {
					id: input.refundId,
					status: "COMPLETED",
					create_time: occurredAt.toISOString(),
					amount: { currency_code: "USD", value: input.amount },
					links: [
						{
							rel: "up",
							href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${input.captureId}`,
							method: "GET",
						},
					],
				},
			},
		},
		client,
	);
	return result.event;
}

async function ingestWaffoPaymentEvent(
	client: PrismaClient,
	fixture: PackCheckoutFixture,
	input: {
		providerEventId: string;
		paymentId: string;
		orderId?: string;
		buyerIdentity?: string;
		amount?: string;
	},
) {
	const result = await ingestPaymentEvent(
		{
			provider: "waffo",
			providerEventId: input.providerEventId,
			normalizedTransactionId: input.paymentId,
			verifiedAt: PROCESS_NOW,
			receivedAt: PROCESS_NOW,
			envelope: {
				id: input.providerEventId,
				eventType: "order.completed",
				timestamp: fixture.paidAt.toISOString(),
				data: {
					orderId: input.orderId ?? fixture.orderId,
					orderMerchantExternalId: fixture.checkoutIntentId,
					merchantProvidedBuyerIdentity: input.buyerIdentity ?? `USER:${fixture.ownerId}`,
					paymentStatus: "succeeded",
					paymentId: input.paymentId,
					amount: input.amount ?? "59.00",
					currency: "USD",
				},
			},
		},
		client,
	);
	return result.event;
}

async function ingestWaffoRefundEvent(
	client: PrismaClient,
	fixture: PackCheckoutFixture,
	input: {
		providerEventId: string;
		refundId: string;
		paymentId: string;
		eventType: "refund.succeeded" | "refund.failed";
	},
) {
	const occurredAt = new Date(fixture.paidAt.getTime() + 86_400_000);
	const result = await ingestPaymentEvent(
		{
			provider: "waffo",
			providerEventId: input.providerEventId,
			normalizedTransactionId: input.refundId,
			verifiedAt: occurredAt,
			receivedAt: occurredAt,
			envelope: {
				id: input.providerEventId,
				eventType: input.eventType,
				timestamp: occurredAt.toISOString(),
				data: {
					orderId: fixture.orderId,
					paymentId: input.paymentId,
					refundId: input.refundId,
					amount: "59.00",
					currency: "USD",
				},
			},
		},
		client,
	);
	return result.event;
}

async function cleanupFixtures(
	client: PrismaClient,
	ownerIds: string[],
	billingPlanIds: string[],
): Promise<void> {
	await client.$transaction(async (tx) => {
		const events = await tx.paymentEvent.findMany({
			where: { providerEventId: { contains: RUN_ID } },
			select: { id: true },
		});
		const fulfillments = await tx.creditPackFulfillment.findMany({
			where: { ownerId: { in: ownerIds } },
			select: { id: true },
		});
		const adjustments = await tx.creditPackAdjustment.findMany({
			where: { fulfillmentId: { in: fulfillments.map(({ id }) => id) } },
			select: { id: true },
		});
		const aggregateIds = [
			...events.map(({ id }) => id),
			...fulfillments.map(({ id }) => id),
			...adjustments.map(({ id }) => id),
		];
		await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
		await tx.auditLog.deleteMany({ where: { targetId: { in: aggregateIds } } });
		await tx.paymentEvent.deleteMany({ where: { id: { in: events.map(({ id }) => id) } } });
		const accounts = await tx.creditAccount.findMany({
			where: { ownerType: "USER", ownerId: { in: ownerIds } },
			select: { id: true },
		});
		const accountIds = accounts.map(({ id }) => id);
		if (accountIds.length > 0) {
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
			await tx.creditLot.deleteMany({ where: { accountId: { in: accountIds } } });
		}
		await tx.creditPackAdjustment.deleteMany({
			where: { id: { in: adjustments.map(({ id }) => id) } },
		});
		await tx.creditPackFulfillment.deleteMany({
			where: { id: { in: fulfillments.map(({ id }) => id) } },
		});
		await tx.purchase.deleteMany({ where: { userId: { in: ownerIds } } });
		await tx.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
		await tx.paymentCheckoutIntent.deleteMany({ where: { ownerId: { in: ownerIds } } });
		await tx.billingPlan.deleteMany({ where: { id: { in: billingPlanIds } } });
		const jobs = await tx.generationJob.findMany({
			where: { ownerType: "USER", ownerId: { in: ownerIds } },
			select: { id: true, quoteId: true },
		});
		await tx.generationJob.deleteMany({ where: { id: { in: jobs.map(({ id }) => id) } } });
		await tx.generationQuote.deleteMany({
			where: { id: { in: jobs.map(({ quoteId }) => quoteId) } },
		});
		await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
	});
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"UNSAFE_TEST_DATABASE: expected 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
	}
	return TEST_DATABASE_URL;
}
