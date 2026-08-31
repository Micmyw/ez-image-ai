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
const ownerId = `paypal-lifecycle-owner-${RUN_ID}`;
const planId = `paypal-lifecycle-plan-${RUN_ID}`;
const providerSubscriptionId = `I-${RUN_ID}`;
const firstPaymentId = `SALE-FIRST-${RUN_ID}`;
const annualOwnerId = `paypal-annual-owner-${RUN_ID}`;
const annualPlanId = `paypal-annual-plan-${RUN_ID}`;
const annualSubscriptionId = `I-ANNUAL-${RUN_ID}`;

describe("PayPal subscription payment recovery", () => {
	let client: PrismaClient;
	let checkoutIntentId: string;

	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		await client.user.create({
			data: {
				id: ownerId,
				name: "PayPal Lifecycle Owner",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		});
		await client.billingPlan.create({
			data: {
				id: planId,
				provider: "paypal",
				providerPriceId: `P-${RUN_ID}`.toUpperCase(),
				name: "creator",
				creditsPerPeriod: 1_000n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const checkout = await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				billingPlanId: planId,
				planKey: "creator",
				interval: "month",
				idempotencyKey: `paypal-checkout-${RUN_ID}`,
				now: new Date("2026-01-30T00:00:00Z"),
			},
			client,
		);
		checkoutIntentId = checkout.intent.id;
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: checkoutIntentId, provider: "paypal" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: checkoutIntentId,
				provider: "paypal",
				providerSessionId: providerSubscriptionId,
				providerCheckoutUrl: `https://www.sandbox.paypal.com/checkout/${RUN_ID}`,
				expiresAt: null,
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
			const ownerIds = [ownerId, annualOwnerId];
			const subscriptions = await tx.subscription.findMany({
				where: { ownerId: { in: ownerIds } },
				select: { id: true },
			});
			const accounts = await tx.creditAccount.findMany({
				where: { ownerId: { in: ownerIds } },
				select: { id: true },
			});
			if (accounts.length > 0) {
				await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" DISABLE TRIGGER "credit_ledger_entry_immutable"`;
				try {
					await tx.creditLedgerEntry.deleteMany({
						where: { accountId: { in: accounts.map(({ id }) => id) } },
					});
				} finally {
					await tx.$executeRaw`ALTER TABLE "credit_ledger_entry" ENABLE TRIGGER "credit_ledger_entry_immutable"`;
				}
				await tx.creditLot.deleteMany({
					where: { accountId: { in: accounts.map(({ id }) => id) } },
				});
			}
			if (subscriptions.length > 0) {
				await tx.billingPeriod.deleteMany({
					where: { subscriptionId: { in: subscriptions.map(({ id }) => id) } },
				});
				await tx.subscription.deleteMany({
					where: { id: { in: subscriptions.map(({ id }) => id) } },
				});
			}
			await tx.creditAccount.deleteMany({ where: { ownerId: { in: ownerIds } } });
			await tx.purchase.deleteMany({ where: { userId: { in: ownerIds } } });
			await tx.paymentCustomer.deleteMany({ where: { ownerId: { in: ownerIds } } });
			await tx.paymentCheckoutIntent.deleteMany({ where: { ownerId: { in: ownerIds } } });
			await tx.billingPlan.deleteMany({ where: { id: { in: [planId, annualPlanId] } } });
			await tx.user.deleteMany({ where: { id: { in: ownerIds } } });
		});
		await client.$disconnect();
	});

	it("recovers a sale-first delivery and grants each PayPal payment exactly once", async () => {
		const firstSale = await createSaleEvent(client, {
			eventId: `PAYPAL-SALE-FIRST-${RUN_ID}`,
			paymentId: firstPaymentId,
			occurredAt: "2026-01-31T00:00:00.000Z",
		});

		await expect(
			processProviderPaymentEvent({ paymentEventId: firstSale.id }, client, {
				attempt: 1,
				maxAttempts: 3,
			}),
		).rejects.toThrow("PAYMENT_PROVIDER_CHECKOUT_CORRELATION_MISSING");
		await expect(
			client.paymentEvent.findUnique({ where: { id: firstSale.id } }),
		).resolves.toMatchObject({
			status: "FAILED",
			lastErrorClass: "TRANSIENT",
			failureReason: "PAYMENT_EVENT_RETRYABLE_FAILURE",
		});
		await expect(client.creditAccount.findFirst({ where: { ownerId } })).resolves.toBeNull();

		const activationEventId = `PAYPAL-ACTIVATION-${RUN_ID}`;
		const activation = await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: activationEventId,
				verifiedAt: new Date("2026-01-31T00:01:00.000Z"),
				envelope: {
					id: activationEventId,
					event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
					create_time: "2026-01-31T00:01:00.000Z",
					resource: {
						id: providerSubscriptionId,
						custom_id: checkoutIntentId,
						subscriber: { payer_id: `PAYER-${RUN_ID}` },
						billing_info: {
							last_payment: {
								time: "2026-01-31T00:00:00.000Z",
								amount: { value: "19.00", currency_code: "USD" },
							},
							next_billing_time: "2026-02-28T00:00:00.000Z",
						},
					},
				},
			},
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: activation.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });
		await expect(client.creditAccount.findFirst({ where: { ownerId } })).resolves.toBeNull();

		await expect(
			processProviderPaymentEvent({ paymentEventId: firstSale.id }, client, {
				attempt: 2,
				maxAttempts: 3,
			}),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });

		const duplicateSale = await createSaleEvent(client, {
			eventId: `PAYPAL-SALE-DUPLICATE-DELIVERY-${RUN_ID}`,
			paymentId: firstPaymentId,
			occurredAt: "2026-01-31T00:00:30.000Z",
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: duplicateSale.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });

		const renewalPaymentId = `SALE-RENEWAL-${RUN_ID}`;
		const renewal = await createSaleEvent(client, {
			eventId: `PAYPAL-SALE-RENEWAL-${RUN_ID}`,
			paymentId: renewalPaymentId,
			occurredAt: "2026-02-28T00:00:00.000Z",
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewal.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewal.id }, client),
		).resolves.toEqual({ outcome: "SKIPPED", grantsCreated: 0 });

		const subscription = await client.subscription.findUniqueOrThrow({
			where: {
				provider_providerSubscriptionId: {
					provider: "paypal",
					providerSubscriptionId,
				},
			},
			include: { periods: { orderBy: { startsAt: "asc" } } },
		});
		expect(subscription.periods).toMatchObject([
			{
				startsAt: new Date("2026-01-31T00:00:00.000Z"),
				endsAt: new Date("2026-02-28T00:00:00.000Z"),
				providerInvoicePaymentId: `paypal:${firstPaymentId}`,
			},
			{
				startsAt: new Date("2026-02-28T00:00:00.000Z"),
				endsAt: new Date("2026-03-31T00:00:00.000Z"),
				providerInvoicePaymentId: `paypal:${renewalPaymentId}`,
			},
		]);
		await expect(
			client.creditAccount.findUnique({
				where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
			}),
		).resolves.toMatchObject({ spendableCredits: 1_000n });
		await expect(
			client.creditLedgerEntry.count({
				where: { account: { ownerType: "USER", ownerId }, type: "GRANT" },
			}),
		).resolves.toBe(2);
	});

	it("derives leap-year annual renewals from persisted PayPal subscription timing", async () => {
		await client.user.create({
			data: {
				id: annualOwnerId,
				name: "PayPal Annual Owner",
				email: `${annualOwnerId}@example.test`,
				emailVerified: true,
				createdAt: new Date("2028-02-01T00:00:00.000Z"),
				updatedAt: new Date("2028-02-01T00:00:00.000Z"),
			},
		});
		await client.billingPlan.create({
			data: {
				id: annualPlanId,
				provider: "paypal",
				providerPriceId: `P-ANNUAL-${RUN_ID}`.toUpperCase(),
				name: "creator",
				creditsPerPeriod: 1_000n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "year", version: 1 },
			},
		});
		const checkout = await createPaymentCheckoutIntent(
			{
				provider: "paypal",
				ownerType: "USER",
				ownerId: annualOwnerId,
				submittedByUserId: annualOwnerId,
				billingPlanId: annualPlanId,
				planKey: "creator",
				interval: "year",
				idempotencyKey: `paypal-annual-checkout-${RUN_ID}`,
				now: new Date("2028-02-28T00:00:00.000Z"),
			},
			client,
		);
		await markPaymentCheckoutIntentProviderCreating(
			{ intentId: checkout.intent.id, provider: "paypal" },
			client,
		);
		await bindPaymentCheckoutIntentSession(
			{
				intentId: checkout.intent.id,
				provider: "paypal",
				providerSessionId: annualSubscriptionId,
				providerCheckoutUrl: `https://www.sandbox.paypal.com/checkout/annual-${RUN_ID}`,
				expiresAt: null,
			},
			client,
		);

		const activationEventId = `PAYPAL-ANNUAL-ACTIVATION-${RUN_ID}`;
		const activation = await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: activationEventId,
				verifiedAt: new Date("2028-02-29T00:01:00.000Z"),
				envelope: {
					id: activationEventId,
					event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
					create_time: "2028-02-29T00:01:00.000Z",
					resource: {
						id: annualSubscriptionId,
						custom_id: checkout.intent.id,
						subscriber: { payer_id: `PAYER-ANNUAL-${RUN_ID}` },
						billing_info: {
							last_payment: {
								time: "2028-02-29T00:00:00.000Z",
								amount: { value: "19.00", currency_code: "USD" },
							},
							next_billing_time: "2029-02-28T00:00:00.000Z",
						},
					},
				},
			},
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: activation.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 0 });

		const firstAnnualPaymentId = `SALE-ANNUAL-FIRST-${RUN_ID}`;
		const firstSale = await createSaleEvent(client, {
			eventId: `PAYPAL-ANNUAL-SALE-FIRST-${RUN_ID}`,
			paymentId: firstAnnualPaymentId,
			occurredAt: "2028-02-29T00:00:00.000Z",
			providerSubscriptionId: annualSubscriptionId,
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: firstSale.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });

		const renewalAnnualPaymentId = `SALE-ANNUAL-RENEWAL-${RUN_ID}`;
		const renewal = await createSaleEvent(client, {
			eventId: `PAYPAL-ANNUAL-SALE-RENEWAL-${RUN_ID}`,
			paymentId: renewalAnnualPaymentId,
			occurredAt: "2029-02-28T00:00:00.000Z",
			providerSubscriptionId: annualSubscriptionId,
		});
		await expect(
			processProviderPaymentEvent({ paymentEventId: renewal.id }, client),
		).resolves.toEqual({ outcome: "PROCESSED", grantsCreated: 1 });

		const firstPeriods = await client.billingPeriod.findMany({
			where: { providerInvoicePaymentId: `paypal:${firstAnnualPaymentId}` },
			orderBy: { startsAt: "asc" },
		});
		const renewalPeriods = await client.billingPeriod.findMany({
			where: { providerInvoicePaymentId: `paypal:${renewalAnnualPaymentId}` },
			orderBy: { startsAt: "asc" },
		});
		expect(firstPeriods).toHaveLength(12);
		expect(firstPeriods[0]).toMatchObject({
			startsAt: new Date("2028-02-29T00:00:00.000Z"),
		});
		expect(firstPeriods[firstPeriods.length - 1]).toMatchObject({
			endsAt: new Date("2029-02-28T00:00:00.000Z"),
		});
		expect(renewalPeriods).toHaveLength(12);
		expect(renewalPeriods[0]).toMatchObject({
			startsAt: new Date("2029-02-28T00:00:00.000Z"),
		});
		expect(renewalPeriods[renewalPeriods.length - 1]).toMatchObject({
			endsAt: new Date("2030-02-28T00:00:00.000Z"),
		});
		await expect(
			client.creditLedgerEntry.count({
				where: { account: { ownerType: "USER", ownerId: annualOwnerId }, type: "GRANT" },
			}),
		).resolves.toBe(2);
	});
});

async function createSaleEvent(
	client: PrismaClient,
	input: {
		eventId: string;
		paymentId: string;
		occurredAt: string;
		providerSubscriptionId?: string;
	},
) {
	return client.paymentEvent.create({
		data: {
			provider: "paypal",
			providerEventId: input.eventId,
			verifiedAt: new Date(input.occurredAt),
			envelope: {
				id: input.eventId,
				event_type: "PAYMENT.SALE.COMPLETED",
				create_time: input.occurredAt,
				resource: {
					id: input.paymentId,
					billing_agreement_id: input.providerSubscriptionId ?? providerSubscriptionId,
					amount: { total: "19.00", currency: "USD" },
				},
			},
		},
	});
}

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
