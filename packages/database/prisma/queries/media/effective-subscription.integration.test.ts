import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
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
});

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) {
		throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	}
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	if (
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		parsed.port !== "55432" ||
		parsed.pathname !== "/ezpic_pr6_subscriptions_test"
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected the disposable PR 6 database");
	}
	return TEST_DATABASE_URL;
}
