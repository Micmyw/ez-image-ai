import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../../generated/client";
import { getCreditInvariantReport } from "./credits";
import { ensureFreeMonthlyCreditGrant } from "./free-plan-credits";
import { ensureOneTimeLoginCreditGrant } from "./login-bonus";

const prefix = `login-bonus-test-${crypto.randomUUID()}`;
let client: PrismaClient;

describe("one-time login bonus on disposable PostgreSQL", () => {
	beforeAll(() => {
		if (process.env.DATABASE_URL)
			throw new Error("DATABASE_URL_MUST_BE_UNSET_FOR_LOGIN_BONUS_TEST");
		const target = new URL(process.env.TEST_DATABASE_URL ?? "");
		if (
			!["postgres:", "postgresql:"].includes(target.protocol) ||
			!["127.0.0.1", "localhost"].includes(target.hostname) ||
			!target.pathname.endsWith("_test") ||
			Number(target.port) < 49152 ||
			Number(target.port) > 65535
		)
			throw new Error("DISPOSABLE_LOCAL_LOGIN_BONUS_DATABASE_REQUIRED");
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: target.toString() }) });
	});
	afterAll(async () => {
		// The complete database is disposable; immutable financial entries remain intact.
		await client?.$disconnect();
	});

	async function user(label: string, isAnonymous = false) {
		const ownerId = `${prefix}-${label}`;
		await client.user.create({
			data: {
				id: ownerId,
				name: label,
				email: `${ownerId}@example.invalid`,
				emailVerified: !isAnonymous,
				isAnonymous,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		return ownerId;
	}

	it("24 concurrent claims create one five-credit grant, lot and ledger entry", async () => {
		const ownerId = await user("concurrent");
		const results = await Promise.all(
			Array.from({ length: 24 }, () => ensureOneTimeLoginCreditGrant({ ownerId }, client)),
		);
		expect(results.filter(({ status }) => status === "GRANTED")).toHaveLength(1);
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
		});
		expect(account).toMatchObject({ spendableCredits: 5n, reservedCredits: 0n, creditDebt: 0n });
		expect(await client.creditLot.count({ where: { accountId: account.id } })).toBe(1);
		expect(await client.creditLedgerEntry.count({ where: { accountId: account.id } })).toBe(1);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("does not replace or repeat the separate monthly 25-credit allowance", async () => {
		const ownerId = await user("monthly");
		const now = new Date();
		await Promise.all([
			ensureFreeMonthlyCreditGrant({ ownerId, amount: 25n, now }, client),
			ensureOneTimeLoginCreditGrant({ ownerId }, client),
		]);
		await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		const account = await client.creditAccount.findUniqueOrThrow({
			where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
		});
		expect(account.spendableCredits).toBe(30n);
		const grants = await client.creditLedgerEntry.findMany({
			where: { accountId: account.id, type: "GRANT" },
		});
		expect(grants).toHaveLength(2);
		expect(grants.map(({ referenceKey }) => referenceKey)).toContain(
			`login-bonus:user:${ownerId}:v1`,
		);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("rejects anonymous or absent identities without creating a credit account", async () => {
		const ownerId = await user("anonymous", true);
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, client)).resolves.toEqual({
			status: "ANONYMOUS_USER",
		});
		await expect(
			ensureOneTimeLoginCreditGrant({ ownerId: `${prefix}-missing` }, client),
		).resolves.toEqual({ status: "USER_NOT_FOUND" });
		expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
	});
});
