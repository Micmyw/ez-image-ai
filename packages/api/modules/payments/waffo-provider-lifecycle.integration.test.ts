import { PrismaPg } from "@prisma/adapter-pg";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	markPaymentCheckoutIntentProviderCreating,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { processProviderPaymentEvent } from "@repo/payments";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Waffo separate payment and subscription notifications", () => {
	let client: PrismaClient;
	const runId = crypto.randomUUID();
	const ownerId = `waffo-current-contract-${runId}`;
	const orderId = `ORD_${runId}`;
	let intentId: string;

	beforeAll(async () => {
		const connectionString = process.env.TEST_DATABASE_URL;
		if (!connectionString || connectionString === process.env.DATABASE_URL) {
			throw new Error("A separate TEST_DATABASE_URL is required");
		}
		const url = new URL(connectionString);
		if (
			url.hostname !== "127.0.0.1" ||
			url.port !== "55432" ||
			!/^\/(?:ai_media_foundation_test|ezpic_[a-z0-9_]+_test)$/.test(url.pathname)
		) {
			throw new Error("A disposable loopback payment test database on port 55432 is required");
		}
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
		await client.user.create({
			data: {
				id: ownerId,
				name: "Waffo Contract Test",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "waffo",
				providerPriceId: `PROD_${runId}`,
				name: "creator",
				creditsPerPeriod: 700n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const checkout = await createPaymentCheckoutIntent(
			{
				provider: "waffo",
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				billingPlanId: plan.id,
				planKey: "creator",
				interval: "month",
				idempotencyKey: runId,
			},
			client,
		);
		intentId = checkout.intent.id;
		await markPaymentCheckoutIntentProviderCreating({ intentId, provider: "waffo" }, client);
		await bindPaymentCheckoutIntentSession(
			{
				intentId,
				provider: "waffo",
				providerSessionId: `session-${runId}`,
				providerCheckoutUrl: `https://pancake.waffo.ai/checkout/${runId}`,
			},
			client,
		);
	});

	// All fixtures belong to the explicitly disposable database required above.
	afterAll(async () => client?.$disconnect());

	async function event(
		eventType: string,
		eventId: string,
		timestamp: string,
		data: Record<string, string>,
	) {
		return client.paymentEvent.create({
			data: {
				provider: "waffo",
				providerEventId: `${eventType}:${eventId}`,
				providerSubscriptionId: orderId,
				verifiedAt: new Date(timestamp),
				envelope: {
					id: eventId,
					eventId,
					eventType,
					timestamp,
					mode: "test",
					data: {
						orderId,
						orderMerchantExternalId: intentId,
						merchantProvidedBuyerIdentity: `USER:${ownerId}`,
						amount: "19.00",
						currency: "USD",
						...data,
					},
				},
			},
		});
	}

	it("waits for signed lifecycle dates, retries receipts, and never undoes cancellation or double-grants", async () => {
		const firstPaymentId = `PAY_first-${runId}`;
		const first = await event(
			"subscription.payment_succeeded",
			firstPaymentId,
			"2026-09-11T00:00:01Z",
			{ paymentId: firstPaymentId, paymentStatus: "succeeded" },
		);
		await expect(processProviderPaymentEvent({ paymentEventId: first.id }, client)).rejects.toThrow(
			"PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING",
		);
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: first.id } }),
		).resolves.toMatchObject({ failureReason: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING" });
		await expect(
			client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
		).resolves.toBeNull();

		const activation = await event("subscription.activated", orderId, "2026-09-11T00:00:02Z", {
			currentPeriodStart: "2026-09-11T00:00:00Z",
			currentPeriodEnd: "2026-10-11T00:00:00Z",
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: activation.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: first.id } }),
		).resolves.toMatchObject({ status: "FAILED", attemptCount: 0 });
		await expect(
			client.outboxEvent.findUnique({
				where: { dedupeKey: `payment-event-correlation-replay:${first.id}` },
			}),
		).resolves.toMatchObject({ status: "PENDING", payload: { paymentEventId: first.id } });
		await expect(
			processProviderPaymentEvent({ paymentEventId: first.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
		await expect(
			processProviderPaymentEvent({ paymentEventId: first.id }, client),
		).resolves.toEqual({ outcome: "SKIPPED", grantsCreated: 0 });

		const renewalPaymentId = `PAY_renewal-${runId}`;
		const renewalPayment = await event(
			"subscription.payment_succeeded",
			renewalPaymentId,
			"2026-10-11T00:00:01Z",
			{ paymentId: renewalPaymentId, paymentStatus: "succeeded" },
		);
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewalPayment.id }, client),
		).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: renewalPayment.id } }),
		).resolves.toMatchObject({ failureReason: "PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING" });
		const renewal = await event(
			"subscription.renewed",
			`${orderId}-renewed-2026-11-11`,
			"2026-10-11T00:00:02Z",
			{ currentPeriodStart: "2026-10-11T00:00:00Z", currentPeriodEnd: "2026-11-11T00:00:00Z" },
		);
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewal.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });

		const canceling = await event(
			"subscription.canceling",
			`${orderId}-2026-10-11T00:00:03Z`,
			"2026-10-11T00:00:03Z",
			{ currentPeriodStart: "2026-10-11T00:00:00Z", currentPeriodEnd: "2026-11-11T00:00:00Z" },
		);
		await expect(
			processProviderPaymentEvent({ paymentEventId: canceling.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewalPayment.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
		await expect(
			client.subscription.findUniqueOrThrow({
				where: {
					provider_providerSubscriptionId: { provider: "waffo", providerSubscriptionId: orderId },
				},
			}),
		).resolves.toMatchObject({
			status: "ACTIVE",
			cancelAtPeriodEnd: true,
			currentPeriodEnd: new Date("2026-11-11T00:00:00Z"),
		});

		const canceled = await event("subscription.canceled", orderId, "2026-11-11T00:00:00Z", {
			currentPeriodStart: "2026-10-11T00:00:00Z",
			currentPeriodEnd: "2026-11-11T00:00:00Z",
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: canceled.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		const replay = await event(
			"subscription.payment_succeeded",
			`${renewalPaymentId}-redelivery`,
			"2026-11-11T00:00:01Z",
			{ paymentId: renewalPaymentId, paymentStatus: "succeeded" },
		);
		await expect(
			processProviderPaymentEvent({ paymentEventId: replay.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.subscription.findUniqueOrThrow({
				where: {
					provider_providerSubscriptionId: { provider: "waffo", providerSubscriptionId: orderId },
				},
			}),
		).resolves.toMatchObject({ status: "CANCELED", cancelAtPeriodEnd: true });
		await expect(
			client.creditLedgerEntry.count({ where: { account: { ownerId }, type: "GRANT" } }),
		).resolves.toBe(2);
		await expect(
			client.billingPeriod.count({ where: { subscription: { ownerId } } }),
		).resolves.toBe(2);

		const wrongAmount = await event(
			"subscription.payment_succeeded",
			`${firstPaymentId}-wrong-amount`,
			"2026-09-11T00:00:01Z",
			{ paymentId: firstPaymentId, paymentStatus: "succeeded", amount: "0.01" },
		);
		await expect(
			processProviderPaymentEvent({ paymentEventId: wrongAmount.id }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: wrongAmount.id } }),
		).resolves.toMatchObject({ failureReason: "PAYMENT_PROVIDER_AMOUNT_MISMATCH" });
		await expect(
			client.creditLedgerEntry.count({ where: { account: { ownerId }, type: "GRANT" } }),
		).resolves.toBe(2);
	});
});
