import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { createCreditGrant, getCreditInvariantReport } from "./credits";
import {
	ensureFreeMonthlyCreditGrant,
	hasMatchingFreeMonthlyCreditGrant,
} from "./free-plan-credits";

const prefix = "retired-free-monthly-" + crypto.randomUUID();
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
let client: PrismaClient;

describe("retired Free monthly credit producer", () => {
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: safeTestDatabaseUrl() }),
		});
	});
	afterAll(async () => client?.$disconnect());

	it("never creates monthly grants for a new owner, including concurrent future-month calls", async () => {
		const ownerId = prefix + "-new";
		const now = new Date();
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				ensureFreeMonthlyCreditGrant(
					{
						ownerId,
						amount: 25n,
						now: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index, 1)),
					},
					client,
				),
			),
		);
		expect(results.every(({ status }) => status === "DISABLED")).toBe(true);
		expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
		expect(
			await client.creditLedgerEntry.count({
				where: { referenceKey: { startsWith: "free-plan:user:" + ownerId } },
			}),
		).toBe(0);
	});

	it("preserves previously granted monthly lots and their immutable receipt while blocking renewal", async () => {
		const ownerId = prefix + "-historical";
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		const now = new Date();
		const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const referenceKey = "free-plan:user:" + ownerId + ":" + periodStart.toISOString().slice(0, 7);
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 25n,
				referenceKey,
				expiresAt: periodEnd,
				metadata: {
					planId: "free",
					periodStart: periodStart.toISOString(),
					periodEnd: periodEnd.toISOString(),
				},
			},
			client,
		);
		const ledgerBefore = await client.creditLedgerEntry.findMany({
			where: { accountId: account.id },
		});
		const lotsBefore = await client.creditLot.findMany({ where: { accountId: account.id } });
		await expect(
			hasMatchingFreeMonthlyCreditGrant({ ownerId, amount: 25n, now }, client),
		).resolves.toBe(true);
		for (const date of [now, periodEnd])
			await expect(
				ensureFreeMonthlyCreditGrant({ ownerId, amount: 25n, now: date }, client),
			).resolves.toEqual({ status: "DISABLED" });
		expect(await client.creditLedgerEntry.findMany({ where: { accountId: account.id } })).toEqual(
			ledgerBefore,
		);
		expect(await client.creditLot.findMany({ where: { accountId: account.id } })).toEqual(
			lotsBefore,
		);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 25n, reserved: 0n, debt: 0n },
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
