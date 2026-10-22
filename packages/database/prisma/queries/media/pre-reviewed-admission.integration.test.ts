import { PrismaPg } from "@prisma/adapter-pg";
import { TEMPORARY_REFERENCE_RESERVATION_PREFIX } from "@repo/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPreReviewedAdmissionFixture } from "../../../test-support/pre-reviewed-admission-fixture";
import { PrismaClient, type Prisma } from "../../generated/client";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	settleCredits,
} from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import { fingerprintGenerationQuoteSecurityPayload } from "./quotes";
import type { CreateGenerationJobInput, CreateGenerationJobResult } from "./types";

let client: PrismaClient;

function isolatedUrl() {
	const value = process.env.TEST_DATABASE_URL;
	if (!value) throw new Error("TEST_DATABASE_URL is required");
	const parsed = new URL(value);
	if (
		!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(parsed.pathname.slice(1)) ||
		value === process.env.DATABASE_URL
	)
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	return value;
}

function observedTransactions(isolation: string[], target = client) {
	return new Proxy(target, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options: { isolationLevel: Prisma.TransactionIsolationLevel },
				) => {
					isolation.push(options.isolationLevel);
					return target.$transaction(operation, options);
				};
			return Reflect.get(target, key, receiver);
		},
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForAccountLock(applicationName: string) {
	const deadline = Date.now() + 5000;
	do {
		const [state] = await client.$queryRaw<Array<{ blocked: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE application_name = ${applicationName}
				  AND wait_event_type = 'Lock'
				  AND query LIKE '%credit_account%'
				  AND query LIKE '%FOR UPDATE%'
			) AS "blocked"`;
		if (state?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	throw new Error("EXPECTED_ADMISSION_CREDIT_ACCOUNT_LOCK_WAIT");
}

type Fixture = Awaited<ReturnType<typeof createPreReviewedAdmissionFixture>>;

async function runBehindAccountLock(
	f: Fixture,
	input: CreateGenerationJobInput,
	options: {
		mutate?: (tx: Prisma.TransactionClient) => Promise<unknown>;
		whileBlocked?: () => Promise<void>;
	} = {},
) {
	const entered = deferred();
	const release = deferred();
	const applicationName = `ready-admission-${crypto.randomUUID()}`;
	const contender = new PrismaClient({
		adapter: new PrismaPg({ connectionString: isolatedUrl(), application_name: applicationName }),
	});
	const isolation: string[] = [];
	const holding = client.$transaction(
		async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "id" = ${f.account.id} FOR UPDATE`;
			entered.resolve();
			await release.promise;
			await options.mutate?.(tx);
		},
		{ isolationLevel: "ReadCommitted", timeout: 20_000 },
	);
	const holdingSettled = Promise.allSettled([holding]);
	let admission: Promise<PromiseSettledResult<CreateGenerationJobResult>[]> | undefined;
	try {
		await Promise.race([
			entered.promise,
			holding.then(() => {
				throw new Error("ACCOUNT_LOCK_BARRIER_NOT_REACHED");
			}),
		]);
		admission = Promise.allSettled([
			createGenerationJobTransaction(input, observedTransactions(isolation, contender)),
		]);
		await waitForAccountLock(applicationName);
		await options.whileBlocked?.();
	} finally {
		release.resolve();
		await Promise.all([holdingSettled, admission]);
		await contender.$disconnect();
	}
	const [holder] = await holdingSettled;
	if (holder!.status === "rejected") throw holder!.reason;
	const [result] = await admission!;
	return { result: result!, isolation };
}

async function expectAdmissionRollback(f: Fixture, quoteId: string, existingJobs = 0) {
	expect(await client.generationQuote.count({ where: { id: quoteId } })).toBe(0);
	expect(await client.auditLog.count({ where: { targetId: quoteId } })).toBe(0);
	expect(
		await client.moderationReview.count({ where: { targetType: "QUOTE", targetId: quoteId } }),
	).toBe(0);
	expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(existingJobs);
	expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(
		existingJobs,
	);
	expect(
		await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
	).toBe(existingJobs);
	expect(
		await client.generationJobAsset.count({ where: { assetId: f.asset.id, role: "INPUT" } }),
	).toBe(existingJobs);
	expect(await client.outboxEvent.count({ where: { aggregateId: f.asset.id } })).toBe(0);
	expect(await client.mediaAsset.findUnique({ where: { id: f.asset.id } })).toMatchObject({
		status: "READY",
		deletedAt: null,
		verificationGeneration: 1,
	});
	expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
}

describe("pre-reviewed temporary image admission with PostgreSQL", () => {
	beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	beforeAll(() => {
		client = new PrismaClient({
			adapter: new PrismaPg({ connectionString: isolatedUrl(), max: 60 }),
		});
	});
	afterAll(async () => {
		await client?.$disconnect();
	});

	it("admits a matching READY temporary reference without restarting under Serializable", async () => {
		const f = await createPreReviewedAdmissionFixture(client);
		const isolation: string[] = [];
		const result = await createGenerationJobTransaction(f.input(), observedTransactions(isolation));
		expect(result.replayed).toBe(false);
		expect(result.job.creditsReserved).toBe(5n);
		expect(result.verificationAssetId).toBeUndefined();
		expect(result.continuationEventIds).toHaveLength(1);
		expect(
			await client.outboxEvent.findUnique({ where: { id: result.continuationEventIds![0] } }),
		).toMatchObject({ eventType: "JOB_CREATED", aggregateId: result.job.id });
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		expect(isolation).toEqual(["ReadCommitted"]);
	});

	it("admits all 50 independent pre-reviewed owners without a provisional transaction or extra review", async () => {
		const fixtures: Fixture[] = [];
		for (let index = 0; index < 50; index += 1)
			fixtures.push(await createPreReviewedAdmissionFixture(client));
		const isolation: string[] = [];
		const observed = observedTransactions(isolation);
		const results = await Promise.allSettled(
			fixtures.map((f) => createGenerationJobTransaction(f.input(), observed)),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected"
				? [
						{
							name: result.reason?.name,
							code: result.reason?.code,
							message: result.reason?.message,
						},
					]
				: [],
		);
		expect(failures).toEqual([]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
		expect(isolation).toEqual(Array.from({ length: 50 }, () => "ReadCommitted"));
		for (let index = 0; index < fixtures.length; index += 1) {
			const f = fixtures[index]!;
			const result = results[index]!;
			if (result.status === "rejected") throw result.reason;
			expect(result.value.replayed).toBe(false);
			expect(result.value.verificationAssetId).toBeUndefined();
			expect(result.value.continuationEventIds).toHaveLength(1);
			expect(
				await client.outboxEvent.findUnique({
					where: { id: result.value.continuationEventIds![0] },
				}),
			).toMatchObject({ eventType: "JOB_CREATED", aggregateId: result.value.job.id });
			expect(await client.outboxEvent.count({ where: { aggregateId: f.asset.id } })).toBe(0);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		}
	});

	it("replays the same key concurrently with one job, reserve and durable dispatch", async () => {
		const f = await createPreReviewedAdmissionFixture(client);
		const input = f.input();
		const isolation: string[] = [];
		const observed = observedTransactions(isolation);
		const results = await Promise.all([
			createGenerationJobTransaction(input, observed),
			createGenerationJobTransaction(input, observed),
		]);
		expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
		expect(results.filter((result) => result.replayed)).toHaveLength(1);
		expect(isolation).toEqual(["ReadCommitted", "ReadCommitted"]);
		expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(await client.outboxEvent.count({ where: { aggregateId: results[0]!.job.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 95n, reserved: 5n, debt: 0n },
		});
	});

	it("cannot overdraw one account when two different requests race for its last five credits", async () => {
		const f = await createPreReviewedAdmissionFixture(client, { amount: 5n });
		const isolation: string[] = [];
		const observed = observedTransactions(isolation);
		const results = await Promise.allSettled([
			createGenerationJobTransaction(f.input(), observed),
			createGenerationJobTransaction(f.input(f.prepare(":second")), observed),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const failure = results.find((result) => result.status === "rejected");
		expect(failure?.status === "rejected" ? failure.reason.message : null).toBe(
			"INSUFFICIENT_CREDITS",
		);
		expect(isolation).toEqual(["ReadCommitted", "ReadCommitted"]);
		expect(await client.generationQuote.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.account.id, type: "RESERVE" } }),
		).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
			valid: true,
			account: { spendable: 0n, reserved: 5n, debt: 0n },
		});
	});

	it.each(["full refund", "partial refund", "settled refund debt"] as const)(
		"reads the committed %s after waiting for the real credit account lock",
		async (kind) => {
			const f = await createPreReviewedAdmissionFixture(client, {
				amount: kind === "partial refund" ? 10n : 5n,
			});
			let existingJobs = 0;
			if (kind === "settled refund debt") {
				const previous = await createGenerationJobTransaction(f.input(f.prepare(":prior")), client);
				await settleCredits(
					{
						reservationId: previous.reservation.id,
						amount: 5n,
						referenceKey: `${f.ownerId}:settle`,
					},
					client,
				);
				await createCreditGrant(
					{ accountId: f.account.id, amount: 5n, referenceKey: `${f.ownerId}:unrelated-grant` },
					client,
				);
				existingJobs = 1;
			}
			const { result, isolation } = await runBehindAccountLock(f, f.input(), {
				mutate: (tx) =>
					refundCreditGrant(
						{
							accountId: f.account.id,
							amount: 5n,
							grantReferenceKey: f.grantReferenceKey,
							referenceKey: `${f.ownerId}:refund`,
						},
						tx,
					),
			});
			expect(isolation).toEqual(["ReadCommitted"]);
			if (kind === "partial refund") {
				expect(result.status).toBe("fulfilled");
				expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
					valid: true,
					account: { spendable: 0n, reserved: 5n, debt: 0n },
				});
			} else {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected")
					expect(result.reason.message).toBe(
						kind === "full refund" ? "INSUFFICIENT_CREDITS" : "CREDIT_DEBT_OUTSTANDING",
					);
				await expectAdmissionRollback(f, f.quoteId, existingJobs);
				expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
					valid: true,
					account:
						kind === "full refund"
							? { spendable: 0n, reserved: 0n, debt: 0n }
							: { spendable: 5n, reserved: 0n, debt: 5n },
				});
			}
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: f.account.id, type: "REFUND" },
				}),
			).toBe(1);
		},
	);

	it.each(["quote", "temporary reference", "credit lot"] as const)(
		"rolls back every admission write when its %s expires during a real account lock wait",
		async (kind) => {
			const f = await createPreReviewedAdmissionFixture(client);
			const deadline = new Date(Date.now() + 1000);
			if (kind === "temporary reference") {
				f.reference.expiresAt = deadline.toISOString();
				f.reference.createdAt = new Date(deadline.getTime() - 86_400_000).toISOString();
				await client.storageUsageReservation.update({
					where: { referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${f.asset.id}` },
					data: { expiresAt: deadline },
				});
				await client.mediaAsset.update({
					where: { id: f.asset.id },
					data: { deleteAfter: deadline },
				});
			} else if (kind === "credit lot") {
				await client.creditLot.updateMany({
					where: { accountId: f.account.id },
					data: { expiresAt: deadline },
				});
			}
			const prepared = f.prepare();
			if (kind === "quote") {
				prepared.expiresAt = deadline;
				prepared.moderation.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(prepared);
			}
			const { result, isolation } = await runBehindAccountLock(f, f.input(prepared), {
				whileBlocked: async () => {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
					);
					const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
						SELECT clock_timestamp() AS "now"`;
					expect(clock!.now.getTime()).toBeGreaterThan(deadline.getTime());
				},
			});
			expect(isolation).toEqual(["ReadCommitted"]);
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason.message).toBe(
					kind === "quote"
						? "Quote expired"
						: kind === "temporary reference"
							? "TEMPORARY_REFERENCE_EXPIRED"
							: "INSUFFICIENT_CREDITS",
				);
			await expectAdmissionRollback(f, f.quoteId);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({
				valid: true,
				account: { spendable: 100n, reserved: 0n, debt: 0n },
			});
			expect(await client.creditLedgerEntry.count({ where: { accountId: f.account.id } })).toBe(1);
		},
	);
});
