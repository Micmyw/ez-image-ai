import { PrismaPg } from "@prisma/adapter-pg";
import { createCreditGrant, reserveCreditsInTransaction, type Prisma } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyCreditPackRefundFact } from "../../../payments/provider/credit-pack-reducer";
import { applyProviderRefundFact } from "../../../payments/provider/refund-reducer";
import { applyStripeBillingFact } from "../../../payments/provider/stripe/reducer";

const runId = `paid-refund-lock-${crypto.randomUUID()}`;
const funding = { minimumUsdMicrosPerCredit: 21_944n };
const now = new Date();
const before = new Date(now.getTime() - 86_400_000);
const after = new Date(now.getTime() + 30 * 86_400_000);
type Kind = "pack" | "subscription" | "stripe";

function isolatedDatabase() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("EXPLICIT_ISOLATED_REFUND_TEST_DATABASE_REQUIRED");
	const url = new URL(value);
	const standardTest =
		url.port === "55432" &&
		(url.pathname === "/ai_media_foundation_test" ||
			/^\/ezpic_[a-z0-9_]+_test$/.test(url.pathname));
	const videoTest =
		url.port === "55439" &&
		value === process.env.VIDEO_VERIFICATION_DATABASE_URL &&
		/^\/ezpic_video_v1_(?:review|final)_test$/.test(url.pathname);
	if (url.hostname !== "127.0.0.1" || (!standardTest && !videoTest))
		throw new Error("UNSAFE_PAID_FUNDING_REFUND_TEST_DATABASE");
	return value;
}

describe("paid funding refund account-lock serialization", () => {
	let client: PrismaClient;
	const owners: string[] = [];
	const plans: string[] = [];
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: isolatedDatabase(), max: 6 }),
		});
	});
	afterAll(async () => {
		if (!client) return;
		await client.$transaction(
			async (tx) => {
				const accounts = await tx.creditAccount.findMany({
					where: { ownerId: { in: owners } },
					select: { id: true },
				});
				const accountIds = accounts.map((row) => row.id);
				const subscriptions = await tx.subscription.findMany({
					where: { ownerId: { in: owners } },
					select: { id: true },
				});
				const subscriptionIds = subscriptions.map((row) => row.id);
				const packs = await tx.creditPackFulfillment.findMany({
					where: { ownerId: { in: owners } },
					select: { id: true },
				});
				const packIds = packs.map((row) => row.id);
				const packAdjustments = await tx.creditPackAdjustment.findMany({
					where: { fulfillmentId: { in: packIds } },
					select: { id: true },
				});
				const subscriptionAdjustments = await tx.subscriptionPaymentAdjustment.findMany({
					where: { subscriptionId: { in: subscriptionIds } },
					select: { id: true },
				});
				await tx.auditLog.deleteMany({
					where: {
						targetId: {
							in: [
								...packIds,
								...subscriptionIds,
								...packAdjustments.map((row) => row.id),
								...subscriptionAdjustments.map((row) => row.id),
							],
						},
					},
				});
				await tx.outboxEvent.deleteMany({
					where: {
						aggregateId: {
							in: [...subscriptionIds, ...packIds, ...packAdjustments.map((row) => row.id)],
						},
					},
				});
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
				await tx.generationJob.deleteMany({ where: { ownerId: { in: owners } } });
				await tx.generationQuote.deleteMany({ where: { ownerId: { in: owners } } });
				await tx.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
				await tx.creditPackAdjustment.deleteMany({ where: { fulfillmentId: { in: packIds } } });
				await tx.creditPackFulfillment.deleteMany({ where: { id: { in: packIds } } });
				await tx.subscriptionPaymentAdjustment.deleteMany({
					where: { subscriptionId: { in: subscriptionIds } },
				});
				await tx.billingPeriod.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
				await tx.subscription.deleteMany({ where: { id: { in: subscriptionIds } } });
				await tx.stripeRefund.deleteMany({ where: { providerRefundId: { startsWith: runId } } });
				await tx.paymentCheckoutIntent.deleteMany({ where: { ownerId: { in: owners } } });
				await tx.billingPlan.deleteMany({ where: { id: { in: plans } } });
			},
			{ timeout: 15_000 },
		);
		await client.$disconnect();
	});

	async function fixture(kind: Kind) {
		const id = `${runId}-${kind}-${crypto.randomUUID()}`;
		const ownerId = id;
		owners.push(ownerId);
		const provider = kind === "stripe" ? "stripe" : "paypal";
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const plan = await client.billingPlan.create({
			data: {
				provider,
				providerPriceId: id,
				name: "isolated-refund-lock-test",
				productKind: kind === "pack" ? "CREDIT_PACK" : "PLAN",
				creditsPerPeriod: 100n,
				priceMicros: 2_210_000n,
				currency: "USD",
				metadata: { interval: "month" },
			},
		});
		plans.push(plan.id);
		const grantReferenceKey =
			kind === "pack"
				? `credit-pack:${id}:grant:v1`
				: kind === "stripe"
					? `stripe-invoice:${id}:period:0:grant`
					: `paypal-payment:${id}:period:0:grant`;
		let periodId: string | undefined;
		let packId: string | undefined;
		if (kind === "pack") {
			const intent = await client.paymentCheckoutIntent.create({
				data: {
					provider,
					ownerType: "USER",
					ownerId,
					submittedByUserId: ownerId,
					productKind: "CREDIT_PACK",
					billingPlanId: plan.id,
					planKey: id,
					interval: "one-time",
					idempotencyKey: id,
					status: "COMPLETED",
					creditPackCatalogVersion: "isolated-refund-lock-test",
					creditPackPricingVersion: "isolated-refund-lock-test",
					creditPackSubscriberEligibilityVersion: "isolated-refund-lock-test",
					creditPackBaseCredits: 100n,
					creditPackBonusCredits: 0n,
					creditPackTotalCredits: 100n,
					creditPackExpiryMonths: 6,
					creditPackSubscriberBonusEligible: false,
					creditPackEligibilityEvaluatedAt: before,
				},
			});
			const pack = await client.creditPackFulfillment.create({
				data: {
					checkoutIntentId: intent.id,
					billingPlanId: plan.id,
					ownerType: "USER",
					ownerId,
					provider,
					providerOrderId: id,
					providerPaymentId: id,
					paidAmountMicros: 2_210_000n,
					currency: "USD",
					baseCredits: 100n,
					bonusCredits: 0n,
					grantedCredits: 100n,
					grantReferenceKey,
					paidAt: before,
					expiresAt: after,
				},
			});
			packId = pack.id;
		} else {
			const subscription = await client.subscription.create({
				data: {
					ownerType: "USER",
					ownerId,
					provider,
					providerSubscriptionId: id,
					planId: plan.id,
					status: "ACTIVE",
					currentPeriodStart: before,
					currentPeriodEnd: after,
				},
			});
			const period = await client.billingPeriod.create({
				data: {
					subscriptionId: subscription.id,
					startsAt: before,
					endsAt: after,
					status: "ACTIVE",
					creditAmount: 100n,
					grantReferenceKey,
					providerInvoiceId: id,
					providerInvoicePaymentId: `${provider}:${id}`,
					providerChargeId: kind === "stripe" ? id : null,
					paidAmount: kind === "stripe" ? 221n : 2_210_000n,
				},
			});
			periodId = period.id;
		}
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: grantReferenceKey, expiresAt: after },
			client,
		);
		const refund = async (tx: Prisma.TransactionClient, ordinal: number) => {
			if (kind === "stripe")
				return applyStripeBillingFact(
					{
						kind: "REFUND",
						providerRefundId: `${id}-refund-${ordinal}`,
						providerChargeId: id,
						providerPaymentIntentId: null,
						amount: 1n,
						currency: "usd",
						status: "SUCCEEDED",
						providerCreatedAt: now,
						context: { origin: "WEBHOOK", changeAt: now, changeId: `${id}-change-${ordinal}` },
					},
					tx,
					{ now },
				);
			const fact = {
				provider: "paypal" as const,
				providerEventId: `${id}-event-${ordinal}`,
				providerRefundId: `${id}-refund-${ordinal}`,
				providerPaymentId: id,
				amountMicros: 10_000n,
				currency: "USD",
				occurredAt: now,
			};
			return kind === "pack"
				? applyCreditPackRefundFact(fact, tx, { now })
				: applyProviderRefundFact(fact, tx, { now });
		};
		await client.$transaction((tx) => refund(tx, 1));
		return { ownerId, accountId: account.id, periodId, packId, refund };
	}

	async function createJob(ownerId: string) {
		const quote = await client.generationQuote.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKey: "isolated-paid-funding-video",
				catalogVersion: "test",
				pricingVersion: "test",
				credits: 1n,
				costMicros: 0n,
				inputSnapshot: {},
				pricingSnapshot: {},
				expiresAt: after,
			},
		});
		return client.generationJob.create({
			data: {
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				quoteId: quote.id,
				idempotencyKey: crypto.randomUUID(),
				productKey: quote.productKey,
				catalogVersion: "test",
				pricingVersion: "test",
				creditsReserved: 1n,
				inputSnapshot: {},
				pricingSnapshot: {},
			},
		});
	}

	it.each<Kind>(["pack", "subscription", "stripe"])(
		"serializes %s monetary-only refunds with paid-credit reservation",
		async (kind) => {
			const data = await fixture(kind);
			const job = await createJob(data.ownerId);
			let release!: () => void;
			let ready!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const locked = new Promise<void>((resolve) => {
				ready = resolve;
			});
			let holderPid = 0;
			const reservation = client.$transaction(
				async (tx) => {
					holderPid = (
						await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
					)[0]!.pid;
					const result = await reserveCreditsInTransaction(
						{
							accountId: data.accountId,
							jobId: job.id,
							amount: 1n,
							referenceKey: `reserve:${job.id}`,
							paidFundingPolicy: funding,
						},
						tx,
					);
					ready();
					await released;
					return result;
				},
				{ timeout: 10_000 },
			);
			await locked;
			let refundPid = 0;
			let completed = false;
			const refund = client
				.$transaction(
					async (tx) => {
						refundPid = (
							await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
						)[0]!.pid;
						return data.refund(tx, 2);
					},
					{ timeout: 10_000 },
				)
				.finally(() => {
					completed = true;
				});
			let blockedByReservation = false;
			try {
				const deadline = Date.now() + 3000;
				while (!completed && Date.now() < deadline) {
					if (refundPid) {
						const rows = await client.$queryRaw<
							Array<{ blocked: boolean }>
						>`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${refundPid}::int)) AS blocked`;
						if (rows[0]!.blocked) {
							blockedByReservation = true;
							break;
						}
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				expect(
					blockedByReservation,
					"monetary-only refund must wait for the paid-credit reservation account lock",
				).toBe(true);
				expect(completed).toBe(false);
			} finally {
				release();
				await Promise.all([reservation, refund]);
			}
			// The second cent changes net funding from $0.022 to $0.0219 per original
			// credit while ceil(100 * refund / 221) remains ONE revoked credit.
			if (data.packId)
				expect(
					await client.creditPackFulfillment.findUniqueOrThrow({ where: { id: data.packId } }),
				).toMatchObject({ refundedAmountMicros: 20_000n, refundedCredits: 1n });
			else
				expect(
					await client.billingPeriod.findUniqueOrThrow({ where: { id: data.periodId } }),
				).toMatchObject({ refundedAmount: kind === "stripe" ? 2n : 20_000n, refundedCredits: 1n });
			const nextJob = await createJob(data.ownerId);
			await expect(
				client.$transaction((tx) =>
					reserveCreditsInTransaction(
						{
							accountId: data.accountId,
							jobId: nextJob.id,
							amount: 1n,
							referenceKey: `reserve:${nextJob.id}`,
							paidFundingPolicy: funding,
						},
						tx,
					),
				),
			).rejects.toThrow("INSUFFICIENT_PAID_CREDITS");
			expect(await client.creditReservation.count({ where: { accountId: data.accountId } })).toBe(
				1,
			);
		},
		20_000,
	);
});
