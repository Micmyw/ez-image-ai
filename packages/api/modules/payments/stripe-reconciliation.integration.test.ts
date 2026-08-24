import { PrismaPg } from "@prisma/adapter-pg";
import { createCreditGrant, getCreditInvariantReport, refundCreditGrant } from "@repo/database";
import { PrismaClient } from "@repo/database/generated-client";
import {
	addUtcBillingMonth,
	reconcileStripeBilling,
	type StripeBillingSource,
	type StripePaidInvoiceFact,
	type StripeRefundFact,
	type StripeSubscriptionFact,
} from "@repo/payments";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function assertSafeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(TEST_DATABASE_URL);
	const port = Number(parsed.port);
	const safeDatabase =
		parsed.pathname === "/ai_media_foundation_test" ||
		/^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (
		parsed.hostname !== "127.0.0.1" ||
		!Number.isInteger(port) ||
		port < 1_024 ||
		port > 65_535 ||
		!safeDatabase
	) {
		throw new Error(
			"TEST_DATABASE_URL must target an explicit high port and a dedicated local ezpic_*_test database",
		);
	}
	return TEST_DATABASE_URL;
}

describe("Stripe external-state reconciliation", () => {
	let client: PrismaClient;

	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: assertSafeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => client?.$disconnect());

	beforeEach(async () => {
		await client.stripeReconciliationIssue.deleteMany({
			where: { provider: "stripe", repairAuthorities: { none: {} } },
		});
		await client.stripeReconciliationCheckpoint.deleteMany({ where: { provider: "stripe" } });
	});

	it("repairs a missing subscription and paid invoice from one fixed-cutoff sweep", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-01T00:00:00.000Z");
		const userId = `reconcile-user-${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Reconciliation fixture",
				email: `reconcile-${suffix}@example.test`,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_${suffix}`,
				name: "creator",
				creditsPerPeriod: 250n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const subscriptionFact = makeSubscriptionFact({
			suffix,
			now,
			userId,
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		const invoiceFact = makeInvoiceFact({ suffix, now, priceId: plan.providerPriceId });
		const refundFact: StripeRefundFact = {
			kind: "REFUND",
			providerRefundId: `re_reconcile_${suffix}`,
			providerChargeId: invoiceFact.providerChargeId,
			providerPaymentIntentId: invoiceFact.providerPaymentIntentId,
			amount: 950n,
			currency: "USD",
			status: "SUCCEEDED",
			providerCreatedAt: now,
			context: {
				origin: "RECONCILIATION",
				changeAt: new Date(now.getTime() + 2_000),
				changeId: `stripe-reconcile:fixture:refund:re_reconcile_${suffix}`,
			},
		};
		const cutoffs: Date[] = [];
		const source = makeSource({
			listSubscriptionsPage: vi.fn(async (input) => {
				cutoffs.push(input.cutoff);
				return { facts: [subscriptionFact], issues: [], hasMore: false, nextCursor: null };
			}),
			listPaidInvoicesPage: vi.fn(async (input) => {
				cutoffs.push(input.cutoff);
				return { facts: [invoiceFact], issues: [], hasMore: false, nextCursor: null };
			}),
			listRefundsPage: vi.fn(async (input) => {
				cutoffs.push(input.cutoff);
				return { facts: [refundFact], issues: [], hasMore: false, nextCursor: null };
			}),
		});

		await expect(
			reconcileStripeBilling({ now, pageSize: 10, maxPages: 3 }, client, source),
		).resolves.toMatchObject({ completed: true, pagesProcessed: 3 });
		expect(cutoffs).toHaveLength(3);
		expect(new Set(cutoffs.map((value) => value.toISOString()))).toEqual(
			new Set([now.toISOString()]),
		);
		const subscription = await client.subscription.findUniqueOrThrow({
			where: { providerSubscriptionId: subscriptionFact.providerSubscriptionId },
		});
		expect(subscription).toMatchObject({ ownerId: userId, status: "ACTIVE" });
		const period = await client.billingPeriod.findFirstOrThrow({
			where: { providerInvoiceId: invoiceFact.providerInvoiceId },
		});
		expect(period).toMatchObject({
			providerChargeId: invoiceFact.providerChargeId,
			creditAmount: 250n,
			refundedAmount: 950n,
			refundedCredits: 125n,
		});
		const ledgerCount = await client.creditLedgerEntry.count({
			where: { account: { ownerId: userId } },
		});
		await expect(
			reconcileStripeBilling(
				{ now: new Date(now.getTime() + 24 * 60 * 60_000), pageSize: 10, maxPages: 3 },
				client,
				source,
			),
		).resolves.toMatchObject({ completed: true });
		expect(
			await client.billingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
		).toMatchObject({ refundedAmount: 950n, refundedCredits: 125n });
		expect(await client.creditLedgerEntry.count({ where: { account: { ownerId: userId } } })).toBe(
			ledgerCount,
		);
	});

	it("records legacy refund pollution for human repair instead of aborting reconciliation", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-01T00:00:00.000Z");
		const ownerId = `reconcile-legacy-refund-owner-${suffix}`;
		const chargeId = `ch_reconcile_legacy_refund_${suffix}`;
		const legacyRefundId = `re_reconcile_legacy_pollution_${suffix}`;
		const currentRefundId = legacyRefundId;
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_legacy_refund_${suffix}`,
				name: "legacy refund reconciliation fixture",
				creditsPerPeriod: 100n,
				priceMicros: 10_000_000n,
				currency: "USD",
				metadata: { planId: "legacy-refund-reconcile", interval: "month", version: 1 },
			},
		});
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_reconcile_legacy_refund_${suffix}`,
				planId: plan.id,
				status: "ACTIVE",
			},
		});
		const period = await client.billingPeriod.create({
			data: {
				subscriptionId: subscription.id,
				startsAt: new Date("2027-01-01T00:00:00.000Z"),
				endsAt: new Date("2027-02-01T00:00:00.000Z"),
				status: "ACTIVE",
				creditAmount: 100n,
				grantReferenceKey: `reconcile-legacy-refund-grant:${suffix}`,
				providerInvoiceId: `in_reconcile_legacy_refund_${suffix}`,
				providerInvoicePaymentId: `inpay_reconcile_legacy_refund_${suffix}`,
				providerChargeId: chargeId,
				paidAmount: 1_000n,
				refundedAmount: 500n,
				refundedCredits: 50n,
			},
		});
		await client.creditLedgerEntry.create({
			data: {
				accountId: account.id,
				type: "REFUND",
				amount: 50n,
				referenceKey: `stripe-refund:${legacyRefundId}:${period.id}`,
				metadata: {
					providerRefundId: legacyRefundId,
					providerChargeId: chargeId,
					billingPeriodId: period.id,
				},
			},
		});
		const refundFact: StripeRefundFact = {
			kind: "REFUND",
			providerRefundId: currentRefundId,
			providerChargeId: chargeId,
			providerPaymentIntentId: null,
			amount: 500n,
			currency: "USD",
			status: "SUCCEEDED",
			providerCreatedAt: now,
			context: {
				origin: "RECONCILIATION",
				changeAt: now,
				changeId: `stripe-reconcile:legacy-refund:${currentRefundId}`,
			},
		};

		const result = await reconcileStripeBilling(
			{ now, maxPages: 3 },
			client,
			makeSource({
				listRefundsPage: vi.fn().mockResolvedValue({
					facts: [refundFact],
					issues: [],
					hasMore: false,
					nextCursor: null,
				}),
			}),
		);
		expect(result).toMatchObject({ completed: true });
		expect(result.issues).toBeGreaterThanOrEqual(1);
		await expect(
			client.stripeReconciliationIssue.findFirstOrThrow({
				where: { provider: "stripe", providerObjectId: currentRefundId },
			}),
		).resolves.toMatchObject({
			code: "STRIPE_LEGACY_REFUND_REPAIR_REQUIRED",
			entityType: "REFUND",
		});
		await expect(
			client.stripeRefund.findFirstOrThrow({
				where: { provider: "stripe", providerRefundId: currentRefundId },
			}),
		).resolves.toMatchObject({
			status: "SUCCEEDED",
			finalizedCredits: 0n,
			creditsFinalizedAt: null,
		});
		await expect(
			client.billingPeriod.findUniqueOrThrow({ where: { id: period.id } }),
		).resolves.toMatchObject({ refundedAmount: 500n, refundedCredits: 50n });
	});

	it("records current-provider conflicts instead of silently accepting incompatible terminal state", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-01T00:00:00.000Z");
		const userId = `terminal-conflict-user-${suffix}`;
		const customerId = `cus_terminal_conflict_${suffix}`;
		const providerSubscriptionId = `sub_reconcile_${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Terminal conflict fixture",
				email: `terminal-conflict-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: now,
				updatedAt: now,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_terminal_conflict_${suffix}`,
				name: "creator",
				creditsPerPeriod: 250n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: plan.providerPriceId,
				status: "canceled",
			},
		});
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: userId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "CANCELED",
				cancelAtPeriodEnd: true,
				lastProviderEventAt: new Date(now.getTime() - 1_000),
				lastProviderEventId: `evt_local_canceled_${suffix}`,
			},
		});
		const subscriptionFact = makeSubscriptionFact({
			suffix,
			now,
			userId,
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		subscriptionFact.customerId = customerId;
		const providerRefundId = `re_terminal_conflict_${suffix}`;
		const providerChargeId = `ch_terminal_conflict_${suffix}`;
		await client.stripeRefund.create({
			data: {
				provider: "stripe",
				providerRefundId,
				providerChargeId,
				amount: 500n,
				currency: "USD",
				status: "FAILED",
				providerCreatedAt: new Date(now.getTime() - 2_000),
				lastProviderChangeAt: new Date(now.getTime() - 1_000),
				lastProviderChangeId: `evt_local_refund_failed_${suffix}`,
			},
		});
		const refundFact: StripeRefundFact = {
			kind: "REFUND",
			providerRefundId,
			providerChargeId,
			providerPaymentIntentId: null,
			amount: 500n,
			currency: "USD",
			status: "SUCCEEDED",
			providerCreatedAt: new Date(now.getTime() - 2_000),
			context: {
				origin: "RECONCILIATION",
				changeAt: now,
				changeId: `stripe-reconcile:terminal-conflict:refund:${providerRefundId}`,
			},
		};

		await expect(
			reconcileStripeBilling(
				{ now, maxPages: 3 },
				client,
				makeSource({
					listSubscriptionsPage: vi.fn().mockResolvedValue({
						facts: [subscriptionFact],
						issues: [],
						hasMore: false,
						nextCursor: null,
					}),
					listRefundsPage: vi.fn().mockResolvedValue({
						facts: [refundFact],
						issues: [],
						hasMore: false,
						nextCursor: null,
					}),
				}),
			),
		).resolves.toMatchObject({ completed: true });
		await expect(
			client.subscription.findUniqueOrThrow({ where: { providerSubscriptionId } }),
		).resolves.toMatchObject({ status: "CANCELED" });
		await expect(
			client.stripeRefund.findUniqueOrThrow({
				where: { provider_providerRefundId: { provider: "stripe", providerRefundId } },
			}),
		).resolves.toMatchObject({ status: "FAILED" });
		const issues = await client.stripeReconciliationIssue.findMany({
			where: {
				provider: "stripe",
				providerObjectId: { in: [providerSubscriptionId, providerRefundId] },
			},
			select: { code: true },
		});
		expect(new Set(issues.map((issue) => issue.code))).toEqual(
			new Set(["STRIPE_SUBSCRIPTION_TERMINAL_CONFLICT", "STRIPE_REFUND_TERMINAL_CONFLICT"]),
		);
	});

	it("persists a cursor after a page and resumes the same sweep after a sanitized source failure", async () => {
		const now = new Date("2027-02-02T00:00:00.000Z");
		let fail = true;
		const calls: Array<{ cutoff: string; cursor: string | null; sweepId: string }> = [];
		const source = makeSource({
			listSubscriptionsPage: vi.fn(async (input) => {
				calls.push({
					cutoff: input.cutoff.toISOString(),
					cursor: input.cursor,
					sweepId: input.sweepId,
				});
				if (input.cursor === null) {
					return { facts: [], issues: [], hasMore: true, nextCursor: "sub_cursor_1" };
				}
				if (fail) {
					fail = false;
					throw new Error("provider response containing secret-token");
				}
				return { facts: [], issues: [], hasMore: false, nextCursor: null };
			}),
		});

		await expect(
			reconcileStripeBilling({ now, pageSize: 10, maxPages: 2 }, client, source),
		).rejects.toThrow("STRIPE_RECONCILIATION_SOURCE_FAILURE");
		const failed = await client.stripeReconciliationCheckpoint.findUniqueOrThrow({
			where: { provider: "stripe" },
		});
		expect(failed).toMatchObject({
			status: "RUNNING",
			cursor: "sub_cursor_1",
			lastErrorCode: "STRIPE_RECONCILIATION_SOURCE_FAILURE",
		});
		expect(JSON.stringify(failed)).not.toContain("secret-token");

		await expect(
			reconcileStripeBilling(
				{ now: new Date("2027-02-02T00:10:00.000Z"), pageSize: 10, maxPages: 3 },
				client,
				source,
			),
		).resolves.toMatchObject({ completed: true });
		expect(new Set(calls.map((call) => call.cutoff))).toEqual(new Set([now.toISOString()]));
		expect(new Set(calls.map((call) => call.sweepId)).size).toBe(1);
	});

	it("persists monotonic continuations and replays only the already-issued continuation", async () => {
		const cutoff = new Date("2027-02-02T01:00:00.000Z");
		const calls: Array<{ cutoff: string; cursor: string | null; stage: string }> = [];
		const source = makeSource({
			listSubscriptionsPage: vi.fn(async (input) => {
				calls.push({
					cutoff: input.cutoff.toISOString(),
					cursor: input.cursor,
					stage: "subscriptions",
				});
				return input.cursor === null
					? { facts: [], issues: [], hasMore: true, nextCursor: "sub_cursor_next" }
					: { facts: [], issues: [], hasMore: false, nextCursor: null };
			}),
			listPaidInvoicesPage: vi.fn(async (input) => {
				calls.push({ cutoff: input.cutoff.toISOString(), cursor: input.cursor, stage: "invoices" });
				return { facts: [], issues: [], hasMore: false, nextCursor: null };
			}),
			listRefundsPage: vi.fn(async (input) => {
				calls.push({ cutoff: input.cutoff.toISOString(), cursor: input.cursor, stage: "refunds" });
				return { facts: [], issues: [], hasMore: false, nextCursor: null };
			}),
		});

		const first = await reconcileStripeBilling(
			{ now: cutoff, pageSize: 10, maxPages: 1, continuationSequence: 0 },
			client,
			source,
		);
		expect(first).toMatchObject({
			completed: false,
			continuationSequence: 1,
			continuationKey: expect.stringMatching(/:continuation:1$/),
		});
		if (first.skipped || first.completed) throw new Error("expected a persisted continuation");
		const afterFirst = await client.stripeReconciliationCheckpoint.findUniqueOrThrow({
			where: { provider: "stripe" },
		});
		expect(afterFirst).toMatchObject({
			continuationSequence: 1,
			cursor: "sub_cursor_next",
			sweepCutoff: cutoff,
		});

		const replay = await reconcileStripeBilling(
			{
				now: new Date(cutoff.getTime() + 60_000),
				expectedSweepId: first.sweepId,
				continuationSequence: 0,
				maxPages: 1,
			},
			client,
			source,
		);
		expect(replay).toMatchObject({
			completed: false,
			pagesProcessed: 0,
			continuationKey: first.continuationKey,
			continuationSequence: 1,
			sweepId: first.sweepId,
		});
		expect(calls).toHaveLength(1);

		const second = await reconcileStripeBilling(
			{
				now: new Date(cutoff.getTime() + 120_000),
				expectedSweepId: first.sweepId,
				continuationSequence: 1,
				maxPages: 1,
			},
			client,
			source,
		);
		expect(second).toMatchObject({
			completed: false,
			continuationSequence: 2,
			continuationKey: expect.stringMatching(/:continuation:2$/),
			sweepId: first.sweepId,
		});
		expect(calls).toHaveLength(2);

		const secondReplay = await reconcileStripeBilling(
			{
				now: new Date(cutoff.getTime() + 180_000),
				expectedSweepId: first.sweepId,
				continuationSequence: 1,
				maxPages: 1,
			},
			client,
			source,
		);
		expect(secondReplay).toMatchObject({
			continuationKey: second.skipped || second.completed ? undefined : second.continuationKey,
			continuationSequence: 2,
			pagesProcessed: 0,
		});
		expect(calls).toHaveLength(2);

		await expect(
			reconcileStripeBilling(
				{
					now: new Date(cutoff.getTime() + 240_000),
					expectedSweepId: first.sweepId,
					continuationSequence: 2,
					maxPages: 2,
				},
				client,
				source,
			),
		).resolves.toMatchObject({ completed: true, sweepId: first.sweepId });
		expect(new Set(calls.map((call) => call.cutoff))).toEqual(new Set([cutoff.toISOString()]));
		expect(calls.map((call) => call.stage)).toEqual([
			"subscriptions",
			"subscriptions",
			"invoices",
			"refunds",
		]);
	});

	it("records an allowlisted needs-review issue and continues past an ambiguous binding", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-03T00:00:00.000Z");
		const fact = makeSubscriptionFact({
			suffix,
			now,
			userId: `missing-${suffix}`,
			planId: `missing-plan-${suffix}`,
			priceId: `missing-price-${suffix}`,
		});
		fact.binding = null;
		const source = makeSource({
			listSubscriptionsPage: vi.fn().mockResolvedValue({
				facts: [fact],
				issues: [],
				hasMore: false,
				nextCursor: null,
			}),
		});

		await expect(
			reconcileStripeBilling({ now, maxPages: 3 }, client, source),
		).resolves.toMatchObject({ completed: true });
		const issue = await client.stripeReconciliationIssue.findFirstOrThrow({
			where: { providerObjectId: fact.providerSubscriptionId },
		});
		expect(issue).toMatchObject({
			status: "OPEN",
			code: "STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS",
			entityType: "SUBSCRIPTION",
		});
		expect(JSON.stringify(issue.details)).toMatch(
			/^\{"factKind":"SUBSCRIPTION","providerObjectId":"[a-zA-Z0-9_-]+"\}$/,
		);
	});

	it("does not mark a needs-review subscription as safe for local entitlement expiry", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-03T01:00:00.000Z");
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_blocked_${suffix}`,
				name: "blocked reconciliation fixture",
				creditsPerPeriod: 100n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const fact = makeSubscriptionFact({
			suffix: `blocked_${suffix}`,
			now,
			userId: `blocked-owner-${suffix}`,
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		fact.binding = null;
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: `blocked-owner-${suffix}`,
				provider: "stripe",
				providerSubscriptionId: fact.providerSubscriptionId,
				planId: plan.id,
				status: "PAST_DUE",
				graceEndsAt: new Date(now.getTime() - 1_000),
				createdAt: new Date(now.getTime() - 60_000),
			},
		});
		const result = await reconcileStripeBilling(
			{ now, maxPages: 3 },
			client,
			makeSource({
				listSubscriptionsPage: vi.fn().mockResolvedValue({
					facts: [fact],
					issues: [],
					hasMore: false,
					nextCursor: null,
				}),
			}),
		);

		expect(result).toMatchObject({ completed: true });
		expect(result.issues).toBeGreaterThanOrEqual(1);
		if (result.skipped) throw new Error("Expected the reconciliation sweep to complete");
		await expect(
			client.subscription.findUniqueOrThrow({
				where: { providerSubscriptionId: fact.providerSubscriptionId },
			}),
		).resolves.toMatchObject({
			status: "PAST_DUE",
			lastReconciliationSweepId: result.sweepId,
			lastReconciliationAppliedSweepId: null,
			lastReconciledAt: null,
		});
	});

	it("lets only one active checkpoint lease call the source", async () => {
		const now = new Date("2027-02-04T00:00:00.000Z");
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const sourceEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const listSubscriptionsPage = vi.fn(async () => {
			entered();
			await blocked;
			return { facts: [], issues: [], hasMore: false, nextCursor: null };
		});
		const source = makeSource({ listSubscriptionsPage });

		const first = reconcileStripeBilling({ now, maxPages: 1 }, client, source);
		await sourceEntered;
		await expect(
			reconcileStripeBilling({ now: new Date(now.getTime() + 1_000), maxPages: 1 }, client, source),
		).resolves.toMatchObject({ skipped: true, reason: "LEASE_ACTIVE" });
		release();
		await expect(first).resolves.toMatchObject({ completed: false, pagesProcessed: 1 });
		expect(listSubscriptionsPage).toHaveBeenCalledTimes(1);
	});

	it("does not apply a page after the production lease expires while the source is loading", async () => {
		const suffix = crypto.randomUUID();
		const startedAt = new Date("2027-02-05T00:00:00.000Z");
		const userId = `reconcile-expired-user-${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Expired lease fixture",
				email: `reconcile-expired-${suffix}@example.test`,
				emailVerified: true,
				createdAt: startedAt,
				updatedAt: startedAt,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_expired_${suffix}`,
				name: "creator",
				creditsPerPeriod: 250n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const fact = makeSubscriptionFact({
			suffix,
			now: startedAt,
			userId,
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		const source = makeSource({
			listSubscriptionsPage: vi.fn(async () => {
				vi.setSystemTime(new Date(startedAt.getTime() + 31_000));
				return { facts: [fact], issues: [], hasMore: false, nextCursor: null };
			}),
		});

		vi.useFakeTimers();
		vi.setSystemTime(startedAt);
		try {
			await expect(
				reconcileStripeBilling({ leaseSeconds: 30, maxPages: 1 }, client, source),
			).rejects.toThrow("STRIPE_RECONCILIATION_LEASE_LOST");
			expect(
				await client.subscription.findUnique({
					where: { providerSubscriptionId: fact.providerSubscriptionId },
				}),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("revalidates the checkpoint lease inside every fact transaction", async () => {
		const suffix = crypto.randomUUID();
		const startedAt = new Date("2027-02-05T01:00:00.000Z");
		const userIds = [
			`reconcile-fenced-user-a-${suffix}`,
			`reconcile-fenced-user-b-${suffix}`,
		] as const;
		await client.user.createMany({
			data: userIds.map((userId, index) => ({
				id: userId,
				name: `Fact fence fixture ${index}`,
				email: `reconcile-fenced-${index}-${suffix}@example.test`,
				emailVerified: true,
				createdAt: startedAt,
				updatedAt: startedAt,
			})),
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_fenced_${suffix}`,
				name: "creator",
				creditsPerPeriod: 250n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const firstFact = makeSubscriptionFact({
			suffix: `a_${suffix}`,
			now: startedAt,
			userId: userIds[0],
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		const secondFact = makeSubscriptionFact({
			suffix: `b_${suffix}`,
			now: startedAt,
			userId: userIds[1],
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		const facts = {
			*[Symbol.iterator]() {
				yield firstFact;
				vi.setSystemTime(new Date(startedAt.getTime() + 31_000));
				yield secondFact;
			},
		} as unknown as StripeSubscriptionFact[];
		const source = makeSource({
			listSubscriptionsPage: vi
				.fn()
				.mockResolvedValue({ facts, issues: [], hasMore: false, nextCursor: null }),
		});

		vi.useFakeTimers();
		vi.setSystemTime(startedAt);
		try {
			await expect(
				reconcileStripeBilling({ leaseSeconds: 30, maxPages: 1 }, client, source),
			).rejects.toThrow("STRIPE_RECONCILIATION_LEASE_LOST");
			expect(
				await client.subscription.findUnique({
					where: { providerSubscriptionId: firstFact.providerSubscriptionId },
				}),
			).not.toBeNull();
			expect(
				await client.subscription.findUnique({
					where: { providerSubscriptionId: secondFact.providerSubscriptionId },
				}),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists safe source-object issues and advances the page cursor", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-02-06T00:00:00.000Z");
		const providerObjectId = `sub_source_issue_${suffix}`;
		const source = makeSource({
			listSubscriptionsPage: vi.fn().mockResolvedValue({
				facts: [],
				issues: [
					{
						code: "STRIPE_SUBSCRIPTION_ITEM_AMBIGUOUS",
						entityType: "SUBSCRIPTION",
						providerObjectId,
					},
				],
				hasMore: true,
				nextCursor: "sub_source_issue_cursor",
			}),
		});

		const result = await reconcileStripeBilling({ now, maxPages: 1 }, client, source);
		expect(result).toMatchObject({ completed: false, pagesProcessed: 1 });
		expect(result.issues).toBeGreaterThanOrEqual(1);
		const issue = await client.stripeReconciliationIssue.findUniqueOrThrow({
			where: {
				issueKey: `stripe:SUBSCRIPTION:${providerObjectId}:STRIPE_SUBSCRIPTION_ITEM_AMBIGUOUS`,
			},
		});
		expect(issue).toMatchObject({
			provider: "stripe",
			stage: "SUBSCRIPTIONS",
			code: "STRIPE_SUBSCRIPTION_ITEM_AMBIGUOUS",
			entityType: "SUBSCRIPTION",
			providerObjectId,
			status: "OPEN",
		});
		expect(JSON.stringify(issue.details)).toBe(`{"providerObjectId":"${providerObjectId}"}`);
		expect(
			await client.stripeReconciliationCheckpoint.findUniqueOrThrow({
				where: { provider: "stripe" },
			}),
		).toMatchObject({ stage: "SUBSCRIPTIONS", cursor: "sub_source_issue_cursor" });
	});

	it("reports a local live subscription missing from Stripe and resolves only that issue when seen", async () => {
		const suffix = crypto.randomUUID();
		const firstSweepAt = new Date("2027-02-07T00:00:00.000Z");
		const userId = `reconcile-missing-user-${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Missing subscription fixture",
				email: `reconcile-missing-${suffix}@example.test`,
				emailVerified: true,
				createdAt: firstSweepAt,
				updatedAt: firstSweepAt,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_missing_${suffix}`,
				name: "creator",
				creditsPerPeriod: 250n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator", interval: "month", version: 1 },
			},
		});
		const fact = makeSubscriptionFact({
			suffix,
			now: firstSweepAt,
			userId,
			planId: plan.id,
			priceId: plan.providerPriceId,
		});
		const seenSource = makeSource({
			listSubscriptionsPage: vi.fn().mockResolvedValue({
				facts: [fact],
				issues: [],
				hasMore: false,
				nextCursor: null,
			}),
		});
		await reconcileStripeBilling({ now: firstSweepAt, maxPages: 3 }, client, seenSource);
		await client.subscription.update({
			where: { providerSubscriptionId: fact.providerSubscriptionId },
			data: { createdAt: new Date("2026-12-31T00:00:00.000Z") },
		});

		const missingSweepAt = new Date("2027-02-08T00:00:00.000Z");
		await reconcileStripeBilling({ now: missingSweepAt, maxPages: 3 }, client, makeSource());
		const missingIssueKey = `stripe:SUBSCRIPTION:${fact.providerSubscriptionId}:STRIPE_SUBSCRIPTION_MISSING_FROM_PROVIDER`;
		expect(
			await client.stripeReconciliationIssue.findUniqueOrThrow({
				where: { issueKey: missingIssueKey },
			}),
		).toMatchObject({ status: "OPEN", code: "STRIPE_SUBSCRIPTION_MISSING_FROM_PROVIDER" });
		expect(
			await client.subscription.findUniqueOrThrow({
				where: { providerSubscriptionId: fact.providerSubscriptionId },
			}),
		).toMatchObject({ status: "ACTIVE" });
		const independentIssueKey = `stripe:SUBSCRIPTION:${fact.providerSubscriptionId}:STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS`;
		await client.stripeReconciliationIssue.create({
			data: {
				issueKey: independentIssueKey,
				provider: "stripe",
				sweepId: crypto.randomUUID(),
				stage: "SUBSCRIPTIONS",
				code: "STRIPE_SUBSCRIPTION_BINDING_AMBIGUOUS",
				entityType: "SUBSCRIPTION",
				providerObjectId: fact.providerSubscriptionId,
				details: { providerObjectId: fact.providerSubscriptionId },
				lastSeenAt: missingSweepAt,
			},
		});

		const recoveredAt = new Date("2027-02-09T00:00:00.000Z");
		fact.context = {
			origin: "RECONCILIATION",
			changeAt: recoveredAt,
			changeId: `stripe-reconcile:fixture:recovered:${fact.providerSubscriptionId}`,
		};
		await reconcileStripeBilling({ now: recoveredAt, maxPages: 3 }, client, seenSource);
		expect(
			await client.stripeReconciliationIssue.findUniqueOrThrow({
				where: { issueKey: missingIssueKey },
			}),
		).toMatchObject({ status: "RESOLVED", resolvedAt: recoveredAt });
		expect(
			await client.stripeReconciliationIssue.findUniqueOrThrow({
				where: { issueKey: independentIssueKey },
			}),
		).toMatchObject({ status: "OPEN", resolvedAt: null });
	});

	it("pauses before exceeding an invoice-payment lookup budget independent of page size", async () => {
		const now = new Date("2027-02-10T00:00:00.000Z");
		const listPaidInvoicesPage = vi
			.fn()
			.mockResolvedValueOnce({
				facts: [],
				issues: [
					{
						code: "STRIPE_INVOICE_PAYMENT_AMBIGUOUS",
						entityType: "INVOICE",
						providerObjectId: "in_budget_1",
					},
				],
				hasMore: true,
				nextCursor: "in_budget_1",
			})
			.mockResolvedValueOnce({
				facts: [],
				issues: [
					{
						code: "STRIPE_INVOICE_PAYMENT_AMBIGUOUS",
						entityType: "INVOICE",
						providerObjectId: "in_budget_2",
					},
				],
				hasMore: true,
				nextCursor: "in_budget_2",
			})
			.mockResolvedValueOnce({ facts: [], issues: [], hasMore: false, nextCursor: null });
		const listRefundsPage = vi
			.fn()
			.mockResolvedValue({ facts: [], issues: [], hasMore: false, nextCursor: null });
		const input = {
			now,
			pageSize: 100,
			maxPages: 10,
			maxInvoicePaymentLookups: 2,
		};

		await expect(
			reconcileStripeBilling(input, client, makeSource({ listPaidInvoicesPage, listRefundsPage })),
		).resolves.toMatchObject({ completed: false, pagesProcessed: 3 });
		expect(listPaidInvoicesPage).toHaveBeenCalledTimes(2);
		expect(listPaidInvoicesPage.mock.calls.map(([input]) => input.limit)).toEqual([1, 1]);
		expect(listRefundsPage).not.toHaveBeenCalled();
		await expect(
			client.stripeReconciliationCheckpoint.findUniqueOrThrow({ where: { provider: "stripe" } }),
		).resolves.toMatchObject({ stage: "INVOICES", cursor: "in_budget_2", leaseToken: null });
	});

	it("pauses without applying or advancing a page that returns after the run deadline", async () => {
		const startedAt = new Date("2027-02-11T00:00:00.000Z");
		const listSubscriptionsPage = vi.fn(async () => {
			vi.setSystemTime(new Date(startedAt.getTime() + 1_500));
			return { facts: [], issues: [], hasMore: false, nextCursor: null };
		});
		const listPaidInvoicesPage = vi.fn();
		const input = {
			pageSize: 50,
			maxPages: 3,
			leaseSeconds: 30,
			runDeadlineMs: 1_000,
		};

		vi.useFakeTimers();
		vi.setSystemTime(startedAt);
		try {
			await expect(
				reconcileStripeBilling(
					input,
					client,
					makeSource({ listSubscriptionsPage, listPaidInvoicesPage }),
				),
			).resolves.toMatchObject({ completed: false, pagesProcessed: 0 });
			expect(listSubscriptionsPage).toHaveBeenCalledOnce();
			expect(listPaidInvoicesPage).not.toHaveBeenCalled();
			await expect(
				client.stripeReconciliationCheckpoint.findUniqueOrThrow({
					where: { provider: "stripe" },
				}),
			).resolves.toMatchObject({ stage: "SUBSCRIPTIONS", cursor: null, leaseToken: null });
		} finally {
			vi.useRealTimers();
		}
	});

	it("pauses without recording a source failure when the source exhausts the absolute deadline", async () => {
		const source = makeSource({
			listSubscriptionsPage: vi
				.fn()
				.mockRejectedValue(new Error("STRIPE_RECONCILIATION_RUN_DEADLINE_REACHED")),
		});

		await expect(
			reconcileStripeBilling(
				{ now: new Date("2027-02-01T00:00:00.000Z"), runDeadlineMs: 1_000 },
				client,
				source,
			),
		).resolves.toMatchObject({
			skipped: false,
			completed: false,
			pagesProcessed: 0,
			issues: 0,
		});
		const checkpoint = await client.stripeReconciliationCheckpoint.findUniqueOrThrow({
			where: { provider: "stripe" },
		});
		expect(checkpoint.status).toBe("RUNNING");
		expect(checkpoint.cursor).toBeNull();
		expect(checkpoint.leaseToken).toBeNull();
		expect(checkpoint.lastErrorCode).toBeNull();
	});

	it("recovers an inactive historical-plan invoice without rolling back the current plan", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-03-01T00:00:00.000Z");
		const historicalPeriodStart = new Date("2026-12-01T00:00:00.000Z");
		const userId = `reconcile-history-user-${suffix}`;
		const customerId = `cus_reconcile_history_${suffix}`;
		const providerSubscriptionId = `sub_reconcile_history_${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Historical invoice fixture",
				email: `reconcile-history-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: historicalPeriodStart,
				updatedAt: historicalPeriodStart,
			},
		});
		const creditAccount = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: userId },
		});
		const debtSeedGrantKey = `test-reconcile-history-debt-grant-${suffix}`;
		await createCreditGrant(
			{ accountId: creditAccount.id, amount: 50n, referenceKey: debtSeedGrantKey },
			client,
		);
		await refundCreditGrant(
			{
				accountId: creditAccount.id,
				amount: 100n,
				grantReferenceKey: debtSeedGrantKey,
				referenceKey: `test-reconcile-history-debt-refund-${suffix}`,
			},
			client,
		);
		const [historicalPlan, currentPlan] = await Promise.all([
			client.billingPlan.create({
				data: {
					provider: "stripe",
					providerPriceId: `price_history_a_${suffix}`,
					name: "historical-a",
					creditsPerPeriod: 75n,
					priceMicros: 9_000_000n,
					currency: "USD",
					active: false,
					metadata: { planId: "historical-a", interval: "month", version: 1 },
				},
			}),
			client.billingPlan.create({
				data: {
					provider: "stripe",
					providerPriceId: `price_history_b_${suffix}`,
					name: "current-b",
					creditsPerPeriod: 200n,
					priceMicros: 19_000_000n,
					currency: "USD",
					metadata: { planId: "current-b", interval: "month", version: 1 },
				},
			}),
		]);
		const purchase = await client.purchase.create({
			data: {
				userId,
				type: "SUBSCRIPTION",
				customerId,
				subscriptionId: providerSubscriptionId,
				priceId: currentPlan.providerPriceId,
				status: "active",
			},
		});
		await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: userId,
				provider: "stripe",
				providerSubscriptionId,
				planId: currentPlan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				currentPeriodStart: null,
				currentPeriodEnd: null,
				lastProviderEventAt: new Date("2027-02-15T00:00:00.000Z"),
				lastProviderEventId: `evt_current_plan_${suffix}`,
			},
		});
		const historicalInvoice = makeInvoiceFact({
			suffix: `history_${suffix}`,
			now: historicalPeriodStart,
			priceId: historicalPlan.providerPriceId,
		});
		historicalInvoice.providerSubscriptionId = providerSubscriptionId;
		historicalInvoice.customerId = customerId;
		historicalInvoice.context = {
			origin: "RECONCILIATION",
			changeAt: new Date(historicalPeriodStart.getTime() + 1_000),
			changeId: `stripe-reconcile:history:invoice:${historicalInvoice.providerInvoiceId}`,
		};

		await expect(
			reconcileStripeBilling(
				{ now, maxPages: 3 },
				client,
				makeSource({
					listPaidInvoicesPage: vi.fn().mockResolvedValue({
						facts: [historicalInvoice],
						issues: [],
						hasMore: false,
						nextCursor: null,
					}),
				}),
			),
		).resolves.toMatchObject({ completed: true });
		expect(
			await client.stripeReconciliationIssue.findMany({
				where: { entityType: "INVOICE", providerObjectId: historicalInvoice.providerInvoiceId },
			}),
		).toEqual([]);

		await expect(
			client.billingPeriod.findFirstOrThrow({
				where: { providerInvoiceId: historicalInvoice.providerInvoiceId },
			}),
		).resolves.toMatchObject({ creditAmount: 75n, status: "CLOSED" });
		await expect(
			client.creditLedgerEntry.findUnique({
				where: {
					referenceKey: `stripe-invoice:${historicalInvoice.providerInvoiceId}:period:0:grant`,
				},
			}),
		).resolves.toBeNull();
		await expect(
			client.subscription.findUniqueOrThrow({ where: { providerSubscriptionId } }),
		).resolves.toMatchObject({ planId: currentPlan.id });
		await expect(
			client.purchase.findUniqueOrThrow({ where: { id: purchase.id } }),
		).resolves.toMatchObject({ priceId: currentPlan.providerPriceId, status: "active" });
		await expect(
			client.creditAccount.findUniqueOrThrow({ where: { id: creditAccount.id } }),
		).resolves.toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 50n });
		await expect(getCreditInvariantReport(creditAccount.id, client)).resolves.toMatchObject({
			valid: true,
		});
	});

	it("reviews a shortened annual invoice without creating twelve months of entitlement", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-04-15T00:00:00.000Z");
		const periodStart = new Date("2027-04-01T00:00:00.000Z");
		const periodEnd = new Date("2027-05-01T00:00:00.000Z");
		const userId = `reconcile-proration-user-${suffix}`;
		const customerId = `cus_reconcile_proration_${suffix}`;
		const providerSubscriptionId = `sub_reconcile_proration_${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Annual proration fixture",
				email: `reconcile-proration-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: periodStart,
				updatedAt: periodStart,
			},
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_proration_${suffix}`,
				name: "annual-proration",
				creditsPerPeriod: 500n,
				priceMicros: 79_000_000n,
				currency: "USD",
				metadata: { planId: "annual-proration", interval: "year", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId,
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
				ownerId: userId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				currentPeriodStart: periodStart,
				currentPeriodEnd: periodEnd,
			},
		});
		const invoice = makeInvoiceFact({
			suffix: `proration_${suffix}`,
			now: periodStart,
			priceId: plan.providerPriceId,
		});
		invoice.providerSubscriptionId = providerSubscriptionId;
		invoice.customerId = customerId;
		invoice.periodEnd = periodEnd;
		invoice.context = {
			origin: "RECONCILIATION",
			changeAt: now,
			changeId: `stripe-reconcile:proration:invoice:${invoice.providerInvoiceId}`,
		};

		await expect(
			reconcileStripeBilling(
				{ now, maxPages: 3 },
				client,
				makeSource({
					listPaidInvoicesPage: vi.fn().mockResolvedValue({
						facts: [invoice],
						issues: [],
						hasMore: false,
						nextCursor: null,
					}),
				}),
			),
		).resolves.toMatchObject({ completed: true });
		await expect(
			client.stripeReconciliationIssue.findUniqueOrThrow({
				where: {
					issueKey: `stripe:INVOICE:${invoice.providerInvoiceId}:STRIPE_ANNUAL_INVOICE_PERIOD_INVALID`,
				},
			}),
		).resolves.toMatchObject({ code: "STRIPE_ANNUAL_INVOICE_PERIOD_INVALID", status: "OPEN" });
		expect(await client.billingPeriod.count({ where: { subscriptionId: subscription.id } })).toBe(
			0,
		);
		expect(await client.creditLedgerEntry.count({ where: { account: { ownerId: userId } } })).toBe(
			0,
		);
	});

	it("recovers only the current internal month from a late annual invoice", async () => {
		const suffix = crypto.randomUUID();
		const now = new Date("2027-07-15T00:00:00.000Z");
		const periodStart = new Date("2027-01-01T00:00:00.000Z");
		const periodEnd = new Date("2028-01-01T00:00:00.000Z");
		const userId = `reconcile-late-annual-user-${suffix}`;
		const customerId = `cus_reconcile_late_annual_${suffix}`;
		const providerSubscriptionId = `sub_reconcile_late_annual_${suffix}`;
		await client.user.create({
			data: {
				id: userId,
				name: "Late annual invoice fixture",
				email: `reconcile-late-annual-${suffix}@example.test`,
				emailVerified: true,
				paymentsCustomerId: customerId,
				createdAt: periodStart,
				updatedAt: periodStart,
			},
		});
		const account = await client.creditAccount.create({
			data: { ownerType: "USER", ownerId: userId },
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: "stripe",
				providerPriceId: `price_reconcile_late_annual_${suffix}`,
				name: "late-annual",
				creditsPerPeriod: 500n,
				priceMicros: 79_000_000n,
				currency: "USD",
				metadata: { planId: "late-annual", interval: "year", version: 1 },
			},
		});
		const purchase = await client.purchase.create({
			data: {
				userId,
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
				ownerId: userId,
				provider: "stripe",
				providerSubscriptionId,
				planId: plan.id,
				purchaseId: purchase.id,
				status: "ACTIVE",
				currentPeriodStart: periodStart,
				currentPeriodEnd: periodEnd,
			},
		});
		const invoice = makeInvoiceFact({
			suffix: `late_annual_${suffix}`,
			now: periodStart,
			priceId: plan.providerPriceId,
		});
		invoice.providerSubscriptionId = providerSubscriptionId;
		invoice.customerId = customerId;
		invoice.periodEnd = periodEnd;
		invoice.context = {
			origin: "RECONCILIATION",
			changeAt: now,
			changeId: `stripe-reconcile:late-annual:invoice:${invoice.providerInvoiceId}`,
		};

		await expect(
			reconcileStripeBilling(
				{ now, maxPages: 3 },
				client,
				makeSource({
					listPaidInvoicesPage: vi.fn().mockResolvedValue({
						facts: [invoice],
						issues: [],
						hasMore: false,
						nextCursor: null,
					}),
				}),
			),
		).resolves.toMatchObject({ completed: true });
		const periods = await client.billingPeriod.findMany({
			where: { subscriptionId: subscription.id },
			orderBy: { startsAt: "asc" },
		});
		expect(periods.map((period) => period.status)).toEqual([
			"CLOSED",
			"CLOSED",
			"CLOSED",
			"CLOSED",
			"CLOSED",
			"CLOSED",
			"ACTIVE",
			"PENDING",
			"PENDING",
			"PENDING",
			"PENDING",
			"PENDING",
		]);
		const grants = await client.creditLedgerEntry.findMany({
			where: { accountId: account.id, type: "GRANT" },
		});
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({
			amount: 500n,
			referenceKey: `stripe-invoice:${invoice.providerInvoiceId}:period:6:grant`,
		});
		await expect(getCreditInvariantReport(account.id, client)).resolves.toMatchObject({
			valid: true,
		});
	});
});

function makeSource(overrides: Partial<StripeBillingSource> = {}): StripeBillingSource {
	return {
		listSubscriptionsPage: async () => ({
			facts: [],
			issues: [],
			hasMore: false,
			nextCursor: null,
		}),
		listPaidInvoicesPage: async () => ({
			facts: [],
			issues: [],
			hasMore: false,
			nextCursor: null,
		}),
		listRefundsPage: async () => ({ facts: [], issues: [], hasMore: false, nextCursor: null }),
		listInvoicePayments: async () => [],
		...overrides,
	};
}

function makeSubscriptionFact(input: {
	suffix: string;
	now: Date;
	userId: string;
	planId: string;
	priceId: string;
}): StripeSubscriptionFact {
	return {
		kind: "SUBSCRIPTION",
		providerSubscriptionId: `sub_reconcile_${input.suffix}`,
		customerId: `cus_reconcile_${input.suffix}`,
		status: "ACTIVE",
		cancelAtPeriodEnd: false,
		currentPeriodStart: input.now,
		currentPeriodEnd: new Date(input.now.getTime() + 28 * 24 * 60 * 60_000),
		priceId: input.priceId,
		binding: {
			billingPlanId: input.planId,
			planKey: "creator",
			ownerType: "USER",
			ownerId: input.userId,
			submittedByUserId: input.userId,
		},
		context: {
			origin: "RECONCILIATION",
			changeAt: input.now,
			changeId: `stripe-reconcile:fixture:subscription:sub_reconcile_${input.suffix}`,
		},
	};
}

function makeInvoiceFact(input: {
	suffix: string;
	now: Date;
	priceId: string;
}): StripePaidInvoiceFact {
	return {
		kind: "PAID_INVOICE",
		billingReason: "SUBSCRIPTION_CYCLE",
		providerInvoiceId: `in_reconcile_${input.suffix}`,
		providerSubscriptionId: `sub_reconcile_${input.suffix}`,
		customerId: `cus_reconcile_${input.suffix}`,
		providerInvoicePaymentId: `inpay_reconcile_${input.suffix}`,
		providerChargeId: `ch_reconcile_${input.suffix}`,
		providerPaymentIntentId: `pi_reconcile_${input.suffix}`,
		priceId: input.priceId,
		amountPaid: 1_900n,
		currency: "USD",
		periodStart: input.now,
		periodEnd: addUtcBillingMonth(input.now, 1),
		context: {
			origin: "RECONCILIATION",
			changeAt: new Date(input.now.getTime() + 1_000),
			changeId: `stripe-reconcile:fixture:invoice:in_reconcile_${input.suffix}`,
		},
	};
}
