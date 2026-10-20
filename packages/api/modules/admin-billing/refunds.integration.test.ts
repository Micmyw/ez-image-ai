import { PrismaPg } from "@prisma/adapter-pg";
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import {
	adjustAdminCredits,
	createCreditGrant,
	getCreditInvariantReport,
	listAdminRefundablePayments,
	readAdminRefundPayment,
} from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { reconcileAdminRefund, refundAdminOrder } from "@repo/payments";
import type { PaymentProvider } from "@repo/payments/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const runId = crypto.randomUUID();
let client: PrismaClient;
const platform = { kind: "platform" } as const;

beforeAll(() => {
	if (!url) throw new Error("TEST_DATABASE_URL_REQUIRED");
	const parsed = new URL(url);
	if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.endsWith("_test"))
		throw new Error("ISOLATED_LOOPBACK_TEST_DATABASE_REQUIRED");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
});
afterAll(async () => {
	await client?.$disconnect();
});

async function baseFixture(kind: "CREDIT_PACK" | "PLAN" | "IMAGE_PASS" = "CREDIT_PACK") {
	const token = `${runId}-${crypto.randomUUID()}`;
	const ownerId = `admin-billing-${token}`;
	const providerPaymentId = `CAP-${token}`;
	const providerOrderId = `ORDER-${token}`;
	const paidAt = new Date(Date.now() - 60_000);
	const amountMicros = kind === "IMAGE_PASS" ? 1_000_000n : 59_000_000n;
	await client.user.create({
		data: {
			id: ownerId,
			name: "Admin billing isolated fixture",
			email: `${ownerId}@example.test`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	const plan = await client.billingPlan.create({
		data: {
			provider: "paypal",
			providerPriceId: `PRICE-${token}`,
			productKind: kind,
			name: `test-${token}`,
			priceMicros: amountMicros,
			currency: "USD",
			creditsPerPeriod: kind === "IMAGE_PASS" ? 0n : 100n,
			metadata: {
				interval: kind === "PLAN" ? "month" : "one-time",
				providerEnvironment: "sandbox",
			},
		},
	});
	const checkout = await client.paymentCheckoutIntent.create({
		data: {
			provider: "paypal",
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			productKind: kind,
			billingPlanId: plan.id,
			planKey: "test",
			interval: kind === "PLAN" ? "month" : "one-time",
			idempotencyKey: token,
			providerSessionId: providerOrderId,
			providerOrderId,
			status: "COMPLETED",
			...(kind === "CREDIT_PACK"
				? {
						creditPackCatalogVersion: "2026-09-06.1",
						creditPackPricingVersion: "2026-09-06.1",
						creditPackSubscriberEligibilityVersion: "2026-09-06.1",
						creditPackBaseCredits: 100n,
						creditPackBonusCredits: 0n,
						creditPackTotalCredits: 100n,
						creditPackExpiryMonths: 6,
						creditPackSubscriberBonusEligible: false,
						creditPackEligibilityEvaluatedAt: paidAt,
					}
				: {}),
			...(kind === "IMAGE_PASS" ? { imagePassOfferSnapshot: getImagePassOfferSnapshot() } : {}),
		},
	});
	return {
		ownerId,
		token,
		plan,
		checkout,
		providerPaymentId,
		providerOrderId,
		paidAt,
		amountMicros,
	};
}

async function packFixture() {
	const fixture = await baseFixture();
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId: fixture.ownerId },
	});
	const grantReferenceKey = `fixture-admin-pack:${fixture.token}`;
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey },
		client,
	);
	const pack = await client.creditPackFulfillment.create({
		data: {
			checkoutIntentId: fixture.checkout.id,
			billingPlanId: fixture.plan.id,
			ownerType: "USER",
			ownerId: fixture.ownerId,
			provider: "paypal",
			providerOrderId: fixture.providerOrderId,
			providerPaymentId: fixture.providerPaymentId,
			paidAmountMicros: fixture.amountMicros,
			currency: "USD",
			baseCredits: 100n,
			bonusCredits: 0n,
			grantedCredits: 100n,
			grantReferenceKey,
			paidAt: fixture.paidAt,
			expiresAt: new Date(Date.now() + 86400_000),
		},
	});
	await client.paymentEvent.create({
		data: {
			provider: "paypal",
			providerEventId: `event-${fixture.token}`,
			providerEnvironment: "sandbox",
			status: "PROCESSED",
			verifiedAt: new Date(),
			envelope: {
				event_type: "PAYMENT.CAPTURE.COMPLETED",
				resource: {
					id: fixture.providerPaymentId,
					status: "COMPLETED",
					amount: { value: "59.00", currency_code: "USD" },
				},
			},
		},
	});
	return { ...fixture, account, orderNo: `pack:${pack.id}`, pack };
}

function adapterForFixture(fixture: Awaited<ReturnType<typeof baseFixture>>) {
	const submit = vi.fn().mockResolvedValue({
		status: "SUCCEEDED",
		providerRefundId: `REF-${fixture.token}`,
		amountMicros: fixture.amountMicros,
		currency: "USD",
		occurredAt: new Date(),
	});
	const inspect = vi.fn().mockImplementation(submit.getMockImplementation()!);
	return { name: "paypal", verifyPayment: vi.fn().mockResolvedValue(undefined), submit, inspect };
}

async function subscriptionFixture() {
	const fixture = await baseFixture("PLAN");
	const purchase = await client.purchase.create({
		data: {
			userId: fixture.ownerId,
			provider: "paypal",
			type: "SUBSCRIPTION",
			productKind: "PLAN",
			customerId: `payer-${fixture.token}`,
			subscriptionId: fixture.providerOrderId,
			priceId: fixture.plan.providerPriceId,
			status: "active",
		},
	});
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId: fixture.ownerId,
			provider: "paypal",
			providerSubscriptionId: fixture.providerOrderId,
			purchaseId: purchase.id,
			planId: fixture.plan.id,
			status: "ACTIVE",
			currentPeriodStart: fixture.paidAt,
			currentPeriodEnd: new Date(Date.now() + 86400_000),
		},
	});
	const account = await client.creditAccount.create({
		data: { ownerType: "USER", ownerId: fixture.ownerId },
	});
	const grantReferenceKey = `subscription-grant-${fixture.token}`;
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey },
		client,
	);
	const period = await client.billingPeriod.create({
		data: {
			subscriptionId: subscription.id,
			startsAt: fixture.paidAt,
			endsAt: new Date(Date.now() + 86400_000),
			status: "ACTIVE",
			creditAmount: 100n,
			grantReferenceKey,
			providerInvoicePaymentId: `paypal:${fixture.providerPaymentId}`,
			paidAmount: 59_000_000n,
		},
	});
	await client.paymentEvent.create({
		data: {
			provider: "paypal",
			providerEventId: `event-${fixture.token}`,
			providerEnvironment: "sandbox",
			providerSubscriptionId: fixture.providerOrderId,
			status: "PROCESSED",
			verifiedAt: new Date(),
			envelope: {
				event_type: "PAYMENT.SALE.COMPLETED",
				resource: {
					id: fixture.providerPaymentId,
					billing_agreement_id: fixture.providerOrderId,
					create_time: fixture.paidAt.toISOString(),
					amount: { total: "59.00", currency: "USD" },
				},
			},
		},
	});
	return { ...fixture, purchase, subscription, account, period, orderNo: `plan:${period.id}` };
}

describe("administrator billing with real PostgreSQL transactions and mocked providers", () => {
	it("serializes double-click refunds, keeps original grant revocation/debt and preserves ledger invariants", async () => {
		const fixture = await packFixture();
		await adjustAdminCredits(
			{
				scope: platform,
				actorId: "isolated-admin",
				idempotencyKey: `spend-${fixture.token}`,
				ownerType: "USER",
				ownerId: fixture.ownerId,
				action: "deduct",
				credits: 80,
				reason: "Existing consumed balance fixture",
			},
			client,
		);
		const adapter = adapterForFixture(fixture);
		const input = {
			scope: { kind: "user", userId: fixture.ownerId } as const,
			orderNo: fixture.orderNo,
			actorId: "isolated-admin",
		};
		await Promise.all([
			refundAdminOrder(input, { client, adapter: () => adapter }),
			refundAdminOrder(input, { client, adapter: () => adapter }),
		]);
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		const request = await client.adminRefundRequest.findUniqueOrThrow({
			where: { paymentKey: `paypal:${fixture.providerPaymentId}` },
		});
		expect(request.status).toBe("SUCCEEDED");
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: fixture.account.id, type: "REFUND" },
			}),
		).toBe(1);
		expect(
			await client.creditAccount.findUnique({ where: { id: fixture.account.id } }),
		).toMatchObject({ spendableCredits: 0n, creditDebt: 80n });
		expect((await getCreditInvariantReport(fixture.account.id, client)).valid).toBe(true);
		const replay = await reconcileAdminRefund(
			{ scope: input.scope, requestId: request.id, actorId: "isolated-admin" },
			{ client, adapter: () => adapter },
		);
		expect(replay.credits).toEqual({ requested: "100", revoked: "20", debtIncurred: "80" });
		expect(adapter.submit).toHaveBeenCalledTimes(1);
	});

	it("rolls back local entitlement effects after external acceptance, then recovers solely through provider inspection", async () => {
		const fixture = await packFixture();
		let failCompletion = true;
		const faultedClient = new Proxy(client, {
			get(target, property, receiver) {
				if (property !== "$transaction") return Reflect.get(target, property, receiver);
				return (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
					target.$transaction(
						async (tx) =>
							operation(
								new Proxy(tx, {
									get(transaction, key, transactionReceiver) {
										if (key !== "adminRefundRequest")
											return Reflect.get(transaction, key, transactionReceiver);
										return {
											...transaction.adminRefundRequest,
											update: async (args: { data: { status?: string } }) => {
												if (failCompletion && args.data.status === "SUCCEEDED") {
													failCompletion = false;
													throw new Error("simulated local commit failure");
												}
												return transaction.adminRefundRequest.update(args as never);
											},
										};
									},
								}),
							),
						options as never,
					);
			},
		});
		const adapter = adapterForFixture(fixture);
		const input = { scope: platform, orderNo: fixture.orderNo, actorId: "isolated-admin" };
		const result = await refundAdminOrder(input, { client: faultedClient, adapter: () => adapter });
		expect(result.status).toBe("UNKNOWN");
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: fixture.account.id, type: "REFUND" },
			}),
		).toBe(0);
		expect(
			await client.creditAccount.findUnique({ where: { id: fixture.account.id } }),
		).toMatchObject({ spendableCredits: 100n, creditDebt: 0n });
		const recovered = await reconcileAdminRefund(
			{ scope: platform, requestId: result.requestId, actorId: "isolated-admin" },
			{ client, adapter: () => adapter },
		);
		expect(recovered.status).toBe("SUCCEEDED");
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		expect(adapter.inspect).toHaveBeenCalledTimes(1);
		expect((await getCreditInvariantReport(fixture.account.id, client)).valid).toBe(true);
	});

	it("keeps a pending/unknown provider request without touching credits and denies cross-owner recovery", async () => {
		const fixture = await packFixture();
		const adapter = adapterForFixture(fixture);
		adapter.submit.mockResolvedValue({ status: "PROCESSING" });
		adapter.inspect.mockResolvedValue({
			status: "UNKNOWN",
			error: "PAYPAL_REFUND_CONFIRMATION_PENDING",
		});
		const result = await refundAdminOrder(
			{ scope: platform, orderNo: fixture.orderNo, actorId: "isolated-admin" },
			{ client, adapter: () => adapter },
		);
		expect(result.status).toBe("PROCESSING");
		await expect(
			reconcileAdminRefund(
				{ scope: { kind: "user", userId: "other" }, requestId: result.requestId, actorId: "other" },
				{ client, adapter: () => adapter },
			),
		).rejects.toThrow("ADMIN_REFUND_REQUEST_NOT_FOUND");
		const recovered = await reconcileAdminRefund(
			{ scope: platform, requestId: result.requestId, actorId: "isolated-admin" },
			{ client, adapter: () => adapter },
		);
		expect(recovered.status).toBe("UNKNOWN");
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		expect(
			await client.creditLedgerEntry.count({
				where: { accountId: fixture.account.id, type: "REFUND" },
			}),
		).toBe(0);
	});

	it("serializes independent grants/debits, rejects insufficient balance and never alters payment state", async () => {
		const fixture = await packFixture();
		const common = {
			scope: platform,
			actorId: "isolated-admin",
			ownerType: "USER" as const,
			ownerId: fixture.ownerId,
			reason: "Operator correction",
		};
		const outcomes = await Promise.allSettled([
			adjustAdminCredits(
				{ ...common, action: "deduct", credits: 70, idempotencyKey: `debit-a-${fixture.token}` },
				client,
			),
			adjustAdminCredits(
				{ ...common, action: "deduct", credits: 70, idempotencyKey: `debit-b-${fixture.token}` },
				client,
			),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const gift = {
			...common,
			action: "grant" as const,
			credits: 20,
			idempotencyKey: `gift-${fixture.token}`,
		};
		await Promise.all([adjustAdminCredits(gift, client), adjustAdminCredits(gift, client)]);
		await expect(adjustAdminCredits({ ...gift, credits: 30 }, client)).rejects.toThrow(
			"IDEMPOTENCY_CONFLICT",
		);
		expect(
			await client.creditAccount.findUnique({ where: { id: fixture.account.id } }),
		).toMatchObject({ spendableCredits: 50n, creditDebt: 0n });
		expect(
			await client.creditPackFulfillment.findUnique({ where: { id: fixture.pack.id } }),
		).toMatchObject({ status: "FULFILLED", refundedAmountMicros: 0n });
		expect((await getCreditInvariantReport(fixture.account.id, client)).valid).toBe(true);
	});

	it("revokes ImagePass units through its existing reducer without creating shared-credit refunds", async () => {
		const fixture = await baseFixture("IMAGE_PASS");
		const grant = await client.imagePassGrant.create({
			data: {
				checkoutIntentId: fixture.checkout.id,
				ownerId: fixture.ownerId,
				provider: "paypal",
				providerOrderId: fixture.providerOrderId,
				providerPaymentId: fixture.providerPaymentId,
				paidAmountMicros: 1_000_000n,
				currency: "USD",
				offerSnapshot: getImagePassOfferSnapshot(),
				paidAt: fixture.paidAt,
				units: { create: [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3, status: "CONSUMED" }] },
			},
		});
		await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: `event-${fixture.token}`,
				providerEnvironment: "sandbox",
				status: "PROCESSED",
				verifiedAt: new Date(),
				envelope: {
					event_type: "PAYMENT.CAPTURE.COMPLETED",
					resource: { id: fixture.providerPaymentId },
				},
			},
		});
		const adapter = adapterForFixture(fixture);
		const result = await refundAdminOrder(
			{ scope: platform, orderNo: `image-pass:${grant.id}`, actorId: "isolated-admin" },
			{ client, adapter: () => adapter },
		);
		expect(result.status).toBe("SUCCEEDED");
		expect(result.credits).toEqual({ requested: "0", revoked: "0", debtIncurred: "0" });
		expect(await client.imagePassGrant.findUnique({ where: { id: grant.id } })).toMatchObject({
			status: "FROZEN",
		});
		expect(
			await client.imagePassUnit.count({ where: { grantId: grant.id, status: "REVOKED" } }),
		).toBe(2);
		expect(
			await client.imagePassUnit.count({ where: { grantId: grant.id, status: "CONSUMED" } }),
		).toBe(1);
	});

	it("keeps full-refund automatic subscription termination and reports cancellation failure separately", async () => {
		const fixture = await subscriptionFixture();
		const adapter = adapterForFixture(fixture);
		const cancel = vi
			.fn()
			.mockRejectedValue(new Error("SUBSCRIPTION_CANCELLATION_CONFIRMATION_PENDING"));
		const result = await refundAdminOrder(
			{
				scope: platform,
				orderNo: fixture.orderNo,
				actorId: "isolated-admin",
				cancelSubscription: false,
			},
			{ client, adapter: () => adapter, cancel },
		);
		expect(result).toMatchObject({
			status: "SUCCEEDED",
			cancellation: { policyRequired: true, status: "FAILED" },
		});
		expect(
			await client.subscription.findUnique({ where: { id: fixture.subscription.id } }),
		).toMatchObject({ refundTerminationPaymentId: `paypal:${fixture.providerPaymentId}` });
		expect(
			await client.outboxEvent.count({
				where: { dedupeKey: `refund-termination:${fixture.subscription.id}` },
			}),
		).toBe(1);
		expect((await getCreditInvariantReport(fixture.account.id, client)).valid).toBe(true);
		await expect(
			readAdminRefundPayment({ kind: "user", userId: "another-user" }, fixture.orderNo, client),
		).rejects.toThrow("ADMIN_ORDER_NOT_FOUND");
		const listed = await listAdminRefundablePayments(
			{ kind: "user", userId: fixture.ownerId },
			{ limit: 10 },
			client,
		);
		expect(listed.items).toHaveLength(1);
		expect(listed.items[0]).toMatchObject({ refundStatus: "SUCCEEDED", canRefund: false });
	});

	it("does not treat cancellation no-ops as success while another payment's refund termination is pending", async () => {
		const fixture = await subscriptionFixture();
		const olderPaidAt = new Date(fixture.paidAt.getTime() - 31 * 86400_000);
		const olderPaymentId = `older-${fixture.providerPaymentId}`;
		const grantReferenceKey = `older-subscription-grant-${fixture.token}`;
		await createCreditGrant(
			{ accountId: fixture.account.id, amount: 100n, referenceKey: grantReferenceKey },
			client,
		);
		const olderPeriod = await client.billingPeriod.create({
			data: {
				subscriptionId: fixture.subscription.id,
				startsAt: olderPaidAt,
				endsAt: fixture.paidAt,
				status: "ACTIVE",
				creditAmount: 100n,
				grantReferenceKey,
				providerInvoicePaymentId: `paypal:${olderPaymentId}`,
				paidAmount: 59_000_000n,
			},
		});
		await client.paymentEvent.create({
			data: {
				provider: "paypal",
				providerEventId: `older-event-${fixture.token}`,
				providerEnvironment: "sandbox",
				providerSubscriptionId: fixture.providerOrderId,
				status: "PROCESSED",
				verifiedAt: new Date(),
				envelope: {
					event_type: "PAYMENT.SALE.COMPLETED",
					resource: {
						id: olderPaymentId,
						billing_agreement_id: fixture.providerOrderId,
						create_time: olderPaidAt.toISOString(),
						amount: { total: "59.00", currency: "USD" },
					},
				},
			},
		});
		const latestAdapter = adapterForFixture(fixture);
		const latest = await refundAdminOrder(
			{
				scope: platform,
				orderNo: fixture.orderNo,
				actorId: "isolated-admin",
			},
			{
				client,
				adapter: () => latestAdapter,
				cancel: async () => {
					throw new Error("REFUND_TERMINATION_CONFIRMATION_PENDING");
				},
			},
		);
		expect(latest.cancellation.status).toBe("FAILED");
		const inspectCancellation = vi.fn().mockResolvedValue("RENEWING");
		const cancelSubscription = vi.fn().mockResolvedValue(undefined);
		const provider: PaymentProvider = {
			name: "paypal",
			capabilities: {
				checkout: false,
				portal: false,
				cancellation: true,
				seatUpdates: false,
				webhooks: false,
			},
			createCheckout: async () => {
				throw new Error("UNEXPECTED_CHECKOUT");
			},
			cancelSubscription,
			inspectSubscriptionCancellation: inspectCancellation,
		};
		const adapter = adapterForFixture({ ...fixture, token: `older-${fixture.token}` });
		const dependencies = {
			client,
			adapter: () => adapter,
			getProvider: () => provider,
			environment: { PAYPAL_ENVIRONMENT: "sandbox" },
		};
		const older = await refundAdminOrder(
			{
				scope: platform,
				orderNo: `plan:${olderPeriod.id}`,
				actorId: "isolated-admin",
				cancelSubscription: true,
			},
			dependencies,
		);
		expect(older).toMatchObject({
			status: "SUCCEEDED",
			cancellation: {
				policyRequired: false,
				status: "FAILED",
				error: "REFUND_TERMINATION_CONFIRMATION_PENDING",
			},
		});
		expect(cancelSubscription).toHaveBeenCalledTimes(1);
		expect(
			await client.subscription.findUnique({ where: { id: fixture.subscription.id } }),
		).toMatchObject({
			status: "ACTIVE",
			refundTerminatedAt: null,
			renewalDisabledAt: null,
		});
		inspectCancellation.mockResolvedValue("DISABLED");
		const recovered = await reconcileAdminRefund(
			{
				scope: platform,
				requestId: older.requestId,
				actorId: "isolated-admin",
			},
			dependencies,
		);
		expect(recovered.cancellation).toMatchObject({
			policyRequired: false,
			status: "SUCCEEDED",
			error: null,
		});
		expect(adapter.submit).toHaveBeenCalledTimes(1);
		expect(adapter.inspect).not.toHaveBeenCalled();
		expect(
			await client.subscription.findUnique({ where: { id: fixture.subscription.id } }),
		).toMatchObject({
			status: "CANCELED",
			refundTerminatedAt: expect.any(Date),
		});
		expect((await getCreditInvariantReport(fixture.account.id, client)).valid).toBe(true);
	});
});
