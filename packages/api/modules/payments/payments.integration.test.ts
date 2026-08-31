import { createHash, createHmac } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import {
	applyApprovedLegacyStripeRefundRepair,
	approveLegacyStripeRefundRepair,
	createCreditGrant,
	createGenerationJobTransaction,
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
	getAdminMediaDiagnostics,
	getCreditInvariantReport,
	ingestPaymentEvent,
	recoverExpiredPaymentEvents,
	refundCreditGrant,
	releaseCredits,
	settleCredits,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { reconcileSubscriptionsWithClient } from "@repo/jobs";
import {
	applyStripeBillingFact,
	createStripeWebhookHandler,
	getStripeClient,
	grantDueBillingPeriods,
	processClaimedStripePaymentEvent,
	processStripePaymentEvent,
	type StripeSubscriptionFact,
} from "@repo/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_MODERATION_RULE_VERSION = "TEST_STRIPE_REFUND_RESERVATION_V1";

interface PaymentEventRetryMetadata {
	status: string;
	failureReason: string | null;
	attemptCount: number;
	lastTriggerRunId: string | null;
	lastErrorClass: string | null;
	lastTriggerAttempt?: number | null;
	lastAttemptAt?: Date | null;
}

function assertSafeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (parsed.hostname !== "127.0.0.1" || parsed.port !== "55432" || !safeDatabase) {
		throw new Error(
			"TEST_DATABASE_URL must target 127.0.0.1:55432/ai_media_foundation_test or a dedicated ezpic_*_test database",
		);
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

	beforeEach(async () => {
		const recoveryEventIds = await client.paymentEvent.findMany({
			where: { providerEventId: { startsWith: "evt_lease_recovery_" } },
			select: { id: true },
		});
		if (recoveryEventIds.length === 0) return;
		const ids = recoveryEventIds.map((event) => event.id);
		await client.$transaction([
			client.outboxEvent.deleteMany({
				where: {
					aggregateId: { in: ids },
					dedupeKey: { startsWith: "payment-event-recovery:" },
				},
			}),
			client.auditLog.deleteMany({
				where: {
					action: "PAYMENT_EVENT_LEASE_RECOVERED",
					targetType: "PAYMENT_EVENT",
					targetId: { in: ids },
				},
			}),
			client.paymentEvent.deleteMany({ where: { id: { in: ids } } }),
		]);
	});

	it("rejects new purchases with zero or multiple owners", async () => {
		const suffix = crypto.randomUUID();
		const user = await client.user.create({
			data: {
				id: `purchase-owner-user-${suffix}`,
				name: "Purchase owner fixture",
				email: `purchase-owner-${suffix}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const organization = await client.organization.create({
			data: {
				name: "Purchase owner fixture",
				slug: `purchase-owner-${suffix}`,
				createdAt: new Date(),
			},
		});
		const common = {
			type: "SUBSCRIPTION" as const,
			customerId: `cus_owner_${suffix}`,
			priceId: `price_owner_${suffix}`,
		};

		await expect(client.purchase.create({ data: common })).rejects.toThrow();
		await expect(
			client.purchase.create({
				data: {
					...common,
					customerId: `cus_multiple_${suffix}`,
					organizationId: organization.id,
					userId: user.id,
				},
			}),
		).rejects.toThrow();
	});

	it("rejects subscription metadata that attempts to transfer an existing Purchase owner", async () => {
		const suffix = crypto.randomUUID();
		const user = await client.user.create({
			data: {
				id: `purchase-fixed-user-${suffix}`,
				name: "Fixed purchase owner",
				email: `purchase-fixed-${suffix}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const organization = await client.organization.create({
			data: {
				name: "Attacker organization fixture",
				slug: `purchase-transfer-${suffix}`,
				createdAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_owner_fixed_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const providerSubscriptionId = `sub_owner_fixed_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: user.id,
				type: "SUBSCRIPTION",
				customerId: `cus_owner_fixed_${suffix}`,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "incomplete",
			},
		});
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_owner_transfer_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_owner_transfer_${suffix}`,
					type: "customer.subscription.created",
					created: 1_800_000_000,
					data: {
						object: {
							id: providerSubscriptionId,
							customer: purchase.customerId,
							status: "active",
							current_period_start: 1_800_000_000,
							current_period_end: 1_802_678_400,
							items: { data: [{ price: { id: plan.providerPriceId } }] },
							metadata: {
								billing_plan_id: plan.id,
								plan_key: "creator",
								owner_type: "ORGANIZATION",
								owner_id: organization.id,
								submitted_by_user_id: user.id,
							},
						},
					},
				},
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			failureReason: "STRIPE_PURCHASE_BINDING_INVALID",
		});
		expect(await client.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).toMatchObject({
			userId: user.id,
			organizationId: null,
		});
		expect(await client.subscription.count({ where: { providerSubscriptionId } })).toBe(0);
	});

	it("rejects customer drift on an existing Stripe subscription before mutating entitlement", async () => {
		const suffix = crypto.randomUUID();
		const customerId = `cus_bound_${suffix}`;
		const user = await client.user.create({
			data: {
				id: `stripe-owner-${suffix}`,
				name: "Stripe owner fixture",
				email: `stripe-owner-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_bound_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const providerSubscriptionId = `sub_bound_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: user.id,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: user.id,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
			},
		});
		const fact: StripeSubscriptionFact = {
			kind: "SUBSCRIPTION",
			providerSubscriptionId,
			customerId: `cus_attacker_${suffix}`,
			status: "PAST_DUE",
			cancelAtPeriodEnd: false,
			currentPeriodStart: new Date("2027-01-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2027-02-01T00:00:00.000Z"),
			priceId: plan.providerPriceId,
			binding: null,
			context: {
				origin: "RECONCILIATION",
				changeAt: new Date("2027-01-02T00:00:00.000Z"),
				changeId: `stripe-reconcile:${suffix}:customer-drift`,
			},
		};

		await expect(client.$transaction((tx) => applyStripeBillingFact(fact, tx))).rejects.toThrow(
			"STRIPE_SUBSCRIPTION_CUSTOMER_CONFLICT",
		);
		await expect(
			client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).resolves.toMatchObject({ status: "ACTIVE", lastProviderEventId: null });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ status: "active", customerId });
	});

	it("does not overwrite an owner's existing Stripe customer mapping during first binding", async () => {
		const suffix = crypto.randomUUID();
		const originalCustomerId = `cus_original_${suffix}`;
		const user = await client.user.create({
			data: {
				id: `stripe-customer-owner-${suffix}`,
				name: "Stripe customer owner",
				email: `stripe-customer-owner-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: originalCustomerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_customer_owner_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const fact: StripeSubscriptionFact = {
			kind: "SUBSCRIPTION",
			providerSubscriptionId: `sub_customer_owner_${suffix}`,
			customerId: `cus_conflict_${suffix}`,
			status: "ACTIVE",
			cancelAtPeriodEnd: false,
			currentPeriodStart: new Date("2027-01-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2027-02-01T00:00:00.000Z"),
			priceId: plan.providerPriceId,
			binding: {
				billingPlanId: plan.id,
				planKey: "creator",
				ownerType: "USER",
				ownerId: user.id,
				submittedByUserId: user.id,
			},
			context: {
				origin: "RECONCILIATION",
				changeAt: new Date("2027-01-01T00:00:00.000Z"),
				changeId: `stripe-reconcile:${suffix}:customer-owner`,
			},
		};

		await expect(client.$transaction((tx) => applyStripeBillingFact(fact, tx))).rejects.toThrow(
			"STRIPE_CUSTOMER_OWNER_CONFLICT",
		);
		expect(
			await client.subscription.count({
				where: { providerSubscriptionId: fact.providerSubscriptionId },
			}),
		).toBe(0);
		await expect(client.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
			paymentsCustomerId: originalCustomerId,
		});
	});

	it("rejects an unmapped Stripe price on an existing subscription", async () => {
		const suffix = crypto.randomUUID();
		const customerId = `cus_unmapped_${suffix}`;
		const user = await client.user.create({
			data: {
				id: `stripe-unmapped-owner-${suffix}`,
				name: "Stripe unmapped owner",
				email: `stripe-unmapped-owner-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_mapped_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const providerSubscriptionId = `sub_unmapped_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: user.id,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: user.id,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
			},
		});
		const fact: StripeSubscriptionFact = {
			kind: "SUBSCRIPTION",
			providerSubscriptionId,
			customerId,
			status: "ACTIVE",
			cancelAtPeriodEnd: false,
			currentPeriodStart: new Date("2027-01-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2027-02-01T00:00:00.000Z"),
			priceId: `price_unknown_${suffix}`,
			binding: null,
			context: {
				origin: "RECONCILIATION",
				changeAt: new Date("2027-01-03T00:00:00.000Z"),
				changeId: `stripe-reconcile:${suffix}:unmapped-price`,
			},
		};

		await expect(client.$transaction((tx) => applyStripeBillingFact(fact, tx))).rejects.toThrow(
			"STRIPE_SUBSCRIPTION_PLAN_UNMAPPED",
		);
	});

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
			await client.subscription.findUniqueOrThrow({
				where: {
					provider_providerSubscriptionId: {
						provider: "stripe",
						providerSubscriptionId,
					},
				},
			}),
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
		const suffix = crypto.randomUUID();
		const ownerId = `stripe-monthly-${suffix}`;
		const customerId = `cus_monthly_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Monthly purchase fixture",
				email: `stripe-monthly-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_${crypto.randomUUID()}`,
							amount_paid: 1_900,
							billing_reason: "subscription_cycle",
							period_start: 1_754_006_400,
							period_end: 1_756_684_800,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_754_006_400,
										periodEnd: 1_756_684_800,
									}),
								],
							},
						},
					},
				},
			},
		});

		expect(
			await processStripePaymentEvent(
				{ paymentEventId: event.id, now: new Date(1_754_006_500_000) },
				client,
			),
		).toMatchObject({
			outcome: "PROCESSED",
			grantsCreated: 1,
		});
		expect(
			await processStripePaymentEvent(
				{ paymentEventId: event.id, now: new Date(1_754_006_500_000) },
				client,
			),
		).toMatchObject({
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
		const customerId = `cus_chain_${suffix}`;
		const providerSubscriptionId = `sub_chain_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Signed webhook owner",
				email: `stripe-chain-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
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
					customer: customerId,
					subscription: subscription.providerSubscriptionId,
					charge: chargeId,
					amount_paid: 1_900,
					billing_reason: "subscription_cycle",
					period_start: 1_800_000_000,
					period_end: 1_802_678_400,
					lines: {
						data: [
							legacySubscriptionInvoiceLine({
								subscriptionId: subscription.providerSubscriptionId,
								priceId: plan.providerPriceId,
								periodStart: 1_800_000_000,
								periodEnd: 1_802_678_400,
							}),
						],
					},
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
			await processStripePaymentEvent(
				{ paymentEventId: paymentEvent.id, now: new Date(1_800_000_100_000) },
				client,
			),
		).toMatchObject({ outcome: "PROCESSED", grantsCreated: 1 });
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { providerInvoiceId: invoiceId } }),
		).toMatchObject({ providerChargeId: chargeId, creditAmount: 321n });
	});

	it("retains multiple receipts and finalizes a shared-charge refund only after success", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `stripe-shared-charge-${suffix}`;
		const customerId = `cus_shared_charge_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Shared charge owner",
				email: `shared-charge-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const providerSubscriptionId = `sub_shared_charge_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 1_000,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_000,
							period_end: 1_802_678_400,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_800_000_000,
										periodEnd: 1_802_678_400,
									}),
								],
							},
						},
					},
				},
			},
			client,
		);
		const refund = await ingestPaymentEvent(
			{
				provider: "stripe",
				providerEventId: `evt_z_refund_pending_${suffix}`,
				normalizedTransactionId: `refund:${refundId}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_z_refund_pending_${suffix}`,
					type: "refund.created",
					created: 1_800_000_001,
					data: {
						object: {
							id: refundId,
							charge: chargeId,
							amount: 500,
							currency: "usd",
							created: 1_800_000_001,
							status: "pending",
						},
					},
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
			await processStripePaymentEvent(
				{ paymentEventId: invoice.event.id, now: new Date(1_800_000_100_000) },
				client,
			),
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
		).toMatchObject({ refundedAmount: 0n, refundedCredits: 0n });

		const succeeded = await ingestPaymentEvent(
			{
				provider: "stripe",
				providerEventId: `evt_a_refund_succeeded_${suffix}`,
				normalizedTransactionId: `refund:${refundId}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_a_refund_succeeded_${suffix}`,
					type: "refund.updated",
					created: 1_800_000_001,
					data: {
						object: {
							id: refundId,
							charge: chargeId,
							amount: 500,
							currency: "usd",
							created: 1_800_000_001,
							status: "succeeded",
						},
					},
				},
			},
			client,
		);
		expect(succeeded.replayed).toBe(false);
		expect(
			await processStripePaymentEvent({ paymentEventId: succeeded.event.id }, client),
		).toMatchObject({ outcome: "PROCESSED" });
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { providerChargeId: chargeId } }),
		).toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
		const lifecycle = await client.stripeRefund.findUniqueOrThrow({
			where: { provider_providerRefundId: { provider: "stripe", providerRefundId: refundId } },
		});
		expect(lifecycle).toMatchObject({ status: "SUCCEEDED", finalizedCredits: 50n });
		expect(await client.stripeRefundReceipt.count({ where: { refundId: lifecycle.id } })).toBe(2);

		for (const [index, terminalStatus] of ["failed", "canceled"].entries()) {
			const terminalRefundId = `re_shared_${terminalStatus}_${suffix}`;
			for (const [offset, status] of ["pending", terminalStatus].entries()) {
				const eventId = `evt_shared_${terminalStatus}_${status}_${suffix}`;
				const receipt = await ingestPaymentEvent(
					{
						provider: "stripe",
						providerEventId: eventId,
						normalizedTransactionId: `refund:${terminalRefundId}`,
						verifiedAt: new Date(),
						envelope: {
							id: eventId,
							type: offset === 0 ? "refund.created" : "refund.updated",
							created: 1_800_000_010 + index * 2 + offset,
							data: {
								object: {
									id: terminalRefundId,
									charge: chargeId,
									amount: 100,
									currency: "usd",
									created: 1_800_000_010 + index * 2,
									status,
								},
							},
						},
					},
					client,
				);
				await expect(
					processStripePaymentEvent({ paymentEventId: receipt.event.id }, client),
				).resolves.toMatchObject({ outcome: "PROCESSED" });
			}
			const terminalLifecycle = await client.stripeRefund.findUniqueOrThrow({
				where: {
					provider_providerRefundId: {
						provider: "stripe",
						providerRefundId: terminalRefundId,
					},
				},
			});
			expect(terminalLifecycle).toMatchObject({
				status: terminalStatus.toUpperCase(),
				creditsFinalizedAt: null,
				finalizedCredits: 0n,
			});
			expect(
				await client.stripeRefundReceipt.count({ where: { refundId: terminalLifecycle.id } }),
			).toBe(2);
		}
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { providerChargeId: chargeId } }),
		).toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("freezes a legacy early refund when its pending lifecycle later succeeds", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "PENDING" });
		const event = await createSucceededRefundEvent(client, {
			providerRefundId: fixture.legacyRefundId,
			providerChargeId: fixture.chargeId,
			amount: 500,
		});

		await expect(processStripePaymentEvent({ paymentEventId: event.id }, client)).resolves.toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({ failureReason: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED" });
		await expect(
			client.stripeRefund.findUniqueOrThrow({
				where: {
					provider_providerRefundId: {
						provider: "stripe",
						providerRefundId: fixture.legacyRefundId,
					},
				},
			}),
		).resolves.toMatchObject({
			status: "PENDING",
			finalizedCredits: 0n,
			creditsFinalizedAt: null,
		});
		expect(
			await client.creditLedgerEntry.count({
				where: { type: "REFUND", referenceKey: { startsWith: "stripe-refund:" } },
			}),
		).toBeGreaterThanOrEqual(1);
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("dead-letters a failed refund event when a legacy refund already revoked credits", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const event = await createRefundEvent(client, {
			providerRefundId: fixture.legacyRefundId,
			providerChargeId: fixture.chargeId,
			amount: 500,
			status: "failed",
		});

		await expect(processStripePaymentEvent({ paymentEventId: event.id }, client)).resolves.toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({ failureReason: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED" });
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("dead-letters a failed refund event when only the legacy period projection is polluted", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, {
			lifecycleStatus: "FAILED",
			recordRefundLedger: false,
		});
		const event = await createRefundEvent(client, {
			providerRefundId: fixture.legacyRefundId,
			providerChargeId: fixture.chargeId,
			amount: 500,
			status: "failed",
		});

		await expect(processStripePaymentEvent({ paymentEventId: event.id }, client)).resolves.toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({ failureReason: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED" });
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: { startsWith: `stripe-refund:${fixture.legacyRefundId}:` } },
			}),
		).toBe(0);
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("blocks a later legitimate refund from under-revoking credits polluted by a legacy refund", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client);
		const providerRefundId = `re_current_succeeded_${crypto.randomUUID()}`;
		const event = await createSucceededRefundEvent(client, {
			providerRefundId,
			providerChargeId: fixture.chargeId,
			amount: 500,
		});

		await expect(processStripePaymentEvent({ paymentEventId: event.id }, client)).resolves.toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } }),
		).resolves.toMatchObject({ failureReason: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED" });
		expect(
			await client.stripeRefund.count({
				where: { provider: "stripe", providerRefundId },
			}),
		).toBe(0);
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("allows a later legitimate refund only after exact failed-refund compensation is receipted", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const diagnosticsBefore = await getAdminMediaDiagnostics(client);
		expect(
			diagnosticsBefore.stripeReconciliation.historicalRefunds.items.some(
				(item) => item.providerRefundId === fixture.legacyRefundId,
			),
		).toBe(true);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve the exact failed refund and immutable legacy revocation evidence.",
			},
			client,
		);
		const diagnosticsApproved = await getAdminMediaDiagnostics(client);
		expect(
			diagnosticsApproved.stripeReconciliation.historicalRefunds.items.some(
				(item) => item.providerRefundId === fixture.legacyRefundId,
			),
		).toBe(true);
		await applyApprovedLegacyStripeRefundRepair(
			{
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-01-20T00:00:00.000Z"),
				reason: "Apply the independently approved compensation before processing later refunds.",
			},
			client,
		);
		const diagnosticsAfter = await getAdminMediaDiagnostics(client);
		expect(
			diagnosticsAfter.stripeReconciliation.historicalRefunds.items.some(
				(item) => item.providerRefundId === fixture.legacyRefundId,
			),
		).toBe(false);

		const providerRefundId = `re_after_repair_${crypto.randomUUID()}`;
		const event = await createSucceededRefundEvent(client, {
			providerRefundId,
			providerChargeId: fixture.chargeId,
			amount: 500,
		});
		await expect(processStripePaymentEvent({ paymentEventId: event.id }, client)).resolves.toEqual({
			outcome: "PROCESSED",
			grantsCreated: 0,
		});
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.accountId } }),
		).resolves.toMatchObject({ creditDebt: 0n, spendableCredits: 50n });
		await expect(
			client.stripeRefund.findUniqueOrThrow({
				where: {
					provider_providerRefundId: { provider: "stripe", providerRefundId },
				},
			}),
		).resolves.toMatchObject({ finalizedCredits: 50n, status: "SUCCEEDED" });
		await expect(getCreditInvariantReport(fixture.accountId, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("rejects non-terminal and stale legacy refund repair approvals", async () => {
		for (const lifecycleStatus of ["PENDING", "REQUIRES_ACTION"] as const) {
			const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus });
			const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);

			await expect(
				approveLegacyStripeRefundRepair(
					{
						action: "COMPENSATE_FAILED_OR_CANCELED",
						actorUserId: `approver-${crypto.randomUUID()}`,
						approvalKey: `approval-${crypto.randomUUID()}`,
						expectedCredits: 50n,
						expectedLastProviderChangeId: fixture.lastProviderChangeId,
						issueKey: issue.issueKey,
						providerRefundId: fixture.legacyRefundId,
						reason: "Verified lifecycle is not yet terminal and cannot authorize compensation.",
					},
					client,
				),
			).rejects.toThrow("STRIPE_REFUND_REPAIR_STATUS_NOT_TERMINAL");
		}

		const failed = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const failedIssue = await createLegacyRefundRepairIssue(client, failed.legacyRefundId);
		await expect(
			approveLegacyStripeRefundRepair(
				{
					action: "COMPENSATE_FAILED_OR_CANCELED",
					actorUserId: `approver-${crypto.randomUUID()}`,
					approvalKey: `approval-${crypto.randomUUID()}`,
					expectedCredits: 50n,
					expectedLastProviderChangeId: "evt_stale_refund_snapshot",
					issueKey: failedIssue.issueKey,
					providerRefundId: failed.legacyRefundId,
					reason: "This deliberately stale lifecycle snapshot must never authorize a repair.",
				},
				client,
			),
		).rejects.toThrow("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
		expect(
			await client.stripeRefundRepairAuthority.count({
				where: { refund: { providerRefundId: failed.legacyRefundId } },
			}),
		).toBe(0);
	});

	it("binds an approval replay to the originally approved reconciliation issue", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalInput = {
			action: "COMPENSATE_FAILED_OR_CANCELED" as const,
			actorUserId: `approver-${crypto.randomUUID()}`,
			approvalKey: `approval-${crypto.randomUUID()}`,
			expectedCredits: 50n,
			expectedLastProviderChangeId: fixture.lastProviderChangeId,
			issueKey: issue.issueKey,
			providerRefundId: fixture.legacyRefundId,
			reason: "Bind this approval to the exact reconciliation issue reviewed by the approver.",
		};
		await approveLegacyStripeRefundRepair(approvalInput, client);

		await expect(
			approveLegacyStripeRefundRepair(
				{
					...approvalInput,
					issueKey: `${issue.issueKey}:different`,
				},
				client,
			),
		).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(
			await client.stripeRefundRepairAuthority.count({
				where: { refund: { providerRefundId: fixture.legacyRefundId } },
			}),
		).toBe(1);
	});

	it("invalidates approval replays when the frozen lifecycle status or time changes", async () => {
		for (const drift of ["STATUS", "TIME"] as const) {
			const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
			const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
			const approvalInput = {
				action: "COMPENSATE_FAILED_OR_CANCELED" as const,
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey: `approval-${crypto.randomUUID()}`,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Freeze the exact lifecycle status and timestamp reviewed for this approval.",
			};
			await approveLegacyStripeRefundRepair(approvalInput, client);
			await client.stripeRefund.update({
				where: { id: fixture.refundLifecycleId! },
				data:
					drift === "STATUS"
						? { status: "CANCELED" }
						: { lastProviderChangeAt: new Date("2027-01-16T00:00:00.000Z") },
			});

			await expect(approveLegacyStripeRefundRepair(approvalInput, client)).rejects.toThrow(
				"STRIPE_REFUND_REPAIR_APPROVAL_STALE",
			);
		}
	});

	it("rejects repair approval when legacy refund ledger periods belong to another charge", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		await client.billingPeriod.update({
			where: { id: fixture.periodId },
			data: { providerChargeId: `ch_unrelated_${crypto.randomUUID()}` },
		});

		await expect(
			approveLegacyStripeRefundRepair(
				{
					action: "COMPENSATE_FAILED_OR_CANCELED",
					actorUserId: `approver-${crypto.randomUUID()}`,
					approvalKey: `approval-${crypto.randomUUID()}`,
					expectedCredits: 50n,
					expectedLastProviderChangeId: fixture.lastProviderChangeId,
					issueKey: issue.issueKey,
					providerRefundId: fixture.legacyRefundId,
					reason: "Reject compensation unless every legacy period remains bound to this charge.",
				},
				client,
			),
		).rejects.toThrow("STRIPE_REFUND_REPAIR_CHARGE_BINDING_INVALID");
	});

	it("rejects an approved repair when the Stripe lifecycle changes before execution", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve only the exact terminal Stripe lifecycle snapshot reviewed by this actor.",
			},
			client,
		);
		await client.stripeRefund.update({
			where: { id: fixture.refundLifecycleId! },
			data: {
				lastProviderChangeAt: new Date("2027-01-16T00:00:00.000Z"),
				lastProviderChangeId: `evt_changed_${crypto.randomUUID()}`,
			},
		});

		await expect(
			applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId: `executor-${crypto.randomUUID()}`,
					approvalKey,
					idempotencyKey: `apply-${crypto.randomUUID()}`,
					now: new Date("2027-01-20T00:00:00.000Z"),
					reason: "A changed lifecycle must invalidate this previously approved repair.",
				},
				client,
			),
		).rejects.toThrow("STRIPE_REFUND_REPAIR_APPROVAL_STALE");
		expect(
			await client.stripeRefundRepairReceipt.count({ where: { authority: { approvalKey } } }),
		).toBe(0);
		await expect(
			client.stripeReconciliationIssue.findUniqueOrThrow({ where: { id: issue.id } }),
		).resolves.toMatchObject({ status: "OPEN" });
	});

	it("allows a fresh approval after an unapplied repair authority has a stale charge snapshot", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const staleApprovalKey = `approval-stale-${crypto.randomUUID()}`;
		const staleApproval = await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `stale-approver-${crypto.randomUUID()}`,
				approvalKey: staleApprovalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve the original charge snapshot before its billing period closes.",
			},
			client,
		);
		await client.billingPeriod.update({
			where: { id: fixture.periodId },
			data: { status: "CLOSED" },
		});
		await expect(
			applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId: `stale-executor-${crypto.randomUUID()}`,
					approvalKey: staleApprovalKey,
					idempotencyKey: `apply-stale-${crypto.randomUUID()}`,
					now: new Date("2027-02-02T00:00:00.000Z"),
					reason: "Reject execution because the approved billing-period snapshot has changed.",
				},
				client,
			),
		).rejects.toThrow("STRIPE_REFUND_REPAIR_LEDGER_SNAPSHOT_STALE");

		const freshApprovalKey = `approval-fresh-${crypto.randomUUID()}`;
		const freshApproval = await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `fresh-approver-${crypto.randomUUID()}`,
				approvalKey: freshApprovalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason:
					"Approve the newly verified charge snapshot after the prior authority became stale.",
			},
			client,
		);
		expect(freshApproval.authorityId).not.toBe(staleApproval.authorityId);

		await expect(
			applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId: `fresh-executor-${crypto.randomUUID()}`,
					approvalKey: freshApprovalKey,
					idempotencyKey: `apply-fresh-${crypto.randomUUID()}`,
					now: new Date("2027-02-02T00:00:00.000Z"),
					reason: "Execute the fresh approval against its newly frozen charge snapshot.",
				},
				client,
			),
		).resolves.toMatchObject({
			authorityId: freshApproval.authorityId,
			compensatedCredits: 50n,
		});
	});

	it("requires different actors to approve and execute a repair", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const actorUserId = `repair-actor-${crypto.randomUUID()}`;
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Record the first actor so execution can enforce independent review.",
			},
			client,
		);

		await expect(
			applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId,
					approvalKey,
					idempotencyKey: `apply-${crypto.randomUUID()}`,
					now: new Date("2027-01-20T00:00:00.000Z"),
					reason: "The approving actor must not be able to execute the same repair.",
				},
				client,
			),
		).rejects.toThrow("STRIPE_REFUND_REPAIR_SECOND_APPROVER_REQUIRED");
		expect(
			await client.stripeRefundRepairReceipt.count({ where: { authority: { approvalKey } } }),
		).toBe(0);
	});

	it("binds repair execution idempotency to the approval, actor, and reason", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve immutable evidence before testing the execution command identity.",
			},
			client,
		);
		const applyInput = {
			actorUserId: `executor-${crypto.randomUUID()}`,
			approvalKey,
			idempotencyKey: `apply-${crypto.randomUUID()}`,
			now: new Date("2027-01-20T00:00:00.000Z"),
			reason: "Bind this execution key to the exact actor, approval, and operator reason.",
		};
		await applyApprovedLegacyStripeRefundRepair(applyInput, client);

		for (const conflictingInput of [
			{ ...applyInput, actorUserId: `other-executor-${crypto.randomUUID()}` },
			{
				...applyInput,
				reason: "A different reason must not replay the original execution command.",
			},
			{ ...applyInput, idempotencyKey: `different-apply-${crypto.randomUUID()}` },
		]) {
			await expect(applyApprovedLegacyStripeRefundRepair(conflictingInput, client)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
		}
		expect(
			await client.stripeRefundRepairReceipt.count({ where: { authority: { approvalKey } } }),
		).toBe(1);
	});

	it("keeps repair authorities and receipts immutable in PostgreSQL", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		const approval = await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Persist immutable approval evidence before a separate actor executes it.",
			},
			client,
		);
		await expect(
			client.stripeRefundRepairAuthority.update({
				where: { id: approval.authorityId },
				data: { reason: "Attempt to mutate immutable authority evidence after approval." },
			}),
		).rejects.toThrow("stripe refund repair authority is immutable");
		await expect(
			client.stripeRefundRepairAuthority.delete({ where: { id: approval.authorityId } }),
		).rejects.toThrow("stripe refund repair authority is immutable");

		const applied = await applyApprovedLegacyStripeRefundRepair(
			{
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-01-20T00:00:00.000Z"),
				reason: "Apply the immutable approval and persist an immutable execution receipt.",
			},
			client,
		);
		await expect(
			client.stripeRefundRepairReceipt.update({
				where: { id: applied.receiptId },
				data: { appliedByUserId: `mutated-${crypto.randomUUID()}` },
			}),
		).rejects.toThrow("stripe refund repair receipt is immutable");
		await expect(
			client.stripeRefundRepairReceipt.delete({ where: { id: applied.receiptId } }),
		).rejects.toThrow("stripe refund repair receipt is immutable");
	});

	it("rolls back compensation, period state, issue resolution, and receipt on a late failure", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve a fixture used to prove every repair mutation is transactionally atomic.",
			},
			client,
		);
		const appliedAuditCount = await client.auditLog.count({
			where: { action: "STRIPE_REFUND_REPAIR_APPLIED" },
		});
		await client.$executeRawUnsafe(
			`CREATE FUNCTION test_reject_stripe_refund_repair_receipt_insert()
			RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
			  RAISE EXCEPTION 'forced receipt failure' USING ERRCODE = '55000';
			END;
			$$`,
		);
		await client.$executeRawUnsafe(
			`CREATE TRIGGER test_reject_stripe_refund_repair_receipt_insert
			BEFORE INSERT ON "stripe_refund_repair_receipt"
			FOR EACH ROW EXECUTE FUNCTION test_reject_stripe_refund_repair_receipt_insert()`,
		);
		try {
			await expect(
				applyApprovedLegacyStripeRefundRepair(
					{
						actorUserId: `executor-${crypto.randomUUID()}`,
						approvalKey,
						idempotencyKey: `apply-${crypto.randomUUID()}`,
						now: new Date("2027-01-20T00:00:00.000Z"),
						reason: "Force a late receipt failure after compensation work has been attempted.",
					},
					client,
				),
			).rejects.toThrow("forced receipt failure");
		} finally {
			await client.$executeRawUnsafe(
				`DROP TRIGGER test_reject_stripe_refund_repair_receipt_insert
				ON "stripe_refund_repair_receipt"`,
			);
			await client.$executeRawUnsafe(
				"DROP FUNCTION test_reject_stripe_refund_repair_receipt_insert()",
			);
		}

		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: { startsWith: `stripe-refund-repair:${fixture.legacyRefundId}:` } },
			}),
		).toBe(0);
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
		await expect(
			client.stripeReconciliationIssue.findUniqueOrThrow({ where: { id: issue.id } }),
		).resolves.toMatchObject({ resolvedAt: null, status: "OPEN" });
		expect(
			await client.stripeRefundRepairReceipt.count({ where: { authority: { approvalKey } } }),
		).toBe(0);
		expect(await client.auditLog.count({ where: { action: "STRIPE_REFUND_REPAIR_APPLIED" } })).toBe(
			appliedAuditCount,
		);
		await expect(getCreditInvariantReport(fixture.accountId, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("compensates failed and canceled legacy refunds once through grant and debt repayment", async () => {
		for (const [lifecycleStatus, spentBeforeRefund] of [
			["FAILED", false],
			["CANCELED", true],
		] as const) {
			const fixture = await createLegacyEarlyRefundFixture(client, {
				lifecycleStatus,
				spentBeforeRefund,
			});
			const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
			const approvalKey = `approval-${crypto.randomUUID()}`;
			const approvalInput = {
				action: "COMPENSATE_FAILED_OR_CANCELED" as const,
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason:
					"Stripe terminal failure proves the legacy early credit revocation must be compensated.",
			};
			await expect(approveLegacyStripeRefundRepair(approvalInput, client)).resolves.toMatchObject({
				replayed: false,
			});
			await expect(approveLegacyStripeRefundRepair(approvalInput, client)).resolves.toMatchObject({
				replayed: true,
			});

			const applyInput = {
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-01-20T00:00:00.000Z"),
				reason: "Apply the independently approved immutable forward compensation.",
			};
			await expect(
				applyApprovedLegacyStripeRefundRepair(applyInput, client),
			).resolves.toMatchObject({ compensatedCredits: 50n, replayed: false });
			await expect(
				applyApprovedLegacyStripeRefundRepair(applyInput, client),
			).resolves.toMatchObject({ compensatedCredits: 50n, replayed: true });

			await expect(
				client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
			).resolves.toMatchObject({ refundedAmount: 0n, refundedCredits: 0n });
			await expect(
				client.creditAccount.findUniqueOrThrow({ where: { id: fixture.accountId } }),
			).resolves.toMatchObject({
				creditDebt: 0n,
				spendableCredits: spentBeforeRefund ? 0n : 100n,
			});
			const compensationEntries = await client.creditLedgerEntry.findMany({
				where: { referenceKey: { startsWith: `stripe-refund-repair:${fixture.legacyRefundId}:` } },
			});
			expect(compensationEntries.filter((entry) => entry.type === "GRANT")).toHaveLength(1);
			expect(compensationEntries.filter((entry) => entry.type === "DEBT_REPAYMENT")).toHaveLength(
				spentBeforeRefund ? 1 : 0,
			);
			await expect(
				client.stripeReconciliationIssue.findUniqueOrThrow({ where: { id: issue.id } }),
			).resolves.toMatchObject({ status: "RESOLVED" });
			await expect(getCreditInvariantReport(fixture.accountId, client)).resolves.toMatchObject({
				valid: true,
			});
		}
	});

	it("restores future ungranted annual periods polluted by a failed legacy refund", async () => {
		const fixture = await createLegacyAnnualProjectionRefundFixture(client);
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 100n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve the full annual projection polluted by the failed legacy refund.",
			},
			client,
		);

		await expect(
			applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId: `executor-${crypto.randomUUID()}`,
					approvalKey,
					idempotencyKey: `apply-${crypto.randomUUID()}`,
					now: new Date("2027-01-20T00:00:00.000Z"),
					reason: "Restore both granted and future annual period projections atomically.",
				},
				client,
			),
		).resolves.toMatchObject({ compensatedCredits: 100n, replayed: false });

		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: fixture.subscriptionId },
			orderBy: [{ startsAt: "asc" }, { id: "asc" }],
		});
		expect(periods).toHaveLength(2);
		expect(periods[0]).toMatchObject({
			status: "ACTIVE",
			refundedAmount: 0n,
			refundedCredits: 0n,
		});
		expect(periods[1]).toMatchObject({
			status: "PENDING",
			refundedAmount: 0n,
			refundedCredits: 0n,
		});
		await expect(
			client.creditLedgerEntry.findUnique({
				where: { referenceKey: fixture.futureGrantReferenceKey },
			}),
		).resolves.toBeNull();
		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.accountId } }),
		).resolves.toMatchObject({ creditDebt: 0n, spendableCredits: 100n });
		await expect(getCreditInvariantReport(fixture.accountId, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("records the full annual projection when confirming a succeeded legacy refund", async () => {
		const fixture = await createLegacyAnnualProjectionRefundFixture(client, "SUCCEEDED");
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "CONFIRM_SUCCEEDED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 100n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Confirm the succeeded refund against its complete annual period projection.",
			},
			client,
		);
		await applyApprovedLegacyStripeRefundRepair(
			{
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-01-20T00:00:00.000Z"),
				reason: "Finalize the full projected annual credit reversal without another mutation.",
			},
			client,
		);

		await expect(
			client.stripeRefund.findUniqueOrThrow({
				where: {
					provider_providerRefundId: {
						provider: "stripe",
						providerRefundId: fixture.legacyRefundId,
					},
				},
			}),
		).resolves.toMatchObject({ finalizedCredits: 200n });
		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: fixture.subscriptionId },
			orderBy: [{ startsAt: "asc" }, { id: "asc" }],
		});
		expect(periods.map((period) => period.refundedCredits)).toEqual([100n, 100n]);
	});

	it("expires restored credits atomically when the repaired billing period has ended", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "FAILED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "COMPENSATE_FAILED_OR_CANCELED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason: "Approve compensation whose original billing credits have already expired.",
			},
			client,
		);

		await applyApprovedLegacyStripeRefundRepair(
			{
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-02-15T00:00:00.000Z"),
				reason: "Restore the failed refund without making already expired value spendable.",
			},
			client,
		);

		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.accountId } }),
		).resolves.toMatchObject({ creditDebt: 0n, spendableCredits: 0n });
		expect(
			await client.creditLot.aggregate({
				where: { accountId: fixture.accountId },
				_sum: { remainingAmount: true },
			}),
		).toMatchObject({ _sum: { remainingAmount: 0n } });
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
		).resolves.toMatchObject({ refundedAmount: 0n, refundedCredits: 0n, status: "CLOSED" });
		await expect(getCreditInvariantReport(fixture.accountId, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("requires active legacy-refund reservations to settle or release before compensation", async () => {
		for (const outcome of ["SETTLE", "RELEASE"] as const) {
			const fixture = await createStripeReservedRefundFixture(client);
			await client.stripeRefund.update({
				where: { id: fixture.refundLifecycleId },
				data: {
					status: "FAILED",
					finalizedCredits: 0n,
					creditsFinalizedAt: null,
					lastProviderChangeId: `evt_failed_${crypto.randomUUID()}`,
				},
			});
			const lifecycle = await client.stripeRefund.findUniqueOrThrow({
				where: { id: fixture.refundLifecycleId },
			});
			const issue = await createLegacyRefundRepairIssue(client, lifecycle.providerRefundId);
			const approvalInput = {
				action: "COMPENSATE_FAILED_OR_CANCELED" as const,
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey: `approval-${crypto.randomUUID()}`,
				expectedCredits: 100n,
				expectedLastProviderChangeId: lifecycle.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: lifecycle.providerRefundId,
				reason: "Terminal failure requires repair after the active reservation reaches an outcome.",
			};
			await expect(approveLegacyStripeRefundRepair(approvalInput, client)).rejects.toThrow(
				"STRIPE_REFUND_REPAIR_RESERVATION_ACTIVE",
			);

			if (outcome === "SETTLE") {
				await settleCredits(
					{
						reservationId: fixture.reservation.id,
						amount: 100n,
						referenceKey: `legacy-refund-repair-settle:${crypto.randomUUID()}`,
					},
					client,
				);
			} else {
				await releaseCredits(
					{
						reservationId: fixture.reservation.id,
						referenceKey: `legacy-refund-repair-release:${crypto.randomUUID()}`,
					},
					client,
				);
			}

			await approveLegacyStripeRefundRepair(approvalInput, client);
			await applyApprovedLegacyStripeRefundRepair(
				{
					actorUserId: `executor-${crypto.randomUUID()}`,
					approvalKey: approvalInput.approvalKey,
					idempotencyKey: `apply-${crypto.randomUUID()}`,
					now: new Date("2027-01-20T00:00:00.000Z"),
					reason: "Apply compensation after the reservation outcome is durably recorded.",
				},
				client,
			);
			await expect(
				client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
			).resolves.toMatchObject({
				creditDebt: 0n,
				spendableCredits: outcome === "RELEASE" ? 100n : 0n,
			});
			await expect(
				client.billingPeriod.findUniqueOrThrow({ where: { id: fixture.periodId } }),
			).resolves.toMatchObject({ refundedAmount: 0n, refundedCredits: 0n });
			await expect(getCreditInvariantReport(fixture.account.id, client)).resolves.toMatchObject({
				valid: true,
			});
		}
	});

	it("confirms a succeeded legacy refund and resolves only its authorized issue", async () => {
		const fixture = await createLegacyEarlyRefundFixture(client, { lifecycleStatus: "SUCCEEDED" });
		const issue = await createLegacyRefundRepairIssue(client, fixture.legacyRefundId);
		const unrelatedSameObject = await client.stripeReconciliationIssue.create({
			data: {
				issueKey: `stripe:REFUND:${fixture.legacyRefundId}:STRIPE_REFUND_BINDING_AMBIGUOUS`,
				provider: "stripe",
				sweepId: `sweep-${crypto.randomUUID()}`,
				stage: "REFUNDS",
				code: "STRIPE_REFUND_BINDING_AMBIGUOUS",
				entityType: "REFUND",
				providerObjectId: fixture.legacyRefundId,
				details: {},
			},
		});
		const approvalKey = `approval-${crypto.randomUUID()}`;
		await approveLegacyStripeRefundRepair(
			{
				action: "CONFIRM_SUCCEEDED",
				actorUserId: `approver-${crypto.randomUUID()}`,
				approvalKey,
				expectedCredits: 50n,
				expectedLastProviderChangeId: fixture.lastProviderChangeId,
				issueKey: issue.issueKey,
				providerRefundId: fixture.legacyRefundId,
				reason:
					"Stripe success and immutable ledger evidence match the approved legacy revocation.",
			},
			client,
		);
		const ledgerCount = await client.creditLedgerEntry.count({
			where: { referenceKey: { startsWith: `stripe-refund:${fixture.legacyRefundId}:` } },
		});
		await applyApprovedLegacyStripeRefundRepair(
			{
				actorUserId: `executor-${crypto.randomUUID()}`,
				approvalKey,
				idempotencyKey: `apply-${crypto.randomUUID()}`,
				now: new Date("2027-01-20T00:00:00.000Z"),
				reason: "Record the independently approved succeeded-refund finalization evidence.",
			},
			client,
		);

		await expect(
			client.stripeRefund.findUniqueOrThrow({ where: { id: fixture.refundLifecycleId! } }),
		).resolves.toMatchObject({ creditsFinalizedAt: expect.any(Date), finalizedCredits: 50n });
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: { startsWith: `stripe-refund:${fixture.legacyRefundId}:` } },
			}),
		).toBe(ledgerCount);
		await expect(
			client.stripeReconciliationIssue.findUniqueOrThrow({ where: { id: issue.id } }),
		).resolves.toMatchObject({ status: "RESOLVED" });
		await expect(
			client.stripeReconciliationIssue.findUniqueOrThrow({ where: { id: unrelatedSameObject.id } }),
		).resolves.toMatchObject({ status: "OPEN" });
		const finalizedDiagnostics = await getAdminMediaDiagnostics(client);
		expect(
			finalizedDiagnostics.stripeReconciliation.historicalRefunds.items.some(
				(item) => item.providerRefundId === fixture.legacyRefundId,
			),
		).toBe(false);
		await client.stripeRefund.update({
			where: { id: fixture.refundLifecycleId! },
			data: { finalizedCredits: 49n },
		});
		const mismatchedDiagnostics = await getAdminMediaDiagnostics(client);
		expect(mismatchedDiagnostics.stripeReconciliation.historicalRefunds.items).toContainEqual(
			expect.objectContaining({
				providerRefundId: fixture.legacyRefundId,
				reason: "CREDIT_TOTAL_MISMATCH",
			}),
		);
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
				providerInvoicePaymentId: `inpay_${crypto.randomUUID()}`,
				providerChargeId: `ch_${crypto.randomUUID()}`,
				paidAmount: 1_000n,
			},
		});
		const refundSuffix = crypto.randomUUID();

		for (const [index, amount] of [400, 600].entries()) {
			const event = await client.paymentEvent.create({
				data: {
					provider: "stripe",
					providerEventId: `evt_refund_${crypto.randomUUID()}`,
					verifiedAt: new Date(),
					envelope: {
						id: `evt_refund_payload_${index}`,
						type: "refund.created",
						created: 1_754_006_500 + index,
						data: {
							object: {
								id: `re_${refundSuffix}_${index}`,
								charge: period.providerChargeId,
								amount,
								currency: "usd",
								created: 1_754_006_500 + index,
								status: "succeeded",
							},
						},
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

		const overflowRefundId = `re_${refundSuffix}_overflow`;
		const overflow = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_refund_overflow_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_refund_overflow_payload_${crypto.randomUUID()}`,
					type: "refund.updated",
					created: 1_754_006_503,
					data: {
						object: {
							id: overflowRefundId,
							charge: period.providerChargeId,
							amount: 1,
							currency: "usd",
							created: 1_754_006_503,
							status: "succeeded",
						},
					},
				},
			},
		});
		await expect(
			processStripePaymentEvent({ paymentEventId: overflow.id }, client),
		).resolves.toEqual({ outcome: "DEAD_LETTER", grantsCreated: 0 });
		await expect(
			client.paymentEvent.findUniqueOrThrow({ where: { id: overflow.id } }),
		).resolves.toMatchObject({ failureReason: "STRIPE_REFUND_AMOUNT_EXCEEDS_INVOICE" });
		expect(
			await client.stripeRefund.count({
				where: { provider: "stripe", providerRefundId: overflowRefundId },
			}),
		).toBe(0);
		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: account.id } }),
		).resolves.toMatchObject({ creditDebt: 100n });
	});

	it("turns a Stripe refund against an active reservation into debt when that reservation settles", async () => {
		const fixture = await createStripeReservedRefundFixture(client);

		await settleCredits(
			{
				reservationId: fixture.reservation.id,
				amount: 100n,
				referenceKey: `stripe-refund-settle:${crypto.randomUUID()}`,
			},
			client,
		);

		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).resolves.toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 100n });
		await expect(getCreditInvariantReport(fixture.account.id, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("does not restore refunded credits when an active reservation is released", async () => {
		const fixture = await createStripeReservedRefundFixture(client);

		await releaseCredits(
			{
				reservationId: fixture.reservation.id,
				referenceKey: `stripe-refund-release:${crypto.randomUUID()}`,
			},
			client,
		);

		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: fixture.account.id } }),
		).resolves.toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 0n });
		await expect(getCreditInvariantReport(fixture.account.id, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("schedules annual credits monthly and grants only a due paid period", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `stripe-annual-${suffix}`;
		const customerId = `cus_annual_${suffix}`;
		const providerSubscriptionId = `sub_annual_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Annual subscription owner",
				email: `stripe-annual-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_annual_${crypto.randomUUID()}`,
							amount_paid: 79_000,
							billing_reason: "subscription_cycle",
							period_start: 1_833_000_600,
							period_end: 1_864_623_000,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_833_000_600,
										periodEnd: 1_864_623_000,
									}),
								],
							},
						},
					},
				},
			},
		});
		await processStripePaymentEvent(
			{ paymentEventId: event.id, now: new Date(1_833_000_700_000) },
			client,
		);
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

	it("grants a due period after more than one batch of expired pending periods", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2040-06-15T00:00:00.000Z");
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_expired_backlog_${suffix}`,
				name: "backlog fixture",
				creditsPerPeriod: 50n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: { planId: "backlog-fixture", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `expired-backlog-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `sub_expired_backlog_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		await client.billingPeriod.createMany({
			data: Array.from({ length: 101 }, (_, index) => {
				const startsAt = new Date(Date.UTC(2030, 0, index + 1));
				return {
					subscriptionId: subscription.id,
					startsAt,
					endsAt: new Date(startsAt.getTime() + 24 * 60 * 60 * 1_000),
					status: "PENDING" as const,
					creditAmount: 50n,
					grantReferenceKey: `expired-backlog:${suffix}:${index}`,
				};
			}),
		});
		const duePeriod = await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date(now.getTime() - 60_000),
				endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
				status: "PENDING",
				creditAmount: 50n,
				grantReferenceKey: `due-after-expired-backlog:${suffix}`,
			},
		});

		await grantDueBillingPeriods({ now }, client);

		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: duePeriod.id } }),
		).resolves.toMatchObject({
			status: "ACTIVE",
		});
		expect(
			await client.creditLedgerEntry.findUnique({
				where: { referenceKey: duePeriod.grantReferenceKey! },
			}),
		).not.toBeNull();
	});

	it("voids all future annual periods after a full refund", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `annual-refund-${suffix}`;
		const customerId = `cus_annual_refund_${suffix}`;
		const providerSubscriptionId = `sub_annual_refund_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Annual refund owner",
				email: `annual-refund-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 12_000,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_000,
							period_end: 1_831_536_000,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_800_000_000,
										periodEnd: 1_831_536_000,
									}),
								],
							},
						},
					},
				},
			},
		});
		await processStripePaymentEvent(
			{ paymentEventId: paid.id, now: new Date(1_800_000_050_000) },
			client,
		);
		const refund = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_refund_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_refund_annual",
					type: "refund.created",
					created: 1_800_000_100,
					data: {
						object: {
							id: `re_${crypto.randomUUID()}`,
							charge: chargeId,
							amount: 12_000,
							currency: "usd",
							created: 1_800_000_100,
							status: "succeeded",
						},
					},
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
		const grantReferenceKeys = periods.flatMap((period) =>
			period.grantReferenceKey ? [period.grantReferenceKey] : [],
		);
		const grantsBefore = await client.creditLedgerEntry.count({
			where: { referenceKey: { in: grantReferenceKeys } },
		});
		await grantDueBillingPeriods({ now: new Date("2030-01-01T00:00:00.000Z") }, client);
		expect(
			(
				await client.billingPeriod.findMany({
					where: { id: { in: periods.map((period) => period.id) } },
				})
			).every((period) => period.status === "REFUNDED"),
		).toBe(true);
		expect(
			await client.creditLedgerEntry.count({ where: { referenceKey: { in: grantReferenceKeys } } }),
		).toBe(grantsBefore);
	});

	it("rounds multiple partial annual refunds from the cumulative invoice total", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `annual-partial-refund-${suffix}`;
		const customerId = `cus_annual_partial_${suffix}`;
		const providerSubscriptionId = `sub_annual_partial_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Partial annual refund owner",
				email: `annual-partial-refund-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: chargeId,
							amount_paid: 1_000,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_000,
							period_end: 1_831_536_000,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_800_000_000,
										periodEnd: 1_831_536_000,
									}),
								],
							},
						},
					},
				},
			},
		});
		await processStripePaymentEvent(
			{ paymentEventId: paid.id, now: new Date(1_800_000_050_000) },
			client,
		);

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
								currency: "usd",
								created: 1_800_000_100 + index,
								status: "succeeded",
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

	it("replays an annual invoice after a refunded future period is granted at its net amount", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `annual-net-replay-${suffix}`;
		const customerId = `cus_annual_net_replay_${suffix}`;
		const providerSubscriptionId = `sub_annual_net_replay_${suffix}`;
		const providerInvoiceId = `in_annual_net_replay_${suffix}`;
		const providerChargeId = `ch_annual_net_replay_${suffix}`;
		const providerInvoicePaymentId = `ip_annual_net_replay_${suffix}`;
		const periodStart = new Date("2030-01-01T00:00:00.000Z");
		const periodEnd = new Date("2031-01-01T00:00:00.000Z");
		await client.user.create({
			data: {
				id: ownerId,
				name: "Annual net replay owner",
				email: `annual-net-replay-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: periodStart,
				updatedAt: periodStart,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_annual_net_replay_${suffix}`,
				name: "studio",
				creditsPerPeriod: 100n,
				priceMicros: 120_000_000n,
				currency: "USD",
				metadata: { planId: "studio", interval: "year", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
			},
		});
		const invoiceFact = {
			kind: "PAID_INVOICE",
			billingReason: "SUBSCRIPTION_CYCLE",
			providerInvoiceId,
			providerSubscriptionId,
			customerId,
			providerInvoicePaymentId,
			providerChargeId,
			providerPaymentIntentId: null,
			priceId: plan.providerPriceId,
			amountPaid: 1_200n,
			currency: "USD",
			periodStart,
			periodEnd,
			context: {
				origin: "WEBHOOK",
				changeAt: new Date("2030-01-01T00:00:01.000Z"),
				changeId: `evt_annual_net_initial_${suffix}`,
			},
		} as const;

		await client.$transaction((tx) =>
			applyStripeBillingFact(invoiceFact, tx, {
				now: new Date("2030-01-01T00:00:02.000Z"),
			}),
		);
		await client.$transaction((tx) =>
			applyStripeBillingFact(
				{
					kind: "REFUND",
					providerRefundId: `re_annual_net_replay_${suffix}`,
					providerChargeId,
					providerPaymentIntentId: null,
					amount: 150n,
					currency: "USD",
					status: "SUCCEEDED",
					providerCreatedAt: new Date("2030-01-01T00:00:03.000Z"),
					context: {
						origin: "WEBHOOK",
						changeAt: new Date("2030-01-01T00:00:03.000Z"),
						changeId: `evt_annual_net_refund_${suffix}`,
					},
				},
				tx,
				{ now: new Date("2030-01-01T00:00:04.000Z") },
			),
		);
		const futurePeriod = await client.billingPeriod.findUniqueOrThrow({
			where: {
				subscriptionId_startsAt: {
					subscriptionId: subscription.id,
					startsAt: new Date("2030-02-01T00:00:00.000Z"),
				},
			},
		});
		expect(futurePeriod.refundedCredits).toBe(50n);
		await grantDueBillingPeriods({ now: new Date("2030-02-01T00:00:01.000Z") }, client);

		await expect(
			client.$transaction((tx) =>
				applyStripeBillingFact(
					{
						...invoiceFact,
						context: {
							origin: "RECONCILIATION",
							changeAt: new Date("2030-02-01T00:00:02.000Z"),
							changeId: `reconcile_annual_net_${suffix}`,
						},
					},
					tx,
					{ now: new Date("2030-02-01T00:00:02.000Z") },
				),
			),
		).resolves.toMatchObject({ grantsCreated: 0 });
		await expect(
			client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: futurePeriod.grantReferenceKey! },
			}),
		).resolves.toMatchObject({ type: "GRANT", amount: 50n });
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

	it("expires the linked Purchase after grace and lets a newer active Stripe fact restore both", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `deadline-purchase-owner-${suffix}`;
		const customerId = `cus_deadline_purchase_${suffix}`;
		const providerSubscriptionId = `sub_deadline_purchase_${suffix}`;
		const now = new Date("2027-02-01T00:00:00.000Z");
		await client.user.create({
			data: {
				id: ownerId,
				name: "Deadline purchase owner",
				email: `deadline-purchase-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: now,
				updatedAt: now,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_deadline_purchase_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "past_due",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "PAST_DUE",
				currentPeriodEnd: new Date("2027-02-28T00:00:00.000Z"),
				graceEndsAt: now,
				lastProviderEventAt: new Date("2027-01-01T00:00:00.000Z"),
				lastProviderEventId: `evt_deadline_previous_${suffix}`,
			},
		});

		const deadlines = await reconcileSubscriptionsWithClient({ now }, client);
		expect(deadlines.expired).toBeGreaterThanOrEqual(1);
		await expect(
			client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).resolves.toMatchObject({ status: "EXPIRED" });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ status: "expired" });

		const recoveredAt = new Date("2027-02-02T00:00:00.000Z");
		const recoveryEvent = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_deadline_recovered_${suffix}`,
				verifiedAt: recoveredAt,
				envelope: {
					id: `evt_deadline_recovered_${suffix}`,
					type: "customer.subscription.updated",
					created: Math.floor(recoveredAt.getTime() / 1_000),
					data: {
						object: {
							id: providerSubscriptionId,
							customer: customerId,
							status: "active",
							current_period_start: Math.floor(recoveredAt.getTime() / 1_000),
							current_period_end: Math.floor(
								new Date("2027-03-02T00:00:00.000Z").getTime() / 1_000,
							),
							items: { data: [{ price: { id: plan.providerPriceId } }] },
						},
					},
				},
			},
		});
		await expect(
			processStripePaymentEvent({ paymentEventId: recoveryEvent.id }, client),
		).resolves.toMatchObject({ outcome: "PROCESSED" });
		await expect(
			client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).resolves.toMatchObject({ status: "ACTIVE", graceEndsAt: null });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ status: "active" });
	});

	it("keeps paid-through credits on cancellation and ignores a stale reactivation", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `cancel-user-${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Cancellation purchase fixture",
				email: `cancel-user-${suffix}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
				userId: ownerId,
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
				ownerId,
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
						data: {
							object: {
								id: subscription.providerSubscriptionId,
								customer: purchase.customerId,
								status,
								current_period_start: 1_786_612_800,
								current_period_end: 1_789_291_200,
								items: { data: [{ price: { id: plan.providerPriceId } }] },
							},
						},
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

	it("retries when its own payment-event lease expires without a successor", async () => {
		const processingToken = `lease-expired-${crypto.randomUUID()}`;
		const leaseExpiry = new Date("2030-01-01T00:00:00.000Z");
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_expired_lease_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				status: "PROCESSING",
				processingToken,
				processingLeasedUntil: leaseExpiry,
				envelope: { id: "evt_expired_lease", type: "noop", created: 1, data: { object: {} } },
			},
		});

		await expect(
			processClaimedStripePaymentEvent(
				{
					paymentEventId: event.id,
					processingToken,
					now: new Date("2030-01-01T00:01:00.000Z"),
				},
				client,
			),
		).rejects.toThrow("PAYMENT_EVENT_LEASE_EXPIRED");
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PROCESSING",
			processingToken,
			processingLeasedUntil: leaseExpiry,
		});
	});

	it("does not retry an unsupported Stripe event", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_unsupported_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: { id: "evt_unsupported", type: "payout.paid", created: 1, data: { object: {} } },
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toEqual({
			outcome: "IGNORED",
			grantsCreated: 0,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "IGNORED",
		});
	});

	it("retries an invoice after its subscription creation is processed", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `invoice-before-subscription-${suffix}`;
		const providerSubscriptionId = `sub_before_${suffix}`;
		const customerId = `cus_before_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Invoice ordering fixture",
				email: `invoice-before-subscription-${suffix}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_before_${suffix}`,
				name: "creator",
				creditsPerPeriod: 321n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const invoiceId = `in_before_${suffix}`;
		const invoice = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_invoice_before_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_invoice_payload_before_${suffix}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: invoiceId,
							customer: customerId,
							subscription: providerSubscriptionId,
							charge: `ch_before_${suffix}`,
							amount_paid: 1_900,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_000,
							period_end: 1_802_678_400,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: providerSubscriptionId,
										priceId: plan.providerPriceId,
										periodStart: 1_800_000_000,
										periodEnd: 1_802_678_400,
									}),
								],
							},
						},
					},
				},
			},
		});

		await expect(
			processStripePaymentEvent(
				{ paymentEventId: invoice.id, now: new Date(1_800_000_050_000) },
				client,
				{
					attempt: 1,
					maxAttempts: 5,
					triggerRunId: "run_invoice_before_subscription_1",
				},
			),
		).rejects.toThrow("STRIPE_SUBSCRIPTION_BINDING_PENDING");
		const failedInvoice = (await client.paymentEvent.findUniqueOrThrow({
			where: { id: invoice.id },
		})) as PaymentEventRetryMetadata;
		expect(failedInvoice).toMatchObject({
			status: "FAILED",
			failureReason: "PAYMENT_EVENT_RETRYABLE_FAILURE",
			attemptCount: 1,
			lastTriggerRunId: "run_invoice_before_subscription_1",
			lastErrorClass: "TRANSIENT",
		});
		expect(failedInvoice.lastTriggerAttempt).toBe(1);
		expect(failedInvoice.lastAttemptAt).toBeInstanceOf(Date);

		const subscriptionEvent = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_subscription_after_${suffix}`,
				verifiedAt: new Date(),
				envelope: subscriptionCreatedEnvelope({
					eventId: `evt_subscription_payload_after_${suffix}`,
					providerSubscriptionId,
					customerId,
					planId: plan.id,
					planKey: "creator",
					ownerId,
					priceId: plan.providerPriceId,
				}),
			},
		});
		expect(
			await processStripePaymentEvent({ paymentEventId: subscriptionEvent.id }, client),
		).toMatchObject({ outcome: "PROCESSED" });
		expect(
			await processStripePaymentEvent(
				{ paymentEventId: invoice.id, now: new Date(1_800_000_050_000) },
				client,
				{
					attempt: 2,
					maxAttempts: 5,
					triggerRunId: "run_invoice_before_subscription_2",
				},
			),
		).toMatchObject({ outcome: "PROCESSED", grantsCreated: 1 });
		expect(await client.billingPeriod.count({ where: { providerInvoiceId: invoiceId } })).toBe(1);
	});

	it("dead letters a missing invoice subscription with durable safe audit evidence", async () => {
		const suffix = crypto.randomUUID();
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_invoice_without_subscription_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_invoice_without_subscription_payload_${suffix}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: {
						object: {
							id: `in_without_subscription_${suffix}`,
						},
					},
				},
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		const failed = (await client.paymentEvent.findUniqueOrThrow({
			where: { id: event.id },
		})) as PaymentEventRetryMetadata;
		expect(failed).toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "STRIPE_SUBSCRIPTION_ID_MISSING",
			lastErrorClass: "TERMINAL",
		});
		expect(failed.lastTriggerAttempt).toBe(1);
		expect(failed.lastAttemptAt).toBeInstanceOf(Date);
		const audit = await client.auditLog.findFirstOrThrow({
			where: {
				action: "PAYMENT_EVENT_FAILURE_RECORDED",
				targetType: "PAYMENT_EVENT",
				targetId: event.id,
			},
			orderBy: { createdAt: "desc" },
		});
		expect(audit.after).toMatchObject({
			status: "DEAD_LETTER",
			attemptCount: 1,
			lastTriggerAttempt: 1,
			lastErrorClass: "TERMINAL",
		});
		expect(JSON.stringify(audit)).not.toMatch(
			/envelope|signature|evt_invoice_without_subscription_payload/i,
		);
	});

	it("leaves an audit-failed expired lease for durable recovery", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_audit_failure_lease_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_audit_failure_lease_payload_${crypto.randomUUID()}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: { object: { id: `in_audit_failure_lease_${crypto.randomUUID()}` } },
				},
			},
		});
		let transactionCalls = 0;
		const auditFailingClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property === "$transaction") {
					return async (...args: Parameters<typeof client.$transaction>) => {
						transactionCalls += 1;
						if (transactionCalls === 1) throw new Error("PAYMENT_FAILURE_AUDIT_UNAVAILABLE");
						return target.$transaction(...args);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, auditFailingClient, {
				attempt: 1,
				maxAttempts: 8,
				triggerRunId: "run_audit_failure_lease_1",
			}),
		).rejects.toThrow("PAYMENT_FAILURE_AUDIT_UNAVAILABLE");
		const stranded = await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } });
		expect(stranded).toMatchObject({
			status: "PROCESSING",
		});
		const strandedToken = stranded.processingToken!;
		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, client, {
				attempt: 2,
				maxAttempts: 8,
				triggerRunId: "run_audit_failure_lease_2",
			}),
		).rejects.toThrow("PAYMENT_EVENT_LEASE_ACTIVE");
		const expiredLease = new Date(Date.now() - 1_000);
		await client.paymentEvent.update({
			where: { id: event.id },
			data: { processingLeasedUntil: expiredLease },
		});
		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, client, {
				attempt: 3,
				maxAttempts: 8,
				triggerRunId: "run_audit_failure_lease_3",
			}),
		).resolves.toEqual({ outcome: "SKIPPED", grantsCreated: 0 });
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PROCESSING",
			processingToken: strandedToken,
			processingLeasedUntil: expiredLease,
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: event.id, eventType: "PAYMENT_EVENT_RECEIVED" },
			}),
		).toBe(0);
		await expect(
			recoverExpiredPaymentEvents({ now: new Date(), limit: 25 }, client),
		).resolves.toEqual({
			recovered: 1,
			deadLettered: 0,
		});
		expect(
			await client.outboxEvent.findUniqueOrThrow({
				where: {
					dedupeKey: `payment-event-recovery:${event.id}:${createHash("sha256")
						.update(strandedToken)
						.digest("hex")}`,
				},
			}),
		).toMatchObject({ status: "PENDING", payload: { paymentEventId: event.id } });
	});

	it("recovers an expired payment-event lease with safe evidence and a durable outbox event", async () => {
		const now = new Date("2000-01-01T00:01:00.000Z");
		const processingToken = `lease-recovery-${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_recovery_${crypto.randomUUID()}`,
				verifiedAt: now,
				status: "PROCESSING",
				processingToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
				envelope: {
					id: `evt_lease_recovery_payload_${crypto.randomUUID()}`,
					type: "invoice.paid",
					created: 1_800_000_000,
					data: { object: { id: `in_lease_recovery_${crypto.randomUUID()}` } },
				},
			},
		});
		const recoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(processingToken)
			.digest("hex")}`;

		await expect(recoverExpiredPaymentEvents({ now, limit: 25 }, client)).resolves.toEqual({
			recovered: 1,
			deadLettered: 0,
		});
		await expect(recoverExpiredPaymentEvents({ now, limit: 25 }, client)).resolves.toEqual({
			recovered: 0,
			deadLettered: 0,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "FAILED",
			failureReason: "PAYMENT_EVENT_LEASE_EXPIRED",
			attemptCount: 1,
			lastErrorClass: "TRANSIENT",
			processingToken: null,
			processingLeasedUntil: null,
		});
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: recoveryDedupeKey } }),
		).toMatchObject({
			eventType: "PAYMENT_EVENT_RECEIVED",
			aggregateType: "PAYMENT_EVENT",
			aggregateId: event.id,
			payload: { paymentEventId: event.id },
		});
		const audit = await client.auditLog.findFirstOrThrow({
			where: {
				action: "PAYMENT_EVENT_LEASE_RECOVERED",
				targetType: "PAYMENT_EVENT",
				targetId: event.id,
			},
			orderBy: { createdAt: "desc" },
		});
		expect(audit.after).toMatchObject({
			status: "FAILED",
			failureReason: "PAYMENT_EVENT_LEASE_EXPIRED",
			attemptCount: 1,
			lastErrorClass: "TRANSIENT",
		});
		expect(JSON.stringify(audit)).not.toMatch(
			/envelope|lease-recovery|evt_lease_recovery_payload/i,
		);
	});

	it("fences concurrent lease recoveries to one outbox event", async () => {
		const now = new Date("1999-01-01T00:01:00.000Z");
		const processingToken = `lease-recovery-concurrent-${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_recovery_concurrent_${crypto.randomUUID()}`,
				verifiedAt: now,
				status: "PROCESSING",
				processingToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
				envelope: {
					id: "evt_lease_recovery_concurrent",
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});
		const recoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(processingToken)
			.digest("hex")}`;

		const results = await Promise.all([
			recoverExpiredPaymentEvents({ now, limit: 25 }, client),
			recoverExpiredPaymentEvents({ now, limit: 25 }, client),
		]);

		expect(results.reduce((total, result) => total + result.recovered, 0)).toBe(1);
		expect(await client.outboxEvent.count({ where: { dedupeKey: recoveryDedupeKey } })).toBe(1);
		expect(
			await client.auditLog.count({
				where: {
					action: "PAYMENT_EVENT_LEASE_RECOVERED",
					targetType: "PAYMENT_EVENT",
					targetId: event.id,
				},
			}),
		).toBe(1);
	});

	it("creates an immutable recovery outbox for each expired lease cycle", async () => {
		const now = new Date("1998-01-01T00:01:00.000Z");
		const firstToken = `lease-recovery-first-${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_recovery_second_${crypto.randomUUID()}`,
				verifiedAt: now,
				status: "PROCESSING",
				processingToken: firstToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
				envelope: {
					id: "evt_lease_recovery_second",
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});
		const firstRecoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(firstToken)
			.digest("hex")}`;

		await recoverExpiredPaymentEvents({ now, limit: 25 }, client);
		const firstOutbox = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: firstRecoveryDedupeKey },
		});
		const secondToken = `lease-recovery-second-${crypto.randomUUID()}`;
		await client.paymentEvent.update({
			where: { id: event.id },
			data: {
				status: "PROCESSING",
				failureReason: null,
				processingToken: secondToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
			},
		});

		await expect(recoverExpiredPaymentEvents({ now, limit: 25 }, client)).resolves.toEqual({
			recovered: 1,
			deadLettered: 0,
		});
		const secondRecoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(secondToken)
			.digest("hex")}`;
		const secondOutbox = await client.outboxEvent.findUniqueOrThrow({
			where: { dedupeKey: secondRecoveryDedupeKey },
		});
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: event.id, eventType: "PAYMENT_EVENT_RECEIVED" },
			}),
		).toBe(2);
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { id: firstOutbox.id } }),
		).toMatchObject({
			id: firstOutbox.id,
			status: "PENDING",
			attempts: 0,
		});
		await client.outboxEvent.update({
			where: { id: firstOutbox.id },
			data: { status: "DEAD_LETTER", attempts: 3, lastError: "historic-delivery-failure" },
		});
		const thirdToken = `lease-recovery-third-${crypto.randomUUID()}`;
		await client.paymentEvent.update({
			where: { id: event.id },
			data: {
				status: "PROCESSING",
				failureReason: null,
				processingToken: thirdToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
			},
		});

		await expect(recoverExpiredPaymentEvents({ now, limit: 25 }, client)).resolves.toEqual({
			recovered: 1,
			deadLettered: 0,
		});
		const thirdRecoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(thirdToken)
			.digest("hex")}`;
		expect(
			await client.outboxEvent.count({
				where: { aggregateId: event.id, eventType: "PAYMENT_EVENT_RECEIVED" },
			}),
		).toBe(3);
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { id: firstOutbox.id } }),
		).toMatchObject({
			id: firstOutbox.id,
			status: "DEAD_LETTER",
			attempts: 3,
			lastError: "historic-delivery-failure",
		});
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { id: secondOutbox.id } }),
		).toMatchObject({
			id: secondOutbox.id,
			status: "PENDING",
			attempts: 0,
		});
		expect(
			await client.outboxEvent.findUniqueOrThrow({ where: { dedupeKey: thirdRecoveryDedupeKey } }),
		).toMatchObject({
			eventType: "PAYMENT_EVENT_RECEIVED",
			status: "PENDING",
			payload: { paymentEventId: event.id },
		});
	});

	it("rolls back expired-lease recovery when its safe audit cannot be written", async () => {
		const now = new Date("1997-01-01T00:01:00.000Z");
		const processingToken = `lease-recovery-audit-${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_recovery_audit_${crypto.randomUUID()}`,
				verifiedAt: now,
				status: "PROCESSING",
				processingToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
				envelope: {
					id: "evt_lease_recovery_audit",
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});
		const recoveryDedupeKey = `payment-event-recovery:${event.id}:${createHash("sha256")
			.update(processingToken)
			.digest("hex")}`;
		const auditFailingClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property !== "$transaction") return Reflect.get(target, property, receiver);
				return async (operation: (transaction: object) => Promise<unknown>, options: object) =>
					target.$transaction(
						async (transaction) =>
							operation(
								new Proxy(transaction, {
									get(transactionTarget, transactionProperty, transactionReceiver) {
										if (transactionProperty !== "auditLog") {
											return Reflect.get(
												transactionTarget,
												transactionProperty,
												transactionReceiver,
											);
										}
										return new Proxy(transactionTarget.auditLog, {
											get(auditLogTarget, auditLogProperty, auditLogReceiver) {
												if (auditLogProperty === "create") {
													return async () => {
														throw new Error("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE");
													};
												}
												return Reflect.get(auditLogTarget, auditLogProperty, auditLogReceiver);
											},
										});
									},
								}),
							),
						options as never,
					);
			},
		});

		await expect(
			recoverExpiredPaymentEvents({ now, limit: 25 }, auditFailingClient),
		).rejects.toThrow("PAYMENT_LEASE_RECOVERY_AUDIT_UNAVAILABLE");
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "PROCESSING",
			processingToken,
			processingLeasedUntil: new Date(now.getTime() - 1_000),
		});
		expect(await client.outboxEvent.count({ where: { dedupeKey: recoveryDedupeKey } })).toBe(0);
		expect(
			await client.auditLog.count({
				where: {
					action: "PAYMENT_EVENT_LEASE_RECOVERED",
					targetType: "PAYMENT_EVENT",
					targetId: event.id,
				},
			}),
		).toBe(0);
	});

	it("dead letters an expired lease when the durable event retry budget is exhausted", async () => {
		const now = new Date("1996-01-01T00:01:00.000Z");
		const processingToken = `lease-recovery-exhausted-${crypto.randomUUID()}`;
		const triggerRunId = `run_exhausted_${crypto.randomUUID()}`;
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_lease_recovery_exhausted_${crypto.randomUUID()}`,
				verifiedAt: now,
				status: "PROCESSING",
				attemptCount: 7,
				lastTriggerAttempt: 8,
				lastTriggerRunId: triggerRunId,
				lastErrorClass: "TRANSIENT",
				processingToken,
				processingLeasedUntil: new Date(now.getTime() - 1_000),
				envelope: {
					id: "evt_lease_recovery_exhausted",
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});

		await expect(recoverExpiredPaymentEvents({ now, limit: 25 }, client)).resolves.toEqual({
			recovered: 0,
			deadLettered: 1,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "DEAD_LETTER",
			attemptCount: 8,
			failureReason: "PAYMENT_EVENT_RETRY_BUDGET_EXHAUSTED",
			lastTriggerAttempt: 8,
			lastTriggerRunId: triggerRunId,
			lastAttemptAt: now,
			lastErrorClass: "TRANSIENT",
			processingToken: null,
			processingLeasedUntil: null,
		});
		expect(
			await client.outboxEvent.count({
				where: {
					dedupeKey: `payment-event-recovery:${event.id}:${createHash("sha256")
						.update(processingToken)
						.digest("hex")}`,
				},
			}),
		).toBe(0);
		expect(
			await client.auditLog.findFirstOrThrow({
				where: {
					action: "PAYMENT_EVENT_LEASE_DEAD_LETTERED",
					targetType: "PAYMENT_EVENT",
					targetId: event.id,
				},
			}),
		).toMatchObject({ after: { status: "DEAD_LETTER", attemptCount: 8 } });
	});

	it("rechecks a locked due period so a concurrent refund cannot be overwritten by a stale grant", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2045-06-15T00:00:00.000Z");
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_grant_refund_fence_${suffix}`,
				name: "grant refund fence",
				creditsPerPeriod: 100n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: { planId: "grant-refund-fence", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `grant-refund-fence-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: `sub_grant_refund_fence_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const period = await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date("1900-01-01T00:00:00.000Z"),
				endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
				status: "PENDING",
				creditAmount: 100n,
				grantReferenceKey: `grant-refund-fence:${suffix}`,
			},
		});
		const applicationName = `grant_refund_fence_${suffix.replaceAll("-", "_")}`;
		const grantUrl = new URL(assertSafeTestDatabaseUrl());
		grantUrl.searchParams.set("application_name", applicationName);
		const blockerUrl = new URL(assertSafeTestDatabaseUrl());
		blockerUrl.searchParams.set("application_name", `${applicationName}_blocker`);
		const grantClient = new PrismaClient({
			adapter: new PrismaPg({ connectionString: grantUrl.toString() }),
		});
		const blockerClient = new PrismaClient({
			adapter: new PrismaPg({ connectionString: blockerUrl.toString() }),
		});
		let lockHeld!: () => void;
		const lockHeldPromise = new Promise<void>((resolve) => {
			lockHeld = resolve;
		});
		let releaseLock!: () => void;
		const releaseLockPromise = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		let blockerPromise: Promise<unknown> | undefined;
		try {
			blockerPromise = blockerClient.$transaction(
				async (tx) => {
					await tx.$queryRaw<Array<{ id: string }>>`
						SELECT "id" FROM "billing_period" WHERE "id" = ${period.id} FOR UPDATE`;
					lockHeld();
					await releaseLockPromise;
					await tx.billingPeriod.update({
						where: { id: period.id },
						data: { status: "REFUNDED", refundedCredits: period.creditAmount },
					});
				},
				{ timeout: 10_000 },
			);
			await lockHeldPromise;
			const grantPromise = grantDueBillingPeriods({ now, limit: 1 }, grantClient);
			await waitForApplicationLock(client, applicationName);
			releaseLock();
			await blockerPromise;
			await grantPromise;

			await expect(
				client.billingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
			).resolves.toMatchObject({ status: "REFUNDED", refundedCredits: 100n });
			expect(
				await client.creditLedgerEntry.findUnique({
					where: { referenceKey: period.grantReferenceKey! },
				}),
			).toBeNull();
		} finally {
			releaseLock();
			if (blockerPromise) await Promise.allSettled([blockerPromise]);
			await Promise.all([grantClient.$disconnect(), blockerClient.$disconnect()]);
		}
	});

	it("throws after persisting a transient payment event failure", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_transient_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: { id: "evt_transient", type: "payout.paid", created: 1, data: { object: {} } },
			},
		});
		let transactionCalls = 0;
		const transientClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property === "$transaction") {
					return async (...args: Parameters<typeof client.$transaction>) => {
						transactionCalls += 1;
						if (transactionCalls === 1) throw new Error("DATABASE_TEMPORARILY_UNAVAILABLE");
						return target.$transaction(...args);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, transientClient, {
				attempt: 2,
				maxAttempts: 5,
				triggerRunId: "run_retry_2",
			}),
		).rejects.toThrow("DATABASE_TEMPORARILY_UNAVAILABLE");
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "FAILED",
			attemptCount: 1,
			lastTriggerRunId: "run_retry_2",
			lastErrorClass: "TRANSIENT",
		});
	});

	it("uses the durable event attempt count when a new Trigger run starts", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_durable_budget_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				attemptCount: 7,
				envelope: {
					id: `evt_durable_budget_payload_${crypto.randomUUID()}`,
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});
		let transactionCalls = 0;
		const transientClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property === "$transaction") {
					return async (...args: Parameters<typeof client.$transaction>) => {
						transactionCalls += 1;
						if (transactionCalls === 1) throw new Error("DATABASE_TEMPORARILY_UNAVAILABLE");
						return target.$transaction(...args);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, transientClient, {
				attempt: 1,
				maxAttempts: 8,
				triggerRunId: "new_trigger_run_attempt_1",
			}),
		).rejects.toThrow("DATABASE_TEMPORARILY_UNAVAILABLE");
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "DEAD_LETTER",
			attemptCount: 8,
			lastTriggerAttempt: 1,
			lastTriggerRunId: "new_trigger_run_attempt_1",
		});
	});

	it("dead letters the final transient payment event attempt and still throws", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_final_transient_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_final_transient",
					type: "payout.paid",
					created: 1,
					data: { object: {} },
				},
			},
		});
		let transactionCalls = 0;
		const transientClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property === "$transaction") {
					return async (...args: Parameters<typeof client.$transaction>) => {
						transactionCalls += 1;
						if (transactionCalls === 1) throw new Error("DATABASE_TEMPORARILY_UNAVAILABLE");
						return target.$transaction(...args);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		await expect(
			processStripePaymentEvent({ paymentEventId: event.id }, transientClient, {
				attempt: 5,
				maxAttempts: 5,
				triggerRunId: "run_retry_final",
			}),
		).rejects.toThrow("DATABASE_TEMPORARILY_UNAVAILABLE");
		const failed = (await client.paymentEvent.findUniqueOrThrow({
			where: { id: event.id },
		})) as PaymentEventRetryMetadata;
		expect(failed).toMatchObject({
			status: "DEAD_LETTER",
			attemptCount: 1,
			lastTriggerRunId: "run_retry_final",
			lastErrorClass: "TRANSIENT",
		});
		expect(failed.lastTriggerAttempt).toBe(5);
		expect(failed.lastAttemptAt).toBeInstanceOf(Date);
		expect(
			await client.auditLog.count({
				where: {
					action: "PAYMENT_EVENT_FAILURE_RECORDED",
					targetType: "PAYMENT_EVENT",
					targetId: event.id,
				},
			}),
		).toBe(1);
	});

	it("dead letters terminal payment event errors without throwing", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_terminal_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: {
					id: "evt_terminal",
					type: "invoice.paid",
					created: 1,
					data: { object: { id: "in_terminal" } },
				},
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "DEAD_LETTER",
			lastErrorClass: "TERMINAL",
		});
	});

	it("dead letters a malformed payment event instead of treating it as unsupported", async () => {
		const event = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_malformed_${crypto.randomUUID()}`,
				verifiedAt: new Date(),
				envelope: { type: "payout.paid" },
			},
		});

		expect(await processStripePaymentEvent({ paymentEventId: event.id }, client)).toEqual({
			outcome: "DEAD_LETTER",
			grantsCreated: 0,
		});
		expect(await client.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
			status: "DEAD_LETTER",
			failureReason: "STRIPE_EVENT_INVALID",
			lastErrorClass: "TERMINAL",
		});
	});

	it("applies a scheduled server-mapped plan only on the next paid invoice", async () => {
		const ownerId = `plan-change-${crypto.randomUUID()}`;
		const customerId = `cus_plan_change_${crypto.randomUUID()}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Plan change owner",
				email: `${ownerId}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const providerSubscriptionId = `sub_change_${crypto.randomUUID()}`;
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: oldPlan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: oldPlan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_change_${crypto.randomUUID()}`,
							amount_paid: 7_900,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_000,
							period_end: 1_802_678_400,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: newPlan.providerPriceId,
										periodStart: 1_800_000_000,
										periodEnd: 1_802_678_400,
									}),
								],
							},
						},
					},
				},
			},
		});
		await processStripePaymentEvent(
			{ paymentEventId: event.id, now: new Date(1_800_000_050_000) },
			client,
		);
		expect(
			await client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).toMatchObject({
			planId: newPlan.id,
			scheduledPlanId: null,
		});
		expect(
			await client.billingPeriod.findFirstOrThrow({ where: { subscriptionId: subscription.id } }),
		).toMatchObject({ creditAmount: 900n });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ priceId: newPlan.providerPriceId, status: "active" });
	});

	it("does not let a stale subscription event schedule a plan change", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `stale-plan-${suffix}`;
		const customerId = `cus_stale_plan_${suffix}`;
		const providerSubscriptionId = `sub_stale_plan_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Stale plan owner",
				email: `stale-plan-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: oldPlan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: oldPlan.id,
				purchaseId: purchase.id,
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
							customer: customerId,
							status: "active",
							current_period_start: 1_778_284_800,
							current_period_end: 1_780_963_200,
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
							id: `in_failure_${suffix}`,
							customer: `cus_failure_fence_${suffix}`,
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

	it("keeps Purchase status aligned when a current invoice payment fails", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `failure-owner-${suffix}`;
		const customerId = `cus_failure_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Invoice failure owner",
				email: `invoice-failure-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_failure_${suffix}`,
				name: "creator",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const providerSubscriptionId = `sub_failure_${suffix}`;
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				currentPeriodEnd: new Date("2027-02-01T00:00:00.000Z"),
				lastProviderEventAt: new Date("2027-01-01T00:00:00.000Z"),
				lastProviderEventId: `evt_previous_${suffix}`,
			},
		});
		const failure = await client.paymentEvent.create({
			data: {
				provider: "stripe",
				providerEventId: `evt_current_failure_${suffix}`,
				verifiedAt: new Date(),
				envelope: {
					id: `evt_current_failure_${suffix}`,
					type: "invoice.payment_failed",
					created: 1_799_366_400,
					data: {
						object: {
							id: `in_current_failure_${suffix}`,
							customer: customerId,
							subscription: providerSubscriptionId,
						},
					},
				},
			},
		});

		await expect(
			processStripePaymentEvent({ paymentEventId: failure.id }, client),
		).resolves.toMatchObject({ outcome: "PROCESSED" });
		await expect(
			client.subscription.findUniqueOrThrow({ where: { id: subscription.id } }),
		).resolves.toMatchObject({ status: "PAST_DUE" });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ status: "past_due" });
	});

	it("clears a scheduled change when a newer mapped event returns to the active plan", async () => {
		const suffix = crypto.randomUUID();
		const ownerId = `plan-revert-${suffix}`;
		const customerId = `cus_plan_revert_${suffix}`;
		const providerSubscriptionId = `sub_plan_revert_${suffix}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: "Plan revert owner",
				email: `plan-revert-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
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
		const purchase = await client.purchase.create({
			data: {
				userId: ownerId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: planA.providerPriceId,
				status: "active",
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId,
				planId: planA.id,
				purchaseId: purchase.id,
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
								customer: customerId,
								status: "active",
								current_period_start: input.created,
								current_period_end: input.created + 2_678_400,
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
							customer: customerId,
							subscription: subscription.providerSubscriptionId,
							charge: `ch_plan_revert_${suffix}`,
							amount_paid: 1_900,
							billing_reason: "subscription_cycle",
							period_start: 1_800_000_300,
							period_end: 1_802_678_700,
							lines: {
								data: [
									legacySubscriptionInvoiceLine({
										subscriptionId: subscription.providerSubscriptionId,
										priceId: planA.providerPriceId,
										periodStart: 1_800_000_300,
										periodEnd: 1_802_678_700,
									}),
								],
							},
						},
					},
				},
			},
		});
		expect(
			await processStripePaymentEvent(
				{ paymentEventId: invoice.id, now: new Date(1_800_000_350_000) },
				client,
			),
		).toMatchObject({
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

function legacySubscriptionInvoiceLine(input: {
	subscriptionId: string;
	priceId: string;
	periodStart: number;
	periodEnd: number;
}) {
	return {
		id: `il_${crypto.randomUUID()}`,
		subscription: input.subscriptionId,
		subscription_item: `si_${crypto.randomUUID()}`,
		proration: false,
		period: { start: input.periodStart, end: input.periodEnd },
		price: { id: input.priceId },
	};
}

async function createLegacyEarlyRefundFixture(
	client: PrismaClient,
	input: {
		lifecycleStatus?: "PENDING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED";
		recordRefundLedger?: boolean;
		spentBeforeRefund?: boolean;
	} = {},
) {
	const suffix = crypto.randomUUID();
	const ownerId = `legacy-early-refund-owner-${suffix}`;
	const legacyRefundId = `re_legacy_early_${suffix}`;
	const chargeId = `ch_legacy_early_${suffix}`;
	const periodEndsAt = new Date("2027-02-01T00:00:00.000Z");
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	const grantReferenceKey = `legacy-early-refund-grant:${suffix}`;
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 100n,
			expiresAt: periodEndsAt,
			referenceKey: grantReferenceKey,
		},
		client,
	);
	if (input.spentBeforeRefund) {
		const quoteInput = {
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "legacy-refund-spend",
			catalogVersion: "test-v1",
			pricingVersion: "test-v1",
			credits: 100n,
			costMicros: 0n,
			inputSnapshot: { kind: "image-edit", prompt: "consume credits before legacy refund" },
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		const quote = await createModeratedGenerationQuoteTransaction(
			{
				...quoteInput,
				moderation: {
					decision: "ALLOW",
					provider: "test",
					ruleVersion: TEST_MODERATION_RULE_VERSION,
					reasonCode: "TEST_ALLOW_LEGACY_REFUND_SPEND",
					inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
				},
			},
			client,
		);
		const created = await createGenerationJobTransaction(
			{
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: `legacy-refund-spend-job:${suffix}`,
				inputAssetIds: [],
				expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
			},
			client,
		);
		await settleCredits(
			{
				reservationId: created.reservation.id,
				amount: 100n,
				referenceKey: `legacy-refund-spend-settle:${suffix}`,
			},
			client,
		);
	}
	const plan = await client.billingPlan.create({
		data: {
			provider: "stripe",
			providerPriceId: `price_legacy_early_${suffix}`,
			name: "legacy early refund fixture",
			creditsPerPeriod: 100n,
			priceMicros: 10_000_000n,
			currency: "USD",
			metadata: { planId: "legacy-early-refund", interval: "month", version: 1 },
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "stripe",
			providerSubscriptionId: `sub_legacy_early_${suffix}`,
			planId: plan.id,
			status: "ACTIVE",
		},
	});
	const period = await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: new Date("2027-01-01T00:00:00.000Z"),
			endsAt: periodEndsAt,
			status: "ACTIVE",
			creditAmount: 100n,
			grantReferenceKey,
			providerInvoiceId: `in_legacy_early_${suffix}`,
			providerInvoicePaymentId: `inpay_legacy_early_${suffix}`,
			providerChargeId: chargeId,
			paidAmount: 1_000n,
		},
	});
	if (input.recordRefundLedger !== false) {
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: 50n,
				grantReferenceKey,
				referenceKey: `stripe-refund:${legacyRefundId}:${period.id}`,
				metadata: {
					providerRefundId: legacyRefundId,
					providerChargeId: chargeId,
					billingPeriodId: period.id,
				},
			},
			client,
		);
	}
	await client.billingPeriod.update({
		where: { id: period.id },
		data: { refundedAmount: 500n, refundedCredits: 50n },
	});
	let refundLifecycleId: string | null = null;
	const lastProviderChangeId = `evt_legacy_early_${suffix}`;
	if (input.lifecycleStatus) {
		const lifecycle = await client.stripeRefund.create({
			data: {
				provider: "stripe",
				providerRefundId: legacyRefundId,
				providerChargeId: chargeId,
				amount: 500n,
				currency: "USD",
				status: input.lifecycleStatus,
				providerCreatedAt: new Date("2027-01-15T00:00:00.000Z"),
				lastProviderChangeAt: new Date("2027-01-15T00:00:00.000Z"),
				lastProviderChangeId,
			},
		});
		refundLifecycleId = lifecycle.id;
	}
	return {
		accountId: account.id,
		legacyRefundId,
		chargeId,
		periodId: period.id,
		refundLifecycleId,
		lastProviderChangeId,
	};
}

async function createLegacyRefundRepairIssue(client: PrismaClient, providerRefundId: string) {
	const issueKey = `stripe:REFUND:${providerRefundId}:STRIPE_LEGACY_REFUND_REPAIR_REQUIRED`;
	return client.stripeReconciliationIssue.create({
		data: {
			issueKey,
			provider: "stripe",
			sweepId: `sweep-${crypto.randomUUID()}`,
			stage: "REFUNDS",
			code: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED",
			entityType: "REFUND",
			providerObjectId: providerRefundId,
			details: {},
		},
	});
}

async function createLegacyAnnualProjectionRefundFixture(
	client: PrismaClient,
	lifecycleStatus: "SUCCEEDED" | "FAILED" = "FAILED",
) {
	const suffix = crypto.randomUUID();
	const ownerId = `legacy-annual-refund-owner-${suffix}`;
	const legacyRefundId = `re_legacy_annual_${suffix}`;
	const chargeId = `ch_legacy_annual_${suffix}`;
	const invoiceId = `in_legacy_annual_${suffix}`;
	const invoicePaymentId = `inpay_legacy_annual_${suffix}`;
	const firstGrantReferenceKey = `legacy-annual-refund-grant:${suffix}:0`;
	const futureGrantReferenceKey = `legacy-annual-refund-grant:${suffix}:1`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{
			accountId: account.id,
			amount: 100n,
			expiresAt: new Date("2027-02-01T00:00:00.000Z"),
			referenceKey: firstGrantReferenceKey,
		},
		client,
	);
	const plan = await client.billingPlan.create({
		data: {
			provider: "stripe",
			providerPriceId: `price_legacy_annual_${suffix}`,
			name: "legacy annual refund fixture",
			creditsPerPeriod: 100n,
			priceMicros: 10_000_000n,
			currency: "USD",
			metadata: { planId: "legacy-annual-refund", interval: "year", version: 1 },
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "stripe",
			providerSubscriptionId: `sub_legacy_annual_${suffix}`,
			planId: plan.id,
			status: "ACTIVE",
		},
	});
	const firstPeriod = await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: new Date("2027-01-01T00:00:00.000Z"),
			endsAt: new Date("2027-02-01T00:00:00.000Z"),
			status: "REFUNDED",
			creditAmount: 100n,
			grantReferenceKey: firstGrantReferenceKey,
			providerInvoiceId: invoiceId,
			providerInvoicePaymentId: invoicePaymentId,
			providerChargeId: chargeId,
			paidAmount: 1_000n,
			refundedAmount: 1_000n,
			refundedCredits: 100n,
		},
	});
	await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: new Date("2027-02-01T00:00:00.000Z"),
			endsAt: new Date("2027-03-01T00:00:00.000Z"),
			status: "REFUNDED",
			creditAmount: 100n,
			grantReferenceKey: futureGrantReferenceKey,
			providerInvoiceId: invoiceId,
			providerInvoicePaymentId: invoicePaymentId,
			providerChargeId: chargeId,
			paidAmount: 1_000n,
			refundedCredits: 100n,
		},
	});
	await refundCreditGrant(
		{
			accountId: account.id,
			amount: 100n,
			grantReferenceKey: firstGrantReferenceKey,
			referenceKey: `stripe-refund:${legacyRefundId}:${firstPeriod.id}`,
			metadata: {
				providerRefundId: legacyRefundId,
				providerChargeId: chargeId,
				billingPeriodId: firstPeriod.id,
			},
		},
		client,
	);
	const lastProviderChangeId = `evt_legacy_annual_${suffix}`;
	await client.stripeRefund.create({
		data: {
			provider: "stripe",
			providerRefundId: legacyRefundId,
			providerChargeId: chargeId,
			amount: 1_000n,
			currency: "USD",
			status: lifecycleStatus,
			providerCreatedAt: new Date("2027-01-15T00:00:00.000Z"),
			lastProviderChangeAt: new Date("2027-01-15T00:00:00.000Z"),
			lastProviderChangeId,
		},
	});
	return {
		accountId: account.id,
		futureGrantReferenceKey,
		legacyRefundId,
		lastProviderChangeId,
		subscriptionId: subscription.id,
	};
}

async function createSucceededRefundEvent(
	client: PrismaClient,
	input: { providerRefundId: string; providerChargeId: string; amount: number },
) {
	return createRefundEvent(client, { ...input, status: "succeeded" });
}

async function createRefundEvent(
	client: PrismaClient,
	input: {
		providerRefundId: string;
		providerChargeId: string;
		amount: number;
		status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
	},
) {
	const suffix = crypto.randomUUID();
	return client.paymentEvent.create({
		data: {
			provider: "stripe",
			providerEventId: `evt_succeeded_refund_${suffix}`,
			verifiedAt: new Date(),
			envelope: {
				id: `evt_succeeded_refund_${suffix}`,
				type: "refund.updated",
				created: 1_800_000_100,
				data: {
					object: {
						id: input.providerRefundId,
						charge: input.providerChargeId,
						amount: input.amount,
						currency: "usd",
						created: 1_800_000_000,
						status: input.status,
					},
				},
			},
		},
	});
}

async function createStripeReservedRefundFixture(client: PrismaClient) {
	const suffix = crypto.randomUUID();
	const ownerId = `stripe-reserved-refund-${suffix}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	const grantReferenceKey = `stripe-reserved-refund-grant:${suffix}`;
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey },
		client,
	);
	const quoteInput = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "stripe-refund-reservation",
		catalogVersion: "test-v1",
		pricingVersion: "test-v1",
		credits: 100n,
		costMicros: 0n,
		inputSnapshot: { kind: "image-edit", prompt: "refund reservation wiring" },
		pricingSnapshot: {},
		expiresAt: new Date(Date.now() + 60_000),
	};
	const quote = await createModeratedGenerationQuoteTransaction(
		{
			...quoteInput,
			moderation: {
				decision: "ALLOW",
				provider: "test",
				ruleVersion: TEST_MODERATION_RULE_VERSION,
				reasonCode: "TEST_ALLOW_STRIPE_REFUND_RESERVATION",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quoteInput),
			},
		},
		client,
	);
	const created = await createGenerationJobTransaction(
		{
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId: quote.id,
			idempotencyKey: `stripe-refund-reservation-job:${suffix}`,
			inputAssetIds: [],
			expectedModerationRuleVersion: TEST_MODERATION_RULE_VERSION,
		},
		client,
	);
	const plan = await client.billingPlan.create({
		data: {
			provider: "stripe",
			providerPriceId: `price_reserved_refund_${suffix}`,
			name: "reserved refund fixture",
			creditsPerPeriod: 100n,
			priceMicros: 10_000_000n,
			currency: "USD",
			metadata: { planId: "reserved-refund", interval: "month", version: 1 },
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId,
			provider: "stripe",
			providerSubscriptionId: `sub_reserved_refund_${suffix}`,
			planId: plan.id,
			status: "ACTIVE",
		},
	});
	const chargeId = `ch_reserved_refund_${suffix}`;
	const period = await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: new Date("2027-01-01T00:00:00.000Z"),
			endsAt: new Date("2027-02-01T00:00:00.000Z"),
			status: "ACTIVE",
			creditAmount: 100n,
			grantReferenceKey,
			providerInvoiceId: `in_reserved_refund_${suffix}`,
			providerInvoicePaymentId: `inpay_reserved_refund_${suffix}`,
			providerChargeId: chargeId,
			paidAmount: 1_000n,
		},
	});
	const providerRefundId = `re_reserved_refund_${suffix}`;
	const refund = await client.paymentEvent.create({
		data: {
			provider: "stripe",
			providerEventId: `evt_reserved_refund_${suffix}`,
			verifiedAt: new Date(),
			envelope: {
				id: `evt_reserved_refund_${suffix}`,
				type: "refund.updated",
				created: 1_800_000_000,
				data: {
					object: {
						id: providerRefundId,
						charge: chargeId,
						amount: 1_000,
						currency: "usd",
						created: 1_800_000_000,
						status: "succeeded",
					},
				},
			},
		},
	});
	await expect(
		processStripePaymentEvent({ paymentEventId: refund.id }, client),
	).resolves.toMatchObject({ outcome: "PROCESSED" });
	await expect(
		client.billingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
	).resolves.toMatchObject({ status: "REFUNDED", refundedCredits: 100n });
	const refundLifecycle = await client.stripeRefund.findUniqueOrThrow({
		where: { provider_providerRefundId: { provider: "stripe", providerRefundId } },
	});
	return {
		account,
		reservation: created.reservation,
		periodId: period.id,
		refundLifecycleId: refundLifecycle.id,
	};
}

function createStripeTestSignature(payload: string, secret: string): string {
	const timestamp = Math.floor(Date.now() / 1_000);
	const signature = createHmac("sha256", secret)
		.update(`${timestamp}.${payload}`, "utf8")
		.digest("hex");
	return `t=${timestamp},v1=${signature}`;
}

async function waitForApplicationLock(
	client: PrismaClient,
	applicationName: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [row] = await client.$queryRaw<Array<{ waiting: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'
			) AS "waiting"`;
		if (row?.waiting) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for the due-period grant to reach the database lock");
}
