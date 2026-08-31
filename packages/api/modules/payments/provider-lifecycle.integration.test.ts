import { PrismaPg } from "@prisma/adapter-pg";
import {
	bindPaymentCheckoutIntentSession,
	createPaymentCheckoutIntent,
	markPaymentCheckoutIntentProviderCreating,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { processProviderPaymentEvent } from "@repo/payments";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const ownerId = `provider-lifecycle-owner-${RUN_ID}`;
const planId = `provider-lifecycle-plan-${RUN_ID}`;
const providerSubscriptionId = `order-${RUN_ID}`;

describe("provider-neutral payment lifecycle", () => {
	let client: PrismaClient;
	let checkoutIntentId: string;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.user.create({
			data: {
				id: ownerId,
				name: "Provider Lifecycle Owner",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				createdAt: new Date("2026-08-01T00:00:00Z"),
				updatedAt: new Date("2026-08-01T00:00:00Z"),
			},
		});
		await client.billingPlan.create({
			data: {
				id: planId,
				provider: "waffo",
				providerPriceId: "PROD_0123456789AbCdEfGhIjKl",
				name: "creator",
				creditsPerPeriod: 1_000n,
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
				billingPlanId: planId,
				planKey: "creator",
				interval: "month",
				idempotencyKey: `checkout-${RUN_ID}`,
				now: new Date("2026-08-01T00:00:00Z"),
			},
			client,
		);
		checkoutIntentId = checkout.intent.id;
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: checkoutIntentId, provider: "waffo" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: checkoutIntentId,
				provider: "waffo",
				providerSessionId: providerSubscriptionId,
				providerCheckoutUrl: `https://pancake.waffo.ai/checkout/${RUN_ID}`,
				expiresAt: new Date("2026-08-01T01:00:00.000Z"),
			},
			client,
		);
	});

	afterAll(async () => {
		if (!client) return;
		await client.$transaction(async (tx) => {
			const paymentEvents = await tx.paymentEvent.findMany({
				where: { providerEventId: { contains: RUN_ID } },
				select: { id: true },
			});
			const paymentEventIds = paymentEvents.map(({ id }) => id);
			await tx.auditLog.deleteMany({
				where: { targetType: "PAYMENT_EVENT", targetId: { in: paymentEventIds } },
			});
			await tx.paymentEvent.deleteMany({ where: { id: { in: paymentEventIds } } });
			const subscription = await tx.subscription.findFirst({ where: { ownerId } });
			const creditAccount = await tx.creditAccount.findFirst({
				where: { ownerId },
				select: { id: true },
			});
			if (creditAccount) {
				await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" DISABLE TRIGGER "credit_ledger_entry_immutable"`;
				try {
					await tx.creditLedgerEntry.deleteMany({
						where: { accountId: creditAccount.id },
					});
				} finally {
					await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" ENABLE TRIGGER "credit_ledger_entry_immutable"`;
				}
				await tx.creditLot.deleteMany({ where: { accountId: creditAccount.id } });
			}
			if (subscription) {
				await tx.billingPeriod.deleteMany({ where: { subscriptionId: subscription.id } });
				await tx.subscription.delete({ where: { id: subscription.id } });
			}
			await tx.creditAccount.deleteMany({ where: { ownerId } });
			await tx.purchase.deleteMany({ where: { userId: ownerId } });
			await tx.paymentCustomer.deleteMany({ where: { ownerId } });
			await tx.paymentCheckoutIntent.deleteMany({ where: { ownerId } });
			await tx.billingPlan.deleteMany({ where: { id: planId } });
			await tx.user.deleteMany({ where: { id: ownerId } });
		});
		await client.$disconnect();
	});

	it("separates official Waffo activation from payment credit and rejects another order", async () => {
		const activationEventId = `activation-${RUN_ID}`;
		const activation = await client.paymentEvent.create({
			data: {
				provider: "waffo",
				providerEventId: activationEventId,
				verifiedAt: new Date("2026-08-01T00:00:00Z"),
				envelope: {
					id: activationEventId,
					eventType: "subscription.activated",
					timestamp: "2026-08-01T00:00:00.000Z",
					data: {
						orderId: providerSubscriptionId,
						orderMerchantExternalId: checkoutIntentId,
						merchantProvidedBuyerIdentity: `USER:${ownerId}`,
						amount: "19.000000",
						currency: "USD",
						currentPeriodStart: "2026-08-01T00:00:00.000Z",
						currentPeriodEnd: "2026-09-01T00:00:00.000Z",
					},
				},
			},
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: activation.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(
			client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
		).resolves.toBeNull();

		const paymentEventId = `payment-success-${RUN_ID}`;
		const payment = await client.paymentEvent.create({
			data: {
				provider: "waffo",
				providerEventId: paymentEventId,
				verifiedAt: new Date("2026-08-01T00:01:00Z"),
				envelope: {
					id: paymentEventId,
					eventType: "subscription.payment_succeeded",
					timestamp: "2026-08-01T00:01:00.000Z",
					data: {
						orderId: providerSubscriptionId,
						orderMerchantExternalId: checkoutIntentId,
						merchantProvidedBuyerIdentity: `USER:${ownerId}`,
						paymentId: `payment-${RUN_ID}`,
						amount: "19.000000",
						currency: "USD",
						currentPeriodStart: "2026-08-01T00:00:00.000Z",
						currentPeriodEnd: "2026-09-01T00:00:00.000Z",
					},
				},
			},
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: payment.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
		await expect(
			processProviderPaymentEvent({ paymentEventId: payment.id }, client),
		).resolves.toEqual({ outcome: "SKIPPED", grantsCreated: 0 });

		const maliciousEventId = `second-order-${RUN_ID}`;
		const malicious = await client.paymentEvent.create({
			data: {
				provider: "waffo",
				providerEventId: maliciousEventId,
				verifiedAt: new Date("2026-08-01T00:02:00Z"),
				envelope: {
					id: maliciousEventId,
					eventType: "subscription.activated",
					timestamp: "2026-08-01T00:02:00.000Z",
					data: {
						orderId: `different-order-${RUN_ID}`,
						orderMerchantExternalId: checkoutIntentId,
						merchantProvidedBuyerIdentity: `USER:${ownerId}`,
						amount: "19.000000",
						currency: "USD",
						currentPeriodStart: "2026-08-01T00:00:00.000Z",
						currentPeriodEnd: "2026-09-01T00:00:00.000Z",
					},
				},
			},
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: malicious.id }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.subscription.findUnique({
				where: {
					provider_providerSubscriptionId: {
						provider: "waffo",
						providerSubscriptionId: `different-order-${RUN_ID}`,
					},
				},
			}),
		).resolves.toBeNull();

		await expect(
			client.paymentCheckoutIntent.findUnique({ where: { id: checkoutIntentId } }),
		).resolves.toMatchObject({ status: "COMPLETED", activeScopeKey: null });
		await expect(
			client.paymentEvent.findUnique({ where: { id: payment.id } }),
		).resolves.toMatchObject({
			status: "PROCESSED",
		});
		await expect(
			client.subscription.findUnique({
				where: {
					provider_providerSubscriptionId: {
						provider: "waffo",
						providerSubscriptionId,
					},
				},
			}),
		).resolves.toMatchObject({ status: "ACTIVE", provider: "waffo", ownerId });
		await expect(
			client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_000n });
		await expect(client.purchase.findFirst({ where: { userId: ownerId } })).resolves.toMatchObject({
			provider: "waffo",
			subscriptionId: providerSubscriptionId,
		});
	});

	it("dead-letters refund ambiguity for manual review without granting credits", async () => {
		const providerEventId = `refund-${RUN_ID}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "waffo",
				providerEventId,
				verifiedAt: new Date("2026-08-02T00:00:00Z"),
				envelope: {
					id: providerEventId,
					eventType: "refund.completed",
					timestamp: "2026-08-02T00:00:00.000Z",
					data: { orderId: `order-${RUN_ID}` },
				},
			},
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: event.id }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUnique({ where: { id: event.id } }),
		).resolves.toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "PAYMENT_PROVIDER_REFUND_REVIEW_REQUIRED",
			lastErrorClass: "TERMINAL",
		});
		await expect(
			client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_000n });
	});
});

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	if (DATABASE_URL && DATABASE_URL === TEST_DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	if (
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		!/(?:test|testing)/i.test(parsed.pathname)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
