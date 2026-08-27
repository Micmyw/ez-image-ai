import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { ensureFreeMonthlyCreditGrant } from "./free-plan-credits";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = crypto.randomUUID();
const OWNER_PREFIX = `pr6-free-credits-${RUN_ID}`;
const PLAN_PROVIDER = `pr6-free-credits-${RUN_ID}`;

let client: PrismaClient;
const planIds: string[] = [];
const subscriptionIds: string[] = [];
const userIds: string[] = [];

describe("Free monthly credit grants", () => {
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});

	afterAll(async () => {
		if (!client) return;
		const [deletedSubscriptions, deletedPlans, deletedUsers] = await client.$transaction([
			client.subscription.deleteMany({ where: { id: { in: subscriptionIds } } }),
			client.billingPlan.deleteMany({ where: { id: { in: planIds } } }),
			client.user.deleteMany({ where: { id: { in: userIds } } }),
		]);
		const [remainingSubscriptions, remainingPlans, remainingUsers] = await Promise.all([
			client.subscription.count({ where: { id: { in: subscriptionIds } } }),
			client.billingPlan.count({ where: { id: { in: planIds } } }),
			client.user.count({ where: { id: { in: userIds } } }),
		]);
		if (
			deletedSubscriptions.count !== subscriptionIds.length ||
			deletedPlans.count !== planIds.length ||
			deletedUsers.count !== userIds.length ||
			remainingSubscriptions !== 0 ||
			remainingPlans !== 0 ||
			remainingUsers !== 0
		) {
			throw new Error("PR6_FREE_PLAN_FIXTURE_CLEANUP_FAILED");
		}
		await client.$disconnect();
	});

	it("returns before account, lot, or ledger writes for an anonymous user", async () => {
		const ownerId = `${OWNER_PREFIX}-anonymous`;
		const user = await client.user.create({
			data: {
				id: ownerId,
				name: "Anonymous",
				email: `${ownerId}@guest.invalid`,
				emailVerified: false,
				isAnonymous: true,
				createdAt: new Date("2026-08-25T06:00:00.000Z"),
				updatedAt: new Date("2026-08-25T06:00:00.000Z"),
			},
		});
		userIds.push(user.id);

		await expect(
			ensureFreeMonthlyCreditGrant(
				{
					ownerId,
					amount: 25n,
					now: new Date("2026-08-25T06:00:00.000Z"),
				},
				client,
			),
		).resolves.toEqual({ status: "ANONYMOUS_USER" });
		expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
		expect(
			await client.creditLedgerEntry.count({
				where: { account: { ownerType: "USER", ownerId } },
			}),
		).toBe(0);
	});

	it("fails closed before ledger writes when the authoritative user row is missing", async () => {
		const ownerId = `${OWNER_PREFIX}-missing`;

		await expect(
			ensureFreeMonthlyCreditGrant(
				{ ownerId, amount: 25n, now: new Date("2026-08-25T06:00:00.000Z") },
				client,
			),
		).resolves.toEqual({ status: "USER_NOT_FOUND" });
		expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
	});

	it("creates one existing-ledger grant for the UTC month", async () => {
		const ownerId = `${OWNER_PREFIX}-grant`;
		const now = new Date("2026-08-25T06:00:00.000Z");
		await createRegisteredUser(ownerId);

		await expect(
			ensureFreeMonthlyCreditGrant({ ownerId, amount: 25n, now }, client),
		).resolves.toMatchObject({
			status: "GRANTED",
			referenceKey: `free-plan:user:${ownerId}:2026-08`,
		});

		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
		});
		const [lots, ledger] = await Promise.all([
			client.creditLot.findMany({ where: { accountId: account.id } }),
			client.creditLedgerEntry.findMany({ where: { accountId: account.id } }),
		]);
		expect(account).toMatchObject({ spendableCredits: 25n, reservedCredits: 0n });
		expect(lots).toHaveLength(1);
		expect(lots[0]).toMatchObject({
			grantedAmount: 25n,
			remainingAmount: 25n,
			expiresAt: new Date("2026-09-01T00:00:00.000Z"),
		});
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({
			type: "GRANT",
			amount: 25n,
			referenceKey: `free-plan:user:${ownerId}:2026-08`,
		});
		expect(ledger[0]?.metadata).toMatchObject({
			command: {
				metadata: {
					planId: "free",
					periodStart: "2026-08-01T00:00:00.000Z",
					periodEnd: "2026-09-01T00:00:00.000Z",
				},
			},
		});
	});

	it("is idempotent for replays and concurrent requests", async () => {
		const ownerId = `${OWNER_PREFIX}-concurrent`;
		await createRegisteredUser(ownerId);
		const input = {
			ownerId,
			amount: 25n,
			now: new Date("2026-08-25T06:00:00.000Z"),
		};

		await Promise.all([
			ensureFreeMonthlyCreditGrant(input, client),
			ensureFreeMonthlyCreditGrant(input, client),
			ensureFreeMonthlyCreditGrant(input, client),
		]);
		await ensureFreeMonthlyCreditGrant(input, client);

		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
		});
		const [lotCount, ledgerCount] = await Promise.all([
			client.creditLot.count({ where: { accountId: account.id } }),
			client.creditLedgerEntry.count({ where: { accountId: account.id, type: "GRANT" } }),
		]);
		expect(account.spendableCredits).toBe(25n);
		expect(lotCount).toBe(1);
		expect(ledgerCount).toBe(1);
	});

	it.each([
		{
			label: "ACTIVE subscription",
			status: "ACTIVE" as const,
			graceEndsAt: null,
			blocked: true,
		},
		{
			label: "PAST_DUE subscription inside grace",
			status: "PAST_DUE" as const,
			graceEndsAt: new Date("2026-08-26T06:00:00.000Z"),
			blocked: true,
		},
		{
			label: "PAST_DUE subscription after grace",
			status: "PAST_DUE" as const,
			graceEndsAt: new Date("2026-08-25T05:59:59.999Z"),
			blocked: false,
		},
		{
			label: "old EXPIRED subscription",
			status: "EXPIRED" as const,
			graceEndsAt: new Date("2026-09-01T00:00:00.000Z"),
			blocked: false,
		},
	])("handles a paid $label without stacking Free credits", async (scenario) => {
		const ownerId = `${OWNER_PREFIX}-${scenario.status.toLowerCase()}-${crypto.randomUUID()}`;
		await createRegisteredUser(ownerId);
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
		planIds.push(plan.id);
		const subscription = await client.subscription.create({
			data: {
				ownerType: "USER",
				ownerId,
				provider: "stripe",
				providerSubscriptionId: `sub_${crypto.randomUUID()}`,
				planId: plan.id,
				status: scenario.status,
				graceEndsAt: scenario.graceEndsAt,
			},
		});
		subscriptionIds.push(subscription.id);

		const result = await ensureFreeMonthlyCreditGrant(
			{ ownerId, amount: 25n, now: new Date("2026-08-25T06:00:00.000Z") },
			client,
		);

		expect(result.status).toBe(scenario.blocked ? "PAID_SUBSCRIPTION" : "GRANTED");
		expect(
			await client.creditLedgerEntry.count({
				where: { account: { ownerType: "USER", ownerId }, type: "GRANT" },
			}),
		).toBe(scenario.blocked ? 0 : 1);
	});
});

async function createRegisteredUser(ownerId: string): Promise<void> {
	const user = await client.user.create({
		data: {
			id: ownerId,
			name: "Registered",
			email: `${ownerId}@example.test`,
			emailVerified: true,
			isAnonymous: false,
			createdAt: new Date("2026-08-25T06:00:00.000Z"),
			updatedAt: new Date("2026-08-25T06:00:00.000Z"),
		},
	});
	userIds.push(user.id);
}

function safeTestDatabaseUrl(): string {
	if (!TEST_DATABASE_URL) {
		throw new Error("BLOCKED_BY_ENVIRONMENT: TEST_DATABASE_URL is required");
	}
	if (DATABASE_URL && TEST_DATABASE_URL === DATABASE_URL) {
		throw new Error("UNSAFE_TEST_DATABASE: TEST_DATABASE_URL must not equal DATABASE_URL");
	}
	const parsed = new URL(TEST_DATABASE_URL);
	const databaseName = parsed.pathname.slice(1);
	if (process.env.CI === "true" && databaseName !== "ai_media_foundation_test") {
		throw new Error("UNSAFE_TEST_DATABASE: expected the canonical CI test database");
	}
	if (
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		!/test|testing/i.test(parsed.pathname)
	) {
		throw new Error("UNSAFE_TEST_DATABASE: expected a disposable loopback test database");
	}
	return TEST_DATABASE_URL;
}
