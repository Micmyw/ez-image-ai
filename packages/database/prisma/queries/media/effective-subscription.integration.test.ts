import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { findEffectivePaidSubscription } from "./billing";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const OWNER_PREFIX = `pr6-effective-subscription-${RUN_ID}`;
const PLAN_PROVIDER = `pr6-effective-subscription-${RUN_ID}`;
const NOW = new Date("2026-08-25T06:00:00.000Z");

let client: PrismaClient;
let planId: string | undefined;
const subscriptionIds: string[] = [];

describe("effective paid subscription", () => {
	beforeAll(async () => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
		const plan = await client.billingPlan.create({
			data: {
				provider: PLAN_PROVIDER,
				providerPriceId: `price_${crypto.randomUUID()}`,
				name: "creator",
				creditsPerPeriod: 1_000n,
				priceMicros: 19_000_000n,
				currency: "USD",
				metadata: { planId: "creator" },
			},
		});
		planId = plan.id;
	});

	afterAll(async () => {
		if (!client) return;
		const fixturePlanIds = planId ? [planId] : [];
		const [deletedSubscriptions, deletedPlans] = await client.$transaction([
			client.subscription.deleteMany({ where: { id: { in: subscriptionIds } } }),
			client.billingPlan.deleteMany({ where: { id: { in: fixturePlanIds } } }),
		]);
		const [remainingSubscriptions, remainingPlans] = await Promise.all([
			client.subscription.count({ where: { id: { in: subscriptionIds } } }),
			client.billingPlan.count({ where: { id: { in: fixturePlanIds } } }),
		]);
		if (
			deletedSubscriptions.count !== subscriptionIds.length ||
			deletedPlans.count !== fixturePlanIds.length ||
			remainingSubscriptions !== 0 ||
			remainingPlans !== 0
		) {
			throw new Error("PR6_EFFECTIVE_SUBSCRIPTION_FIXTURE_CLEANUP_FAILED");
		}
		await client.$disconnect();
	});

	it.each([
		{
			label: "ACTIVE",
			status: "ACTIVE" as const,
			graceEndsAt: null,
			effective: true,
		},
		{
			label: "PAST_DUE before the grace boundary",
			status: "PAST_DUE" as const,
			graceEndsAt: new Date("2026-08-25T06:00:00.001Z"),
			effective: true,
		},
		{
			label: "PAST_DUE at the grace boundary",
			status: "PAST_DUE" as const,
			graceEndsAt: NOW,
			effective: false,
		},
		{
			label: "PAST_DUE after the grace boundary",
			status: "PAST_DUE" as const,
			graceEndsAt: new Date("2026-08-25T05:59:59.999Z"),
			effective: false,
		},
		{
			label: "CANCELED",
			status: "CANCELED" as const,
			graceEndsAt: new Date("2026-09-01T00:00:00.000Z"),
			effective: false,
		},
		{
			label: "EXPIRED",
			status: "EXPIRED" as const,
			graceEndsAt: new Date("2026-09-01T00:00:00.000Z"),
			effective: false,
		},
	])("treats $label according to the server grace clock", async (scenario) => {
		if (!planId) throw new Error("PR6 effective subscription plan fixture is missing");
		const ownerId = `${OWNER_PREFIX}-${scenario.status.toLowerCase()}-${crypto.randomUUID()}`;
		const createdSubscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_${crypto.randomUUID()}`,
				planId,
				status: scenario.status,
				graceEndsAt: scenario.graceEndsAt,
				currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
				currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
				...(scenario.status !== "CANCELED"
					? {
							periods: {
								create: {
									startsAt: new Date("2026-08-01T00:00:00Z"),
									endsAt: new Date("2026-09-01T00:00:00Z"),
									status: "ACTIVE" as const,
									paidAmount: 19_000_000n,
									creditAmount: 1_000n,
								},
							},
						}
					: {}),
			},
		});
		subscriptionIds.push(createdSubscription.id);

		const effectiveSubscription = await findEffectivePaidSubscription(
			{ ownerType: "USER", ownerId, now: NOW },
			client,
		);

		if (!scenario.effective) {
			expect(effectiveSubscription).toBeNull();
			return;
		}
		expect(effectiveSubscription).toMatchObject({
			ownerType: "USER",
			ownerId,
			status: scenario.status,
			plan: { name: "creator", metadata: { planId: "creator" } },
		});
	});

	it("does not use an older payment for grace after the latest paid period is fully refunded", async () => {
		if (!planId) throw new Error("Effective subscription plan fixture is missing");
		const ownerId = `${OWNER_PREFIX}-refunded-grace`;
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "paypal",
				providerSubscriptionId: `sub_${crypto.randomUUID()}`,
				planId,
				status: "PAST_DUE",
				graceEndsAt: new Date("2026-09-01T00:00:00Z"),
				currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
				currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
				periods: {
					create: [
						{
							startsAt: new Date("2026-07-01T00:00:00Z"),
							endsAt: new Date("2026-08-01T00:00:00Z"),
							status: "CLOSED",
							paidAmount: 19_000_000n,
							creditAmount: 1_000n,
						},
						{
							startsAt: new Date("2026-08-01T00:00:00Z"),
							endsAt: new Date("2026-09-01T00:00:00Z"),
							status: "REFUNDED",
							paidAmount: 19_000_000n,
							refundedAmount: 19_000_000n,
							creditAmount: 1_000n,
							refundedCredits: 1_000n,
						},
					],
				},
			},
		});
		subscriptionIds.push(subscription.id);

		await expect(
			findEffectivePaidSubscription({ ownerType: "USER", ownerId, now: NOW }, client),
		).resolves.toBeNull();
	});

	it.each([
		{
			label: "an unpaid renewal after a paid period",
			previousRefund: 0n,
			latestPaid: 0n,
			latestRefund: 0n,
			latestStatus: "PENDING" as const,
		},
		{
			label: "a partial annual refund that reclaimed this month's credits",
			previousRefund: 95_000_000n,
			latestPaid: 190_000_000n,
			latestRefund: 95_000_000n,
			latestStatus: "REFUNDED" as const,
		},
		{
			label: "a new paid period after an older refunded payment",
			previousRefund: 190_000_000n,
			latestPaid: 19_000_000n,
			latestRefund: 0n,
			latestStatus: "ACTIVE" as const,
		},
	])("preserves legitimate grace for $label", async (scenario) => {
		const subscription = await createGraceSubscription([
			{
				startsAt: new Date("2026-07-01T00:00:00Z"),
				endsAt: new Date("2026-08-01T00:00:00Z"),
				status: "CLOSED",
				paidAmount: 190_000_000n,
				refundedAmount: scenario.previousRefund,
				creditAmount: 1_000n,
			},
			{
				startsAt: new Date("2026-08-01T00:00:00Z"),
				endsAt: new Date("2026-09-01T00:00:00Z"),
				status: scenario.latestStatus,
				paidAmount: scenario.latestPaid,
				refundedAmount: scenario.latestRefund,
				creditAmount: 1_000n,
				refundedCredits: scenario.latestStatus === "REFUNDED" ? 1_000n : 0n,
			},
		]);
		await expect(
			findEffectivePaidSubscription(
				{ ownerType: "USER", ownerId: subscription.ownerId, now: NOW },
				client,
			),
		).resolves.toMatchObject({ id: subscription.id, status: "PAST_DUE" });
	});

	it("does not use a future paid period as grace evidence before it starts", async () => {
		const subscription = await createGraceSubscription([
			{
				startsAt: new Date("2026-09-01T00:00:00Z"),
				endsAt: new Date("2026-10-01T00:00:00Z"),
				status: "PENDING",
				paidAmount: 19_000_000n,
				creditAmount: 1_000n,
			},
		]);
		await expect(
			findEffectivePaidSubscription(
				{ ownerType: "USER", ownerId: subscription.ownerId, now: NOW },
				client,
			),
		).resolves.toBeNull();
	});

	it("keeps a valid replacement selected when an old refunded subscription gets a later update", async () => {
		const old = await createGraceSubscription([
			{
				startsAt: new Date("2026-07-01T00:00:00Z"),
				endsAt: new Date("2026-08-01T00:00:00Z"),
				paidAmount: 19_000_000n,
				creditAmount: 1_000n,
			},
			{
				startsAt: new Date("2026-08-01T00:00:00Z"),
				endsAt: new Date("2026-09-01T00:00:00Z"),
				paidAmount: 19_000_000n,
				refundedAmount: 19_000_000n,
				creditAmount: 1_000n,
				status: "REFUNDED",
			},
		]);
		const replacement = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId: old.ownerId,
				provider: "waffo",
				providerSubscriptionId: `sub_${crypto.randomUUID()}`,
				planId: old.planId,
				status: "ACTIVE",
				currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
				currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
				updatedAt: NOW,
				periods: {
					create: {
						startsAt: new Date("2026-08-01T00:00:00Z"),
						endsAt: new Date("2026-09-01T00:00:00Z"),
						paidAmount: 19_000_000n,
						creditAmount: 1_000n,
						status: "ACTIVE",
					},
				},
			},
		});
		subscriptionIds.push(replacement.id);
		await client.subscription.update({
			where: { id: old.id },
			data: { updatedAt: new Date(NOW.getTime() + 1) },
		});
		await expect(
			findEffectivePaidSubscription({ ownerType: "USER", ownerId: old.ownerId, now: NOW }, client),
		).resolves.toMatchObject({ id: replacement.id, status: "ACTIVE" });
	});
});

async function createGraceSubscription(
	periods: Prisma.BillingPeriodCreateWithoutSubscriptionInput[],
) {
	if (!planId) throw new Error("Effective subscription plan fixture is missing");
	const subscription = await client.subscription.create({
		data: {
			ownerType: "USER",
			ownerId: `${OWNER_PREFIX}-${crypto.randomUUID()}`,
			provider: "paypal",
			providerSubscriptionId: `sub_${crypto.randomUUID()}`,
			planId,
			status: "PAST_DUE",
			graceEndsAt: new Date("2026-09-01T00:00:00Z"),
			currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
			currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
			periods: { create: periods },
		},
	});
	subscriptionIds.push(subscription.id);
	return subscription;
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) {
		throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	}
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const allowedDatabases = new Set([
		"/ezpic_pr6_subscriptions_test",
		"/ezpic_pr7_growth_operations_test",
		"/ezpic_pr8_test",
		...(process.env.CI === "true" ? ["/ai_media_foundation_test"] : []),
	]);
	const safeNamedDatabase = /^\/ezpic_[a-z0-9_]+_test$/.test(parsed.pathname);
	if (
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		parsed.port !== "55432" ||
		(!allowedDatabases.has(parsed.pathname) && !safeNamedDatabase)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected an approved disposable EzPic database");
	}
	return TEST_DATABASE_URL;
}
