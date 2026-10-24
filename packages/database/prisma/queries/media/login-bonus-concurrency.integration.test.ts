import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { adjustAdminCredits } from "../admin-credits";
import { ensureCreditAccountInTransaction } from "./credit-accounts";
import {
	createCreditGrant,
	getCreditInvariantReport,
	refundCreditGrant,
	reserveCredits,
	reserveCreditsInTransaction,
	settleCredits,
} from "./credits";
import {
	ensureFreeMonthlyCreditGrant,
	hasMatchingFreeMonthlyCreditGrant,
} from "./free-plan-credits";
import { ensureOneTimeLoginCreditGrant } from "./login-bonus";
import { isDatabaseSerializationConflict, runReadCommitted, runSerializable } from "./types";

const prefix = `login-concurrency-${crypto.randomUUID()}`;
let client: PrismaClient;
const additionalClients: PrismaClient[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function isolatedUrl() {
	if (process.env.DATABASE_URL) throw new Error("DATABASE_URL_MUST_BE_UNSET_FOR_LOGIN_BONUS_TEST");
	const value = process.env.TEST_DATABASE_URL ?? "";
	const target = new URL(value);
	if (
		!["postgres:", "postgresql:"].includes(target.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
		!/(^|[_-])test([_-]|$)/.test(target.pathname.slice(1)) ||
		Number(target.port) < 49152 ||
		Number(target.port) > 65535
	)
		throw new Error("DISPOSABLE_LOCAL_LOGIN_BONUS_DATABASE_REQUIRED");
	return value;
}

function observeTransactions(database = client) {
	const observations = { isolations: [] as string[], serializationConflicts: 0 };
	const observed = new Proxy(database, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return async (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options: { isolationLevel: Prisma.TransactionIsolationLevel },
				) => {
					observations.isolations.push(options.isolationLevel);
					try {
						return await target.$transaction(operation, options);
					} catch (error) {
						if (isDatabaseSerializationConflict(error)) observations.serializationConflicts++;
						throw error;
					}
				};
			return Reflect.get(target, key, receiver);
		},
	});
	return { observed, observations };
}

function pauseAccountCreation(database = client) {
	const reached = deferred();
	const release = deferred();
	let first = true;
	const observed = new Proxy(database, {
		get(target, key, receiver) {
			if (key === "$transaction")
				return (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options: { isolationLevel: Prisma.TransactionIsolationLevel },
				) =>
					target.$transaction(
						async (tx) =>
							operation(
								new Proxy(tx, {
									get(transaction, property, transactionReceiver) {
										if (property !== "creditAccount")
											return Reflect.get(transaction, property, transactionReceiver);
										return new Proxy(transaction.creditAccount, {
											get(account, member, accountReceiver) {
												const value = Reflect.get(account, member, accountReceiver);
												if (member !== "createMany") return value;
												return async (...args: unknown[]) => {
													if (first) {
														first = false;
														reached.resolve();
														await release.promise;
													}
													return Reflect.apply(value, account, args);
												};
											},
										});
									},
								}),
							),
						options,
					);
			return Reflect.get(target, key, receiver);
		},
	});
	return { observed, reached, release };
}

async function waitForAccountLock(applicationName: string) {
	const deadline = Date.now() + 5000;
	do {
		const [row] = await client.$queryRaw<Array<{ blocked: boolean }>>`
			SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE application_name = ${applicationName} AND wait_event_type = 'Lock') AS blocked`;
		if (row?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	throw new Error("EXPECTED_LOGIN_BONUS_ACCOUNT_LOCK_WAIT");
}

async function user(label: string, isAnonymous = false) {
	const ownerId = `${prefix}-${label}-${crypto.randomUUID()}`;
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

const reference = (ownerId: string) => `login-bonus:user:${ownerId}:v1`;
async function accountFor(ownerId: string) {
	return client.creditAccount.findUniqueOrThrow({
		where: { ownerType_ownerId: { ownerType: "USER", ownerId } },
	});
}
async function fundedUser(label: string, amount = 10n, expiresAt?: Date) {
	const ownerId = await user(label);
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	const grantReferenceKey = `fixture:${ownerId}`;
	await createCreditGrant(
		{ accountId: account.id, amount, referenceKey: grantReferenceKey, expiresAt },
		client,
	);
	return { ownerId, accountId: account.id, grantReferenceKey };
}
async function jobFor(ownerId: string, credits: bigint) {
	// Ledger-only fixture: this job never dispatches a provider or consumes a Workflow slot.
	const fields = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "login-ledger-test",
		catalogVersion: "test",
		pricingVersion: "test",
		inputSnapshot: {},
		pricingSnapshot: {},
	};
	const quote = await client.generationQuote.create({
		data: {
			...fields,
			credits,
			costMicros: 0n,
			expiresAt: new Date(Date.now() + 60000),
		},
	});
	return client.generationJob.create({
		data: {
			...fields,
			quoteId: quote.id,
			idempotencyKey: crypto.randomUUID(),
			creditsReserved: credits,
		},
	});
}

describe("login bonus concurrency with the generated Prisma client", () => {
	beforeEach(() => vi.stubEnv("MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	beforeAll(() => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl() }) });
	});
	afterAll(async () => {
		// This database is disposable. Keep immutable financial evidence intact.
		await Promise.all(additionalClients.map((database) => database.$disconnect()));
		await client?.$disconnect();
	});

	it("retains Serializable before rollout while receipt replay remains transaction-free", async () => {
		vi.stubEnv("MEDIA_LOGIN_BONUS_READ_COMMITTED_ENABLED", undefined);
		const ownerId = await user("default-ssi");
		const { observed, observations } = observeTransactions();
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, observed)).resolves.toMatchObject({
			status: "GRANTED",
		});
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, observed)).resolves.toMatchObject({
			status: "ALREADY_GRANTED",
		});
		expect(observations.isolations).toEqual(["Serializable"]);
		expect((await accountFor(ownerId)).spendableCredits).toBe(10n);
	});

	it("issues one ten-credit lifetime grant across simultaneous sessions and repeated calls", async () => {
		const ownerId = await user("same-account");
		const { observed, observations } = observeTransactions();
		const results = await Promise.all(
			Array.from({ length: 24 }, () => ensureOneTimeLoginCreditGrant({ ownerId }, observed)),
		);
		expect(results.filter(({ status }) => status === "GRANTED")).toHaveLength(1);
		expect(results.filter(({ status }) => status === "ALREADY_GRANTED")).toHaveLength(23);
		expect(observations.serializationConflicts).toBe(0);
		expect(observations.isolations.every((isolation) => isolation === "ReadCommitted")).toBe(true);
		const account = await accountFor(ownerId);
		expect(account).toMatchObject({ spendableCredits: 10n, reservedCredits: 0n, creditDebt: 0n });
		const receipt = await client.creditLedgerEntry.findUniqueOrThrow({
			where: { referenceKey: reference(ownerId) },
		});
		expect(receipt).toMatchObject({ accountId: account.id, type: "GRANT", amount: 10n });
		expect(await client.creditLot.count({ where: { accountId: account.id } })).toBe(1);
		const attempts = observations.isolations.length;
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, observed)).resolves.toMatchObject({
			status: "ALREADY_GRANTED",
		});
		expect(observations.isolations).toHaveLength(attempts);
		expect(await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
			account,
		);
		expect(
			await client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: reference(ownerId) },
			}),
		).toEqual(receipt);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("recognizes the historical five-credit receipt without a top-up or transaction", async () => {
		const ownerId = await user("historical-five");
		const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 5n,
				referenceKey: reference(ownerId),
				expiresAt: null,
				metadata: { program: "one-time-login-bonus-v1" },
			},
			client,
		);
		const before = await accountFor(ownerId);
		const receipt = await client.creditLedgerEntry.findUniqueOrThrow({
			where: { referenceKey: reference(ownerId) },
		});
		const { observed, observations } = observeTransactions();
		const results = await Promise.all(
			Array.from({ length: 24 }, () => ensureOneTimeLoginCreditGrant({ ownerId }, observed)),
		);
		expect(results.every(({ status }) => status === "ALREADY_GRANTED")).toBe(true);
		expect(observations.isolations).toEqual([]);
		expect(await accountFor(ownerId)).toEqual(before);
		expect(before.spendableCredits).toBe(5n);
		expect(await client.creditLot.count({ where: { accountId: account.id } })).toBe(1);
		expect(await client.creditLedgerEntry.findMany({ where: { accountId: account.id } })).toEqual([
			receipt,
		]);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("disables monthly minting while preserving historical monthly receipts and balances", async () => {
		const ownerId = await user("disabled-monthly");
		const now = new Date();
		const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const { observed, observations } = observeTransactions();
		await expect(
			ensureFreeMonthlyCreditGrant({ ownerId, amount: 25n, now }, observed),
		).resolves.toEqual({ status: "DISABLED" });
		expect(observations.isolations).toEqual([]);
		expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
		await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		const account = await accountFor(ownerId);
		const historicalReference = `free-plan:user:${ownerId}:${periodStart.toISOString().slice(0, 7)}`;
		await createCreditGrant(
			{
				accountId: account.id,
				amount: 25n,
				referenceKey: historicalReference,
				expiresAt: periodEnd,
				metadata: {
					planId: "free",
					periodStart: periodStart.toISOString(),
					periodEnd: periodEnd.toISOString(),
				},
			},
			client,
		);
		const before = await accountFor(ownerId);
		const historicalReceipt = await client.creditLedgerEntry.findUniqueOrThrow({
			where: { referenceKey: historicalReference },
		});
		const results = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				ensureFreeMonthlyCreditGrant(
					{ ownerId, amount: 25n, now: index % 2 ? periodEnd : now },
					observed,
				),
			),
		);
		expect(results.every(({ status }) => status === "DISABLED")).toBe(true);
		expect(observations.isolations).toEqual([]);
		await expect(
			hasMatchingFreeMonthlyCreditGrant({ ownerId, amount: 25n, now }, client),
		).resolves.toBe(true);
		expect(await accountFor(ownerId)).toEqual(before);
		expect(before.spendableCredits).toBe(35n);
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "GRANT" } }),
		).toBe(2);
		expect(
			await client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: historicalReference },
			}),
		).toEqual(historicalReceipt);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("admits 50 independent funded users without a serialization retry", async () => {
		const cases: Array<{ ownerId: string; accountId: string }> = [];
		for (let index = 0; index < 50; index++) {
			const ownerId = await user(`funded-${index}`);
			const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
			await createCreditGrant(
				{ accountId: account.id, amount: 100n, referenceKey: `fixture:${ownerId}` },
				client,
			);
			cases.push({ ownerId, accountId: account.id });
		}
		const { observed, observations } = observeTransactions();
		const results = await Promise.allSettled(
			cases.map(({ ownerId }) => ensureOneTimeLoginCreditGrant({ ownerId }, observed)),
		);
		const succeeded = results.filter((result) => result.status === "fulfilled").length;
		console.info("login-bonus.concurrent-cohort", {
			expected: cases.length,
			succeeded,
			failed: cases.length - succeeded,
			transactionAttempts: observations.isolations.length,
			serializationConflicts: observations.serializationConflicts,
		});
		expect(succeeded).toBe(50);
		expect(observations.serializationConflicts).toBe(0);
		for (const { ownerId, accountId } of cases) {
			expect(
				await client.creditAccount.findUniqueOrThrow({ where: { id: accountId } }),
			).toMatchObject({ spendableCredits: 110n, reservedCredits: 0n, creditDebt: 0n });
			expect(
				await client.creditLedgerEntry.count({
					where: { referenceKey: `login-bonus:user:${ownerId}:v1`, accountId },
				}),
			).toBe(1);
			expect(await getCreditInvariantReport(accountId, client)).toMatchObject({ valid: true });
		}
	});

	it("creates accounts for 50 independent first claims without a serialization retry", async () => {
		const owners: string[] = [];
		for (let index = 0; index < 50; index++) owners.push(await user(`new-${index}`));
		const { observed, observations } = observeTransactions();
		const results = await Promise.all(
			owners.map((ownerId) => ensureOneTimeLoginCreditGrant({ ownerId }, observed)),
		);
		expect(results.filter(({ status }) => status === "GRANTED")).toHaveLength(50);
		expect(observations.serializationConflicts).toBe(0);
		expect(observations.isolations).toEqual(Array(50).fill("ReadCommitted"));
		for (const ownerId of owners) {
			const account = await accountFor(ownerId);
			expect(account).toMatchObject({ spendableCredits: 10n, reservedCredits: 0n, creditDebt: 0n });
			expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
		}
	});

	it.each([
		["historical-monthly", "ssi-first"],
		["historical-monthly", "login-first"],
		["admin", "ssi-first"],
		["admin", "login-first"],
	] as const)(
		"safely creates one account with concurrent %s and lifetime grants: %s",
		async (kind, order) => {
			const ownerId = await user(`${kind}-${order}`);
			const { observed, observations } = observeTransactions();
			const paused = pauseAccountCreation(observed);
			const ssiGrant = (database: PrismaClient) =>
				kind === "historical-monthly"
					? runSerializable(database, async (tx) => {
							const account = await ensureCreditAccountInTransaction(
								{ ownerType: "USER", ownerId },
								tx,
							);
							// Model an old producer during drain without reopening current monthly minting.
							await createCreditGrant(
								{
									accountId: account.id,
									amount: 25n,
									referenceKey: `historical-monthly:${ownerId}`,
									metadata: { planId: "free" },
								},
								tx,
							);
						})
					: adjustAdminCredits(
							{
								scope: { kind: "platform" },
								actorId: ownerId,
								idempotencyKey: `admin-${crypto.randomUUID()}`,
								ownerType: "USER",
								ownerId,
								action: "grant",
								credits: 7,
								reason: "Concurrent first-account regression",
							},
							database,
						);
			const login = (database: PrismaClient) =>
				ensureOneTimeLoginCreditGrant({ ownerId }, database);
			const first = (order === "ssi-first" ? ssiGrant : login)(paused.observed);
			// Install the rejection handler before deliberately suspending the transaction.
			const settled = Promise.allSettled([first]);
			try {
				await paused.reached.promise;
				expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
				await (order === "ssi-first" ? login : ssiGrant)(client);
			} finally {
				paused.release.resolve();
			}
			const [result] = await settled;
			if (result?.status === "rejected") throw result.reason;
			const account = await accountFor(ownerId);
			expect(account.spendableCredits).toBe(kind === "historical-monthly" ? 35n : 17n);
			expect(observations.serializationConflicts).toBe(order === "ssi-first" ? 1 : 0);
			expect(observations.isolations).toEqual(
				order === "ssi-first" ? ["Serializable", "Serializable"] : ["ReadCommitted"],
			);
			expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(1);
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: account.id, type: "GRANT" } }),
			).toBe(2);
			expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
		},
	);

	it.each(["USER", "ORGANIZATION"] as const)(
		"returns the complete %s account without rewriting an existing row and rolls back failed creation",
		async (ownerType) => {
			const owner = { ownerType, ownerId: `${prefix}-helper-${crypto.randomUUID()}` };
			const created = await runSerializable(client, (tx) =>
				ensureCreditAccountInTransaction(owner, tx),
			);
			expect(created).toMatchObject({
				...owner,
				spendableCredits: 0n,
				reservedCredits: 0n,
				creditDebt: 0n,
				version: 0,
			});
			const version = () => client.$queryRaw<Array<{ xmin: string }>>`
				SELECT xmin::text FROM credit_account WHERE id = ${created.id}`;
			const before = await version();
			await expect(
				runReadCommitted(client, (tx) => ensureCreditAccountInTransaction(owner, tx)),
			).resolves.toEqual(created);
			expect(await version()).toEqual(before);

			const failedOwner = { ...owner, ownerId: `${owner.ownerId}-rollback` };
			await expect(
				runSerializable(client, async (tx) => {
					await ensureCreditAccountInTransaction(failedOwner, tx);
					throw new Error("EXPECTED_ROLLBACK");
				}),
			).rejects.toThrow("EXPECTED_ROLLBACK");
			expect(await client.creditAccount.count({ where: failedOwner })).toBe(0);
		},
	);

	it("retries an older organization SSI snapshot after an RC account creator commits", async () => {
		const owner = { ownerType: "ORGANIZATION" as const, ownerId: `${prefix}-ssi-organization` };
		const { observed, observations } = observeTransactions();
		const paused = pauseAccountCreation(observed);
		const pending = runSerializable(paused.observed, (tx) =>
			ensureCreditAccountInTransaction(owner, tx),
		);
		const settled = Promise.allSettled([pending]);
		let winner;
		try {
			await paused.reached.promise;
			winner = await runReadCommitted(client, (tx) => ensureCreditAccountInTransaction(owner, tx));
		} finally {
			paused.release.resolve();
		}
		const [result] = await settled;
		if (result?.status === "rejected") throw result.reason;
		expect(result?.status === "fulfilled" && result.value).toEqual(winner);
		expect(observations.serializationConflicts).toBe(1);
		expect(observations.isolations).toEqual(["Serializable", "Serializable"]);
		expect(await client.creditAccount.count({ where: owner })).toBe(1);
	});

	it.each(["USER", "ORGANIZATION"] as const)(
		"waits for an uncommitted SSI %s account creator and returns its committed account under RC",
		async (ownerType) => {
			const ownerId =
				ownerType === "USER" ? await user("uncommitted") : `${prefix}-uncommitted-organization`;
			const owner = { ownerType, ownerId };
			const inserted = deferred();
			const release = deferred();
			const applicationName = `login-create-wait-${crypto.randomUUID()}`;
			const waitingClient = new PrismaClient({
				adapter: new PrismaPg({
					connectionString: isolatedUrl(),
					application_name: applicationName,
				}),
			});
			additionalClients.push(waitingClient);
			const creator = runSerializable(client, async (tx) => {
				const account = await ensureCreditAccountInTransaction(owner, tx);
				inserted.resolve();
				await release.promise;
				return account;
			});
			const creatorResult = Promise.allSettled([creator]);
			let waitingResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
			try {
				await inserted.promise;
				const waiting =
					ownerType === "USER"
						? ensureOneTimeLoginCreditGrant({ ownerId }, waitingClient)
						: runReadCommitted(waitingClient, (tx) => ensureCreditAccountInTransaction(owner, tx));
				waitingResult = Promise.allSettled([waiting]);
				await waitForAccountLock(applicationName);
			} finally {
				release.resolve();
			}
			const [created] = await creatorResult;
			const [waited] = (await waitingResult) ?? [];
			if (created?.status === "rejected") throw created.reason;
			if (waited?.status === "rejected") throw waited.reason;
			expect(created?.status).toBe("fulfilled");
			expect(waited?.status).toBe("fulfilled");
			const account = await client.creditAccount.findUniqueOrThrow({
				where: { ownerType_ownerId: owner },
			});
			expect(account.id).toBe(created?.status === "fulfilled" && created.value.id);
			expect(account.spendableCredits).toBe(ownerType === "USER" ? 10n : 0n);
			if (ownerType === "ORGANIZATION")
				expect(waited?.status === "fulfilled" && waited.value).toEqual(account);
			expect(await client.creditAccount.count({ where: owner })).toBe(1);
			expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
		},
	);

	it("returns the exact receipt without starting a transaction after the gift is fully spent", async () => {
		const ownerId = await user("spent");
		await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		const account = await accountFor(ownerId);
		const job = await jobFor(ownerId, 10n);
		const reservation = await reserveCredits(
			{ accountId: account.id, jobId: job.id, amount: 10n, referenceKey: `reserve:${job.id}` },
			client,
		);
		await settleCredits(
			{ reservationId: reservation.id, amount: 10n, referenceKey: `settle:${job.id}` },
			client,
		);
		const { observed, observations } = observeTransactions();
		const results = await Promise.all(
			Array.from({ length: 24 }, () => ensureOneTimeLoginCreditGrant({ ownerId }, observed)),
		);
		expect(results.every(({ status }) => status === "ALREADY_GRANTED")).toBe(true);
		expect(observations.isolations).toEqual([]);
		expect((await accountFor(ownerId)).spendableCredits).toBe(0n);
		expect(
			await client.creditLedgerEntry.count({ where: { referenceKey: reference(ownerId) } }),
		).toBe(1);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("does not reissue a revoked gift or ignore current principal eligibility", async () => {
		const ownerId = await user("revoked");
		await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		const account = await accountFor(ownerId);
		await refundCreditGrant(
			{
				accountId: account.id,
				amount: 10n,
				grantReferenceKey: reference(ownerId),
				referenceKey: `refund:${ownerId}`,
			},
			client,
		);
		const { observed, observations } = observeTransactions();
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, observed)).resolves.toMatchObject({
			status: "ALREADY_GRANTED",
		});
		await client.user.update({ where: { id: ownerId }, data: { isAnonymous: true } });
		await expect(ensureOneTimeLoginCreditGrant({ ownerId }, observed)).resolves.toEqual({
			status: "ANONYMOUS_USER",
		});
		await expect(
			ensureOneTimeLoginCreditGrant({ ownerId: `${ownerId}-missing` }, observed),
		).resolves.toEqual({ status: "USER_NOT_FOUND" });
		expect(observations.isolations).toEqual([]);
		expect((await accountFor(ownerId)).spendableCredits).toBe(0n);
		expect(await getCreditInvariantReport(account.id, client)).toMatchObject({ valid: true });
	});

	it("expires old lots atomically before adding the ten-credit gift", async () => {
		const { ownerId, accountId } = await fundedUser("expired", 10n, new Date(Date.now() - 1000));
		await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		expect(await accountFor(ownerId)).toMatchObject({ spendableCredits: 10n, creditDebt: 0n });
		expect(
			await client.creditLedgerEntry.count({ where: { accountId, type: "EXPIRE", amount: 10n } }),
		).toBe(1);
		expect(await getCreditInvariantReport(accountId, client)).toMatchObject({ valid: true });
	});

	it("forces an older SSI consumer to retry after the RC gift writes the account version", async () => {
		const { ownerId, accountId } = await fundedUser("old-ssi-consumer", 100n);
		const job = await jobFor(ownerId, 103n);
		const read = deferred(),
			release = deferred();
		let first = true;
		const attempts: string[] = [];
		const consumer = runSerializable(
			client,
			async (tx) => {
				await tx.creditAccount.findUniqueOrThrow({ where: { id: accountId } });
				if (first) {
					first = false;
					read.resolve();
					await release.promise;
				}
				return reserveCreditsInTransaction(
					{ accountId, jobId: job.id, amount: 103n, referenceKey: `reserve:${job.id}` },
					tx,
				);
			},
			{ onAttempt: ({ outcome }) => attempts.push(outcome) },
		);
		const settled = Promise.allSettled([consumer]);
		try {
			await read.promise;
			await ensureOneTimeLoginCreditGrant({ ownerId }, client);
		} finally {
			release.resolve();
		}
		const [result] = await settled;
		if (result?.status === "rejected") throw result.reason;
		expect(attempts).toContain("SERIALIZATION_CONFLICT");
		expect(await accountFor(ownerId)).toMatchObject({
			spendableCredits: 7n,
			reservedCredits: 103n,
			creditDebt: 0n,
			version: 3,
		});
		expect(await getCreditInvariantReport(accountId, client)).toMatchObject({ valid: true });
	});

	it("waits for an SSI refund and repays the newly committed debt through the same immutable grant", async () => {
		const { ownerId, accountId, grantReferenceKey } = await fundedUser("refund-before-gift");
		const job = await jobFor(ownerId, 10n);
		const reservation = await reserveCredits(
			{ accountId, jobId: job.id, amount: 10n, referenceKey: `reserve:${job.id}` },
			client,
		);
		await settleCredits(
			{ reservationId: reservation.id, amount: 10n, referenceKey: `settle:${job.id}` },
			client,
		);
		const written = deferred(),
			release = deferred();
		const refund = runSerializable(client, async (tx) => {
			await refundCreditGrant(
				{ accountId, amount: 10n, grantReferenceKey, referenceKey: `refund:${ownerId}` },
				tx,
			);
			written.resolve();
			await release.promise;
		});
		const refundResult = Promise.allSettled([refund]);
		await written.promise;
		const applicationName = `login-wait-${crypto.randomUUID()}`;
		const waitingClient = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: isolatedUrl(),
				application_name: applicationName,
				max: 1,
			}),
		});
		additionalClients.push(waitingClient);
		const { observed, observations } = observeTransactions(waitingClient);
		const gift = ensureOneTimeLoginCreditGrant({ ownerId }, observed);
		const giftResult = Promise.allSettled([gift]);
		try {
			await waitForAccountLock(applicationName);
		} finally {
			release.resolve();
		}
		for (const result of [...(await refundResult), ...(await giftResult)])
			if (result.status === "rejected") throw result.reason;
		expect(observations.isolations).toEqual(["ReadCommitted"]);
		expect(observations.serializationConflicts).toBe(0);
		expect(await accountFor(ownerId)).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect(
			await client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: reference(ownerId) },
			}),
		).toMatchObject({ amount: 0n, lotId: null });
		expect(
			await client.creditLedgerEntry.findUniqueOrThrow({
				where: { referenceKey: `${reference(ownerId)}:debt-repayment` },
			}),
		).toMatchObject({ amount: 10n });
		expect(await getCreditInvariantReport(accountId, client)).toMatchObject({ valid: true });
	});

	it.each(["amount", "metadata", "owner"] as const)(
		"rejects a conflicting lifetime receipt instead of declaring success: %s",
		async (kind) => {
			const ownerId = await user(`conflict-${kind}`);
			const otherOwnerId = kind === "owner" ? await user("other-owner") : ownerId;
			const account = await client.creditAccount.create({
				data: { ownerType: "USER", ownerId: otherOwnerId },
			});
			await createCreditGrant(
				{
					accountId: account.id,
					amount: kind === "amount" ? 7n : 5n,
					referenceKey: reference(ownerId),
					expiresAt: null,
					metadata: {
						program: kind === "metadata" ? "different-program" : "one-time-login-bonus-v1",
					},
				},
				client,
			);
			const before = await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
			await expect(ensureOneTimeLoginCreditGrant({ ownerId }, client)).rejects.toThrow(
				"IDEMPOTENCY_CONFLICT",
			);
			expect(await client.creditAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
				before,
			);
			expect(
				await client.creditLedgerEntry.count({ where: { referenceKey: reference(ownerId) } }),
			).toBe(1);
			if (kind === "owner")
				expect(await client.creditAccount.count({ where: { ownerType: "USER", ownerId } })).toBe(0);
		},
	);
});
