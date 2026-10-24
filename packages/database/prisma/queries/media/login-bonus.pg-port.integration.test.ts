import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#prisma-runtime-client", async () => {
	const { join } = await import("@prisma/client/runtime/client");
	return { Prisma: { join } };
});
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));

import { LoginBonusPostgresPort } from "../../../test-support/login-bonus-postgres-port";
import {
	createCreditGrant,
	reserveCreditsInTransaction,
	settleCreditsInTransaction,
} from "./credits";
import {
	ensureFreeMonthlyCreditGrant,
	hasMatchingFreeMonthlyCreditGrant,
} from "./free-plan-credits";
import { ensureOneTimeLoginCreditGrant } from "./login-bonus";

const fixture = new LoginBonusPostgresPort();
beforeAll(() => fixture.initialize());
beforeEach(() => fixture.reset());
afterAll(() => fixture.close());
const claim = (ownerId: string) => ensureOneTimeLoginCreditGrant({ ownerId }, fixture.client());
const reference = (ownerId: string) => `login-bonus:user:${ownerId}:v1`;

// Real PostgreSQL locks, transactions, SERIALIZABLE retries and production
// grant/reserve/settle logic. The SQL row port does not certify generated ORM
// mappings; the existing login-bonus.integration.test.ts remains that gate.
describe("one-time login gift over a disposable PostgreSQL row port", () => {
	it("24 simultaneous sessions create exactly one immutable grant and lot", async () => {
		await user("registered");
		const results = await Promise.all(Array.from({ length: 24 }, () => claim("registered")));
		expect(results.filter(({ status }) => status === "GRANTED")).toHaveLength(1);
		expect(results.filter(({ status }) => status === "ALREADY_GRANTED")).toHaveLength(23);
		expect(await account("registered")).toMatchObject({
			spendableCredits: 10n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect(
			await fixture.rows(
				`SELECT amount,"referenceKey" FROM ${fixture.table("credit_ledger_entry")}`,
			),
		).toEqual([{ amount: 10n, referenceKey: reference("registered") }]);
		expect(
			await fixture.rows(
				`SELECT "remainingAmount","expiresAt" FROM ${fixture.table("credit_lot")}`,
			),
		).toEqual([{ remainingAmount: 10n, expiresAt: null }]);
	});

	it("denies missing and anonymous principals while treating legacy non-anonymous null as an account", async () => {
		await user("guest", true);
		await user("legacy", null);
		await expect(claim("missing")).resolves.toEqual({ status: "USER_NOT_FOUND" });
		await expect(claim("guest")).resolves.toEqual({ status: "ANONYMOUS_USER" });
		expect(await fixture.rows(`SELECT id FROM ${fixture.table("credit_account")}`)).toEqual([]);
		await expect(claim("legacy")).resolves.toMatchObject({ status: "GRANTED" });
		await user("other-account");
		await expect(claim("other-account")).resolves.toMatchObject({ status: "GRANTED" });
		expect(await account("legacy")).toMatchObject({ spendableCredits: 10n });
		expect(await account("other-account")).toMatchObject({ spendableCredits: 10n });
	});

	it.each([
		{ debt: 7n, remaining: 3n, repaid: 7n, outstanding: 0n },
		{ debt: 15n, remaining: 0n, repaid: 10n, outstanding: 5n },
	])(
		"repays $debt debt through the existing ledger rule and consumes the lifetime identity once",
		async ({ debt, remaining, repaid, outstanding }) => {
			await user("debtor");
			await fixture.rows(
				`INSERT INTO ${fixture.table("credit_account")} (id,"ownerType","ownerId","creditDebt") VALUES ('debt-account','USER','debtor',$1)`,
				[debt.toString()],
			);
			await expect(claim("debtor")).resolves.toMatchObject({ status: "GRANTED" });
			await expect(claim("debtor")).resolves.toMatchObject({ status: "ALREADY_GRANTED" });
			expect(await account("debtor")).toMatchObject({
				spendableCredits: remaining,
				reservedCredits: 0n,
				creditDebt: outstanding,
			});
			expect(
				await fixture.rows(
					`SELECT type,amount FROM ${fixture.table("credit_ledger_entry")} ORDER BY type`,
				),
			).toEqual([
				{ type: "DEBT_REPAYMENT", amount: repaid },
				{ type: "GRANT", amount: remaining },
			]);
			expect(
				await fixture.rows(`SELECT "remainingAmount" FROM ${fixture.table("credit_lot")}`),
			).toEqual(remaining ? [{ remainingAmount: remaining }] : []);
		},
	);

	it("replays a historical five-credit receipt without topping it up to ten", async () => {
		await user("historical-five");
		await fixture.rows(
			`INSERT INTO ${fixture.table("credit_account")} (id,"ownerType","ownerId") VALUES ('historical-account','USER','historical-five')`,
		);
		await fixture.transaction((tx) =>
			createCreditGrant(
				{
					accountId: "historical-account",
					amount: 5n,
					referenceKey: reference("historical-five"),
					expiresAt: null,
					metadata: { program: "one-time-login-bonus-v1" },
				},
				tx,
			),
		);
		const before = await account("historical-five");
		const receipt = await fixture.rows(`SELECT * FROM ${fixture.table("credit_ledger_entry")}`);
		const results = await Promise.all(Array.from({ length: 24 }, () => claim("historical-five")));
		expect(results.every(({ status }) => status === "ALREADY_GRANTED")).toBe(true);
		expect(await account("historical-five")).toEqual(before);
		expect(before?.spendableCredits).toBe(5n);
		expect(await fixture.rows(`SELECT * FROM ${fixture.table("credit_ledger_entry")}`)).toEqual(
			receipt,
		);
		expect(
			await fixture.rows(`SELECT "remainingAmount" FROM ${fixture.table("credit_lot")}`),
		).toEqual([{ remainingAmount: 5n }]);
	});

	it("does not reissue a spent gift or mint monthly credits while retaining a historical monthly grant", async () => {
		await user("returning");
		await claim("returning");
		const current = await account("returning");
		const held = await fixture.transaction((tx) =>
			reserveCreditsInTransaction(
				{
					accountId: String(current?.id),
					jobId: "spent-gift",
					amount: 10n,
					referenceKey: "test:spent-gift:reserve",
				},
				tx,
			),
		);
		await fixture.transaction((tx) =>
			settleCreditsInTransaction(
				{ reservationId: held.id, amount: 10n, referenceKey: "test:spent-gift:settle" },
				tx,
			),
		);
		expect(await account("returning")).toMatchObject({ spendableCredits: 0n, reservedCredits: 0n });
		const now = new Date();
		const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		await fixture.transaction((tx) =>
			createCreditGrant(
				{
					accountId: String(current?.id),
					amount: 25n,
					referenceKey: `free-plan:user:returning:${periodStart.toISOString().slice(0, 7)}`,
					expiresAt: periodEnd,
					metadata: {
						planId: "free",
						periodStart: periodStart.toISOString(),
						periodEnd: periodEnd.toISOString(),
					},
				},
				tx,
			),
		);
		for (const grantDate of [now, periodEnd]) {
			await expect(
				ensureFreeMonthlyCreditGrant(
					{ ownerId: "returning", amount: 25n, now: grantDate },
					fixture.client(),
				),
			).resolves.toEqual({ status: "DISABLED" });
			await expect(claim("returning")).resolves.toMatchObject({ status: "ALREADY_GRANTED" });
		}
		await expect(
			hasMatchingFreeMonthlyCreditGrant(
				{ ownerId: "returning", amount: 25n, now },
				fixture.client(),
			),
		).resolves.toBe(true);
		expect(await account("returning")).toMatchObject({
			spendableCredits: 25n,
			reservedCredits: 0n,
		});
		expect(
			await fixture.rows(
				`SELECT amount FROM ${fixture.table("credit_ledger_entry")} WHERE "referenceKey"=$1`,
				[reference("returning")],
			),
		).toEqual([{ amount: 10n }]);
		expect(
			(
				await fixture.rows(
					`SELECT count(*)::int AS count FROM ${fixture.table("credit_ledger_entry")} WHERE type='GRANT'`,
				)
			)[0]?.count,
		).toBe(2);
	});

	it("preserves a conflicting immutable lifetime record without minting a replacement", async () => {
		await user("conflict");
		await fixture.rows(
			`INSERT INTO ${fixture.table("credit_account")} (id,"ownerType","ownerId") VALUES ('conflict-account','USER','conflict')`,
		);
		await fixture.transaction((tx) =>
			createCreditGrant(
				{
					accountId: "conflict-account",
					amount: 7n,
					referenceKey: reference("conflict"),
					metadata: { program: "different-command" },
				},
				tx,
			),
		);
		await expect(claim("conflict")).rejects.toThrow("IDEMPOTENCY_CONFLICT");
		expect(await account("conflict")).toMatchObject({ spendableCredits: 7n });
		expect(
			await fixture.rows(`SELECT amount FROM ${fixture.table("credit_ledger_entry")}`),
		).toEqual([{ amount: 7n }]);
	});
});

async function user(id: string, isAnonymous: boolean | null = false) {
	await fixture.rows(`INSERT INTO ${fixture.table("user")} (id,"isAnonymous") VALUES ($1,$2)`, [
		id,
		isAnonymous,
	]);
}
async function account(ownerId: string) {
	return (
		await fixture.rows(
			`SELECT * FROM ${fixture.table("credit_account")} WHERE "ownerType"='USER' AND "ownerId"=$1`,
			[ownerId],
		)
	)[0];
}
