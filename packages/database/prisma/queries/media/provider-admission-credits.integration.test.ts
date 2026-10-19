import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only substitute the unavailable generated module's SQL-builder export. No
// PrismaClient or ledger decision is mocked; every row operation reaches pg.
vi.mock("#prisma-runtime-client", async () => {
	const { join } = await import("@prisma/client/runtime/client");
	return { Prisma: { join } };
});
vi.mock("../../client", () => ({
	getDatabaseClient: () => {
		throw new Error("Unexpected implicit database connection");
	},
}));

import { CreditAdmissionPostgresFixture } from "../../../test-support/provider-admission-credit-port";
import { createCreditGrant, releaseCreditsInTransaction } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";

const fixture = new CreditAdmissionPostgresFixture();
beforeAll(() => fixture.initialize());
beforeEach(() => fixture.reset());
afterAll(() => fixture.close());

// This covers the real admission and ledger functions over a PostgreSQL row
// port. Provider HTTP, generated ORM mappings, and full lifecycle callers are
// separate checks; an outbox assertion establishes one durable intent only.
describe("funded admission retains atomic credit accounting", () => {
	it("accepts 32 unfinished jobs for one funded owner despite the retired one-job quota", async () => {
		await fund("owner", 160n);
		const results = [];
		for (let index = 0; index < 32; index += 1) {
			results.push(await submit(await quote("owner", `request-${index}`)));
		}
		expect(new Set(results.map(({ job }) => job.id)).size).toBe(32);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 160n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("accepts 32 simultaneous funded submissions from the same owner", async () => {
		await fund("owner", 160n);
		const inputs = await Promise.all(
			Array.from({ length: 32 }, (_, index) => quote("owner", `parallel-${index}`)),
		);
		const accepted = await Promise.all(inputs.map(submit));
		expect(new Set(accepted.map(({ job }) => job.id)).size).toBe(32);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 160n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("admits 32 independently funded owners without borrowing another owner's balance or task slots", async () => {
		const owners = Array.from({ length: 32 }, (_, index) => `owner-${index}`);
		await Promise.all(owners.map((owner) => fund(owner, 5n)));
		const inputs = await Promise.all(owners.map((owner) => quote(owner, "first")));
		const accepted = await Promise.all(inputs.map(submit));
		expect(new Set(accepted.map(({ job }) => job.id)).size).toBe(32);
		for (const owner of owners) {
			expect(await balance(owner)).toMatchObject({
				spendableCredits: 0n,
				reservedCredits: 5n,
				creditDebt: 0n,
			});
		}
		expect(await counts()).toEqual({ jobs: 32, reserves: 32, outbox: 32 });
	});

	it("rolls back losing simultaneous submissions instead of overspending the same owner's balance", async () => {
		await fund("owner", 10n);
		const inputs = await Promise.all(
			Array.from({ length: 8 }, (_, index) => quote("owner", `race-${index}`)),
		);
		const results = await Promise.allSettled(inputs.map(submit));
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
		for (const result of results) {
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ message: "INSUFFICIENT_CREDITS" });
		}
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 10n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 2, reserves: 2, outbox: 2 });
		const lots = await fixture.rows(
			`SELECT "remainingAmount", "reservedAmount" FROM ${fixture.table("credit_lot")}`,
		);
		expect(lots).toEqual([{ remainingAmount: 0n, reservedAmount: 10n }]);
	});

	it("commits one job, reservation, allocation and durable intent for simultaneous idempotent retries", async () => {
		await fund("owner", 10n);
		const input = await quote("owner", "same-request");
		const results = await Promise.all(Array.from({ length: 12 }, () => submit(input)));
		expect(new Set(results.map(({ job }) => job.id)).size).toBe(1);
		expect(results.filter(({ replayed }) => !replayed)).toHaveLength(1);
		expect(await counts()).toEqual({ jobs: 1, reserves: 1, outbox: 1 });
		expect(
			(
				await fixture.rows(
					`SELECT count(*)::int AS count FROM ${fixture.table("credit_reservation_allocation")}`,
				)
			)[0]?.count,
		).toBe(1);
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 5n,
			creditDebt: 0n,
		});
	});

	it("refuses an unapproved quote before creating any job or reservation", async () => {
		await fund("owner", 5n);
		const input = await quote("owner", "unsafe", "REJECT");
		await expect(submit(input)).rejects.toThrow("TEXT_MODERATION_EVIDENCE_INVALID");
		expect(await counts()).toEqual({ jobs: 0, reserves: 0, outbox: 0 });
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
	});

	it.each(["SAFETY_FAILED", "CANCELED"])(
		"releases a %s caller's reservation once and restores its original lot",
		async (reason) => {
			await fund("owner", 5n);
			const created = await submit(await quote("owner", "accepted"));
			const release = () =>
				fixture.transaction(async (tx, connection) => {
					await connection.query(
						`UPDATE ${fixture.table("generation_job")} SET status=$1 WHERE id=$2`,
						[reason === "CANCELED" ? "CANCELED" : "FAILED", created.job.id],
					);
					return releaseCreditsInTransaction(
						{
							reservationId: created.reservation.id,
							referenceKey: `job:${created.job.id}:${reason}`,
						},
						tx,
					);
				});
			await release();
			await release();
			expect(await balance("owner")).toMatchObject({
				spendableCredits: 5n,
				reservedCredits: 0n,
				creditDebt: 0n,
			});
			const rows = await fixture.rows(
				`SELECT type, amount FROM ${fixture.table("credit_ledger_entry")} WHERE "reservationId"=$1 ORDER BY type`,
				[created.reservation.id],
			);
			expect(rows).toEqual([
				{ type: "RELEASE", amount: 5n },
				{ type: "RESERVE", amount: 5n },
			]);
			expect(
				await fixture.rows(
					`SELECT "remainingAmount", "reservedAmount" FROM ${fixture.table("credit_lot")}`,
				),
			).toEqual([{ remainingAmount: 5n, reservedAmount: 0n }]);
		},
	);

	it("replays an uncertain accepted job without a second reserve or durable provider intent", async () => {
		await fund("owner", 10n);
		const input = await quote("owner", "unknown-response");
		const accepted = await submit(input);
		await fixture.rows(
			`UPDATE ${fixture.table("generation_job")} SET status='NEEDS_RECONCILIATION' WHERE id=$1 RETURNING id`,
			[accepted.job.id],
		);
		const replay = await submit(input);
		expect(replay).toMatchObject({
			replayed: true,
			job: { id: accepted.job.id, status: "NEEDS_RECONCILIATION" },
		});
		expect(await balance("owner")).toMatchObject({
			spendableCredits: 5n,
			reservedCredits: 5n,
			creditDebt: 0n,
		});
		expect(await counts()).toEqual({ jobs: 1, reserves: 1, outbox: 1 });
		expect(
			await fixture.rows(`SELECT status FROM ${fixture.table("credit_reservation")} WHERE id=$1`, [
				accepted.reservation.id,
			]),
		).toEqual([{ status: "ACTIVE" }]);
	});
});

async function fund(ownerId: string, amount: bigint) {
	await fixture.transaction(async (tx, connection) => {
		await connection.query(
			`INSERT INTO ${fixture.table("credit_account")} (id,"ownerType","ownerId") VALUES ($1,'USER',$1)`,
			[ownerId],
		);
		await createCreditGrant(
			{ accountId: ownerId, amount, referenceKey: `test:${ownerId}:grant` },
			tx,
		);
	});
}

async function quote(ownerId: string, key: string, decision = "ALLOW") {
	const record = {
		id: `${ownerId}:${key}`,
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-nano-banana-2-lite",
		catalogVersion: "test-catalog",
		pricingVersion: "test-pricing",
		credits: 5n,
		costMicros: 1n,
		inputSnapshot: { kind: "text-to-image", prompt: "Reviewed fixture" },
		pricingSnapshot: {},
		expiresAt: new Date("2099-01-01"),
		moderationDecision: decision,
		moderationProvider: "test",
		moderationRuleVersion: "fixture-policy",
		moderationReasonCode: decision,
	};
	await fixture.transaction((tx) =>
		tx.generationQuote.create({
			data: { ...record, inputFingerprint: fingerprintGenerationQuoteSecurityPayload(record) },
		} as never),
	);
	return {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		quoteId: record.id,
		idempotencyKey: key,
		inputAssetIds: [],
		expectedModerationRuleVersion: "fixture-policy",
		maximumConcurrentJobs: 1,
	};
}
const submit = (input: Awaited<ReturnType<typeof quote>>) =>
	createGenerationJobTransaction(input, fixture.client());
const balance = async (ownerId: string) =>
	(
		await fixture.rows(
			`SELECT "spendableCredits", "reservedCredits", "creditDebt" FROM ${fixture.table("credit_account")} WHERE "ownerId"=$1`,
			[ownerId],
		)
	)[0];
async function counts() {
	const [row] = await fixture.rows(`SELECT
		(SELECT count(*)::int FROM ${fixture.table("generation_job")}) AS jobs,
		(SELECT count(*)::int FROM ${fixture.table("credit_ledger_entry")} WHERE type='RESERVE') AS reserves,
		(SELECT count(*)::int FROM ${fixture.table("outbox_event")}) AS outbox`);
	return row;
}
