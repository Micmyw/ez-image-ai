import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeDatabaseUrl } from "../../../../tests/load/assert-safe-target";
import { createRuntimeDatabaseClient, runWithDatabaseClient } from "../client";
import {
	getPortraitPackTrials,
	hasPortraitPackPurchase,
	issuePortraitPackTrial,
} from "./portrait-packs";

let client: ReturnType<typeof createRuntimeDatabaseClient>;
let secondClient: typeof client;
beforeAll(() => {
	const url = assertSafeDatabaseUrl(process.env.TEST_DATABASE_URL).toString();
	client = createRuntimeDatabaseClient(url);
	secondClient = createRuntimeDatabaseClient(url);
});
afterAll(async () => {
	await Promise.all([client?.$disconnect(), secondClient?.$disconnect()]);
});

describe("portrait pack persistence", () => {
	it("allows two concurrent openings, preserves both replays, and refuses a third opening", async () => {
		const subjectKey = `browser:fixture-${randomUUID()}`;
		const first = { subjectKey, requestId: randomUUID(), cardKeys: ["a", "b", "c", "d", "e"] };
		const second = { subjectKey, requestId: randomUUID(), cardKeys: ["f", "g", "h", "i", "j"] };
		const receipts = await Promise.all([
			runWithDatabaseClient(client, () => issuePortraitPackTrial(first)),
			runWithDatabaseClient(secondClient, () => issuePortraitPackTrial(second)),
		]);
		expect(receipts.map((entry) => entry.used).sort((left, right) => left - right)).toEqual([1, 2]);
		const [savedFirst, savedSecond] = receipts;
		expect(savedFirst.receipt).toEqual({ requestId: first.requestId, cardKeys: first.cardKeys });
		expect(savedSecond.receipt).toEqual({ requestId: second.requestId, cardKeys: second.cardKeys });
		const replay = await runWithDatabaseClient(client, () => issuePortraitPackTrial(first));
		expect(replay).toEqual({ receipt: savedFirst.receipt, used: 2 });
		const capped = await runWithDatabaseClient(client, () =>
			issuePortraitPackTrial({ ...first, requestId: randomUUID() }),
		);
		expect(capped).toEqual(receipts.find((entry) => entry.used === 2));
		expect(
			await runWithDatabaseClient(client, () => getPortraitPackTrials(subjectKey)),
		).toHaveLength(2);
	});

	it("unlocks an expired bought credit pack only after a verified live receipt", async () => {
		const ownerId = randomUUID();
		const paymentId = randomUUID();
		const plan = await client.billingPlan.create({
			data: {
				provider: "paypal",
				providerPriceId: randomUUID(),
				productKind: "CREDIT_PACK",
				name: "Fixture",
				creditsPerPeriod: 10n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: {},
			},
		});
		const checkout = await client.paymentCheckoutIntent.create({
			data: {
				billingPlanId: plan.id,
				provider: plan.provider,
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				planKey: "fixture",
				interval: "one-time",
				idempotencyKey: randomUUID(),
				productKind: "CREDIT_PACK",
				status: "COMPLETED",
				creditPackCatalogVersion: "fixture-v1",
				creditPackPricingVersion: "fixture-v1",
				creditPackSubscriberEligibilityVersion: "fixture-v1",
				creditPackBaseCredits: 10n,
				creditPackBonusCredits: 0n,
				creditPackTotalCredits: 10n,
				creditPackExpiryMonths: 6,
				creditPackSubscriberBonusEligible: false,
				creditPackEligibilityEvaluatedAt: new Date(),
			},
		});
		const fulfillment = await client.creditPackFulfillment.create({
			data: {
				billingPlanId: plan.id,
				checkoutIntentId: checkout.id,
				ownerType: "USER",
				ownerId,
				provider: plan.provider,
				providerOrderId: randomUUID(),
				providerPaymentId: paymentId,
				paidAmountMicros: 1_000_000n,
				currency: "USD",
				baseCredits: 10n,
				bonusCredits: 0n,
				grantedCredits: 10n,
				grantReferenceKey: randomUUID(),
				paidAt: new Date("2024-01-01T00:00:00Z"),
				expiresAt: new Date("2025-01-01T00:00:00Z"),
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: plan.provider,
				providerEnvironment: "sandbox",
				providerEventId: randomUUID(),
				normalizedTransactionId: paymentId,
				verifiedAt: new Date(),
				status: "PROCESSED",
				envelope: { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: paymentId } },
			},
		});
		const unlocked = (id = ownerId) =>
			runWithDatabaseClient(client, () => hasPortraitPackPurchase(id));
		expect(await unlocked()).toBe(false);
		await client.paymentEvent.update({
			where: { id: event.id },
			data: { providerEnvironment: "live" },
		});
		expect(await unlocked()).toBe(true);
		expect(await unlocked(randomUUID())).toBe(false);
		await client.creditPackFulfillment.update({
			where: { id: fulfillment.id },
			data: { status: "REFUNDED", refundedAmountMicros: 1_000_000n },
		});
		expect(await unlocked()).toBe(false);
	});

	it("unlocks a closed paid subscription period and excludes a refunded one", async () => {
		const ownerId = randomUUID();
		const invoice = randomUUID();
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: randomUUID(),
				name: "Fixture",
				creditsPerPeriod: 10n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: {},
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: plan.provider,
				providerSubscriptionId: randomUUID(),
				planId: plan.id,
				status: "EXPIRED",
			},
		});
		const period = await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date("2024-01-01T00:00:00Z"),
				endsAt: new Date("2024-02-01T00:00:00Z"),
				status: "CLOSED",
				creditAmount: 10n,
				paidAmount: 100n,
				providerInvoiceId: invoice,
			},
		});
		const unlocked = () => runWithDatabaseClient(client, () => hasPortraitPackPurchase(ownerId));
		expect(await unlocked()).toBe(false);
		await client.paymentEvent.create({
			data: {
				provider: plan.provider,
				providerEventId: randomUUID(),
				verifiedAt: new Date(),
				status: "PROCESSED",
				envelope: { type: "invoice.paid", livemode: true, data: { object: { id: invoice } } },
			},
		});
		expect(await unlocked()).toBe(true);
		await client.billingPeriod.update({
			where: { id: period.id },
			data: { status: "REFUNDED", refundedAmount: 100n },
		});
		expect(await unlocked()).toBe(false);
	});
});
