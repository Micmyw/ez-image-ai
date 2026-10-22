import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { TEMPORARY_REFERENCE_RESERVATION_PREFIX, type TemporaryReference } from "@repo/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { lockMediaAssetGenerationBindings } from "./asset-binding-locks";
import { markMediaAssetDeletedTransaction } from "./assets";
import { createCreditGrant, getCreditInvariantReport } from "./credits";
import { createGenerationJobTransaction } from "./jobs";
import {
	createModeratedGenerationQuoteTransaction,
	fingerprintGenerationQuoteSecurityPayload,
} from "./quotes";
import type { CreateGenerationJobInput, CreateModeratedGenerationQuoteInput } from "./types";

let client: PrismaClient;
const prefix = `merged-submit-${crypto.randomUUID()}`;

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

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function observedTransactions(isolation: string[]) {
	return new Proxy(client, {
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

async function waitForDatabaseLock(applicationName: string, event = "advisory") {
	const deadline = Date.now() + 5000;
	do {
		const [state] = await client.$queryRaw<Array<{ blocked: boolean }>>`
			SELECT EXISTS (
				SELECT 1 FROM pg_stat_activity
				WHERE application_name = ${applicationName}
				  AND wait_event_type = 'Lock' AND wait_event = ${event}
			) AS "blocked"`;
		if (state?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	throw new Error("EXPECTED_ADMISSION_DATABASE_LOCK_WAIT");
}

async function fixture(amount = 100n) {
	const ownerId = `${prefix}-${crypto.randomUUID()}`;
	const account = await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount, referenceKey: `${ownerId}:grant` },
		client,
	);
	const quoteId = `submit_${crypto.randomUUID()}`;
	function prepare(prompt = "A fixed simulated mountain landscape") {
		const observedAt = new Date().toISOString();
		const quote = {
			quoteId,
			ownerType: "USER" as const,
			ownerId,
			submittedByUserId: ownerId,
			productKey: "image-nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 5n,
			costMicros: 100n,
			inputSnapshot: {
				kind: "text-to-image",
				prompt,
				submissionFingerprint: createHash("sha256").update(prompt).digest("hex"),
			},
			pricingSnapshot: {},
			expiresAt: new Date(Date.now() + 60_000),
		};
		return {
			...quote,
			moderation: {
				decision: "ALLOW" as const,
				provider: "waffo",
				ruleVersion: "test-rule",
				reasonCode: "NO_POLICY_MATCH",
				inputFingerprint: fingerprintGenerationQuoteSecurityPayload(quote),
				retry: { failures: 0, lastErrorCode: "", startedAt: observedAt, lastFailureAt: observedAt },
			},
		};
	}
	function input(
		preparedQuote: CreateModeratedGenerationQuoteInput = prepare(),
	): CreateGenerationJobInput {
		return {
			ownerType: "USER",
			ownerId,
			submittedByUserId: ownerId,
			quoteId,
			idempotencyKey: `${ownerId}:request`,
			preparedQuote,
			inputAssetIds: [],
			expectedModerationRuleVersion: "test-rule",
			expectedModerationProvider: "waffo",
			maximumDailyCostMicros: 1000n,
			maximumStorageBytes: 10_000_000_000n,
			validateCurrentEligibility: true,
		};
	}
	return { ownerId, account, quoteId, prepare, input };
}

async function imageFixture(amount = 100n) {
	const base = await fixture(amount);
	const now = new Date();
	const reference: TemporaryReference = {
		v: 1,
		ownerId: base.ownerId,
		assetId: crypto.randomUUID(),
		contentType: "image/png",
		bytes: 1000,
		checksum: "b".repeat(64),
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
	};
	await client.storageUsageReservation.create({
		data: {
			ownerType: "USER",
			ownerId: base.ownerId,
			bytes: BigInt(reference.bytes),
			status: "COMMITTED",
			referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${reference.assetId}`,
			expiresAt: new Date(reference.expiresAt),
		},
	});
	function prepare(): CreateModeratedGenerationQuoteInput {
		const quote = base.prepare();
		const prepared = {
			...quote,
			inputSnapshot: {
				...quote.inputSnapshot,
				kind: "image-to-image",
				sourceAssetId: reference.assetId,
				editContext: { kind: "ROOT", rootAssetId: reference.assetId },
				temporaryReference: reference,
			},
		};
		prepared.moderation.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(prepared);
		return prepared;
	}
	function input(prepared = prepare()): CreateGenerationJobInput {
		return {
			...base.input(prepared),
			inputAssetIds: [reference.assetId],
			edit: { kind: "ROOT", rootAssetId: reference.assetId },
		};
	}
	return { ...base, reference, prepare, input };
}

describe("merged quote and generation admission transaction", () => {
	beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
	afterEach(() => vi.unstubAllEnvs());
	beforeAll(() => {
		client = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl() }) });
	});
	afterAll(async () => {
		await client?.$disconnect();
	});

	it("commits the reviewed quote, reservation and initial durable event together", async () => {
		const f = await fixture();
		expect(await client.generationQuote.findUnique({ where: { id: f.quoteId } })).toBeNull();
		const prepared = f.prepare();
		prepared.moderation.retry.failures = 1;
		prepared.moderation.retry.lastErrorCode = "MODERATION_UNAVAILABLE";
		const result = await createGenerationJobTransaction(f.input(prepared), client);
		const quote = await client.generationQuote.findUniqueOrThrow({ where: { id: f.quoteId } });
		expect(quote.moderationDecision).toBe("ALLOW");
		expect(quote.inputFingerprint).toBe(fingerprintGenerationQuoteSecurityPayload(quote));
		expect(result.replayed).toBe(false);
		expect(result.job.creditsReserved).toBe(5n);
		expect(result.continuationEventIds).toHaveLength(1);
		expect(
			await client.outboxEvent.findUnique({ where: { id: result.continuationEventIds![0] } }),
		).toMatchObject({ eventType: "JOB_CREATED", aggregateId: result.job.id });
		expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(1);
		expect(
			await client.moderationReview.findUnique({
				where: { targetType_targetId: { targetType: "QUOTE", targetId: f.quoteId } },
			}),
		).toMatchObject({ status: "APPROVED", observedFailures: 1 });
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("rolls back the quote and moderation audit when the reservation cannot be funded", async () => {
		const f = await fixture(4n);
		await expect(createGenerationJobTransaction(f.input(), client)).rejects.toThrow(
			"INSUFFICIENT_CREDITS",
		);
		expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(0);
		expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(0);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("returns the inserted verification receipt without rereading fresh bindings or scanning Outbox", async () => {
		const f = await imageFixture();
		const reads: string[] = [];
		const observed = client.$extends({
			query: {
				outboxEvent: {
					findMany({ args, query }) {
						reads.push("outbox");
						return query(args);
					},
				},
				generationJobAsset: {
					findMany({ args, query }) {
						reads.push("bindings");
						return query(args);
					},
				},
			},
		});
		const result = await createGenerationJobTransaction(f.input(), observed as never);
		expect(reads).toEqual([]);
		expect(result.continuationEventIds).toHaveLength(1);
		expect(result.verificationAssetId).toBe(f.reference.assetId);
		expect(
			await client.outboxEvent.findUnique({ where: { id: result.continuationEventIds![0] } }),
		).toMatchObject({
			eventType: "MEDIA_ASSET_VERIFY",
			aggregateType: "MEDIA_ASSET",
			aggregateId: f.reference.assetId,
			dedupeKey: `temporary-reference-verify:${f.reference.assetId}:g1`,
		});
		expect(await client.outboxEvent.count({ where: { aggregateId: result.job.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("retains the Serializable receiver until the storage fence rollout is enabled", async () => {
		vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "false");
		const f = await imageFixture();
		const isolation: string[] = [];
		await createGenerationJobTransaction(f.input(), observedTransactions(isolation));
		expect(isolation).toEqual(["Serializable"]);
	});

	it("rolls back a newly inserted verification receipt with its asset, quote and reservation", async () => {
		const f = await imageFixture(4n);
		await expect(createGenerationJobTransaction(f.input(), client)).rejects.toThrow(
			"INSUFFICIENT_CREDITS",
		);
		expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(0);
		expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(0);
		expect(await client.mediaAsset.count({ where: { id: f.reference.assetId } })).toBe(0);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(0);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("replays one verification receipt when the same image admission arrives concurrently", async () => {
		const f = await imageFixture();
		const input = f.input();
		const results = await Promise.all([
			createGenerationJobTransaction(input, client),
			createGenerationJobTransaction(input, client),
		]);
		expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
		expect(results.filter((result) => result.replayed)).toHaveLength(1);
		expect(results[0]!.continuationEventIds).toEqual(results[1]!.continuationEventIds);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("keeps the pending-event lookup for a previously adopted verifying reference", async () => {
		const f = await imageFixture();
		const first = await createGenerationJobTransaction(f.input(), client);
		await client.outboxEvent.update({
			where: { id: first.continuationEventIds![0] },
			data: { status: "PROCESSED", processedAt: new Date() },
		});
		const pending = await client.outboxEvent.create({
			data: {
				eventType: "MEDIA_ASSET_MODERATION_REQUESTED",
				aggregateType: "MEDIA_ASSET",
				aggregateId: f.reference.assetId,
				dedupeKey: `${f.reference.assetId}:historical-review`,
				payload: { assetId: f.reference.assetId },
			},
		});
		const prepared = f.prepare();
		prepared.quoteId = `${f.quoteId}:next`;
		const isolation: string[] = [];
		const result = await createGenerationJobTransaction(
			{
				...f.input(prepared),
				quoteId: prepared.quoteId,
				idempotencyKey: `${f.ownerId}:next-request`,
			},
			observedTransactions(isolation),
		);
		expect(isolation).toEqual(["ReadCommitted", "Serializable"]);
		expect(result.continuationEventIds).toEqual([pending.id]);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(2);
		expect(await client.generationQuote.count({ where: { id: prepared.quoteId } })).toBe(1);
		expect(await client.auditLog.count({ where: { targetId: prepared.quoteId } })).toBe(1);
	});

	it("allows concurrent distinct requests to adopt one immutable input with one verification receipt", async () => {
		const f = await imageFixture();
		const second = f.prepare();
		second.quoteId = `${f.quoteId}:second`;
		const isolation: string[] = [];
		const observed = observedTransactions(isolation);
		const results = await Promise.all([
			createGenerationJobTransaction(f.input(), observed),
			createGenerationJobTransaction(
				{ ...f.input(second), quoteId: second.quoteId, idempotencyKey: `${f.ownerId}:second` },
				observed,
			),
		]);
		expect(new Set(results.map((result) => result.job.id)).size).toBe(2);
		expect(results[0]!.continuationEventIds).toEqual(results[1]!.continuationEventIds);
		expect(isolation.filter((value) => value === "ReadCommitted")).toHaveLength(2);
		expect(isolation).toContain("Serializable");
		expect(await client.mediaAsset.count({ where: { id: f.reference.assetId } })).toBe(1);
		expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(1);
		expect(
			await client.generationJobAsset.count({
				where: { assetId: f.reference.assetId, role: "INPUT" },
			}),
		).toBe(2);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(2);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it.each(["EXPIRED", "ACTIVE", "WRONG_BYTES"] as const)(
		"rejects a %s temporary reservation without partial admission",
		async (mode) => {
			const f = await imageFixture();
			if (mode === "EXPIRED") {
				f.reference.createdAt = new Date(Date.now() - 86_400_001).toISOString();
				f.reference.expiresAt = new Date(
					Date.parse(f.reference.createdAt) + 86_400_000,
				).toISOString();
			}
			await client.storageUsageReservation.update({
				where: { referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${f.reference.assetId}` },
				data: {
					expiresAt: new Date(f.reference.expiresAt),
					...(mode === "ACTIVE" ? { status: "ACTIVE" } : {}),
					...(mode === "WRONG_BYTES" ? { bytes: BigInt(f.reference.bytes + 1) } : {}),
				},
			});
			await expect(createGenerationJobTransaction(f.input(), client)).rejects.toThrow(
				mode === "EXPIRED" ? "TEMPORARY_REFERENCE_EXPIRED" : "TEMPORARY_REFERENCE_INVALID",
			);
			expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(0);
			expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(0);
			expect(await client.mediaAsset.count({ where: { id: f.reference.assetId } })).toBe(0);
			expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(
				0,
			);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);

	it.each(["admission", "deletion"] as const)(
		"preserves fresh input binding when %s owns the real PostgreSQL binding lock first",
		async (first) => {
			const f = await imageFixture();
			const entered = deferred();
			const release = deferred();
			const applicationName = `admission-race-${crypto.randomUUID()}`;
			const contender = new PrismaClient({
				adapter: new PrismaPg({
					connectionString: isolatedUrl(),
					application_name: applicationName,
				}),
			});
			const held = client.$extends({
				query: {
					mediaAsset: {
						async create({ args, query }) {
							const result = await query(args);
							if (first === "admission") {
								entered.resolve();
								await release.promise;
							}
							return result;
						},
						async findFirst({ args, query }) {
							if (first === "deletion") {
								entered.resolve();
								await release.promise;
							}
							return query(args);
						},
					},
				},
			});
			const deletionInput = { assetId: f.reference.assetId, ownerId: f.ownerId };
			const winner =
				first === "admission"
					? createGenerationJobTransaction(f.input(), held as never)
					: markMediaAssetDeletedTransaction(deletionInput, held as never);
			const winnerSettled = Promise.allSettled([winner]);
			let loserSettled: ReturnType<typeof Promise.allSettled> | undefined;
			try {
				await Promise.race([
					entered.promise,
					winner.then(() => {
						throw new Error("RACE_BARRIER_NOT_REACHED");
					}),
				]);
				const loser =
					first === "admission"
						? markMediaAssetDeletedTransaction(deletionInput, contender)
						: createGenerationJobTransaction(f.input(), contender);
				loserSettled = Promise.allSettled([loser]);
				await waitForDatabaseLock(applicationName);
			} finally {
				release.resolve();
				const [winnerResults, loserResults] = await Promise.all([winnerSettled, loserSettled]);
				await contender.$disconnect();
				const admission = (first === "admission" ? winnerResults : loserResults)?.[0];
				const deletion = (first === "admission" ? loserResults : winnerResults)?.[0];
				expect(admission?.status).toBe("fulfilled");
				expect(deletion?.status).toBe("rejected");
				if (deletion?.status === "rejected")
					expect([
						"Media asset not found for owner",
						"MEDIA_ASSET_BOUND_TO_ACTIVE_GENERATION_JOB",
					]).toContain(deletion.reason.message);
			}
			expect(
				await client.mediaAsset.findUnique({ where: { id: f.reference.assetId } }),
			).toMatchObject({ status: "VERIFYING", deletedAt: null });
			expect(
				await client.generationJobAsset.count({
					where: { assetId: f.reference.assetId, role: "INPUT" },
				}),
			).toBe(1);
			expect(
				await client.outboxEvent.count({
					where: { aggregateId: f.reference.assetId, eventType: "MEDIA_OBJECT_DELETE" },
				}),
			).toBe(0);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);

	it.each([
		["temporary reference", "binding"],
		["quote", "binding"],
		["temporary reference", "credit account"],
		["quote", "credit account"],
		["temporary reference", "moderation incident"],
		["quote", "moderation incident"],
	] as const)(
		"rechecks the %s deadline after a real %s lock wait",
		async (deadlineKind, waitingOn) => {
			const f = await imageFixture();
			const deadline = new Date(Date.now() + 1000);
			if (deadlineKind === "temporary reference") {
				f.reference.expiresAt = deadline.toISOString();
				f.reference.createdAt = new Date(deadline.getTime() - 86_400_000).toISOString();
				await client.storageUsageReservation.update({
					where: {
						referenceKey: `${TEMPORARY_REFERENCE_RESERVATION_PREFIX}${f.reference.assetId}`,
					},
					data: { expiresAt: deadline },
				});
			}
			const prepared = f.prepare();
			if (deadlineKind === "quote") {
				prepared.expiresAt = deadline;
				prepared.moderation.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(prepared);
			}
			const entered = deferred();
			const release = deferred();
			const applicationName = `admission-expiry-${crypto.randomUUID()}`;
			const contender = new PrismaClient({
				adapter: new PrismaPg({
					connectionString: isolatedUrl(),
					application_name: applicationName,
				}),
			});
			const holding = client.$transaction(async (tx) => {
				if (waitingOn === "binding")
					await lockMediaAssetGenerationBindings([f.reference.assetId], tx);
				else if (waitingOn === "credit account")
					await tx.$queryRaw`SELECT "id" FROM "credit_account" WHERE "id" = ${f.account.id} FOR UPDATE`;
				else
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"moderation-incident:waffo:TEXT"}, 0))`;
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			const admission = Promise.allSettled([
				createGenerationJobTransaction(f.input(prepared), contender),
			]);
			try {
				await waitForDatabaseLock(
					applicationName,
					waitingOn === "credit account" ? "transactionid" : "advisory",
				);
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
				);
				const [clock] = await client.$queryRaw<
					Array<{ now: Date }>
				>`SELECT clock_timestamp() AS "now"`;
				expect(clock!.now.getTime()).toBeGreaterThan(deadline.getTime());
			} finally {
				release.resolve();
				await holding;
				const [result] = await admission;
				await contender.$disconnect();
				expect(result!.status).toBe("rejected");
				if (result!.status === "rejected")
					expect(result.reason.message).toBe(
						deadlineKind === "quote" ? "Quote expired" : "TEMPORARY_REFERENCE_EXPIRED",
					);
			}
			expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(0);
			expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(0);
			expect(await client.mediaAsset.count({ where: { id: f.reference.assetId } })).toBe(0);
			expect(await client.outboxEvent.count({ where: { aggregateId: f.reference.assetId } })).toBe(
				0,
			);
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
			expect(await client.creditAccount.findUnique({ where: { id: f.account.id } })).toMatchObject({
				spendableCredits: 100n,
				reservedCredits: 0n,
			});
			expect(
				await client.creditLedgerEntry.count({
					where: { accountId: f.account.id, type: "RESERVE" },
				}),
			).toBe(0);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		},
	);

	it("admits 50 independent image owners concurrently with their own verification receipts", async () => {
		const fixtures: Awaited<ReturnType<typeof imageFixture>>[] = [];
		// Seed sequentially outside the admission interval; do not manufacture competing grants.
		for (let index = 0; index < 50; index += 1) fixtures.push(await imageFixture());
		const results = await Promise.allSettled(
			fixtures.map((f) => createGenerationJobTransaction(f.input(), client)),
		);
		const failureKinds: Record<string, number> = {};
		for (const result of results) {
			if (result.status !== "rejected") continue;
			const error = result.reason;
			const cause = error?.meta?.driverAdapterError?.cause ?? error?.cause;
			const kind = [error?.name, error?.code, cause?.kind, cause?.originalCode]
				.filter(Boolean)
				.join(":");
			failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
		}
		expect(failureKinds).toEqual({});
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(50);
		for (let index = 0; index < fixtures.length; index += 1) {
			const f = fixtures[index]!;
			const result = results[index]!;
			if (result.status !== "fulfilled") throw result.reason;
			expect(result.value.replayed).toBe(false);
			expect(result.value.continuationEventIds).toHaveLength(1);
			expect(
				await client.outboxEvent.findUnique({
					where: { id: result.value.continuationEventIds![0] },
				}),
			).toMatchObject({ eventType: "MEDIA_ASSET_VERIFY", aggregateId: f.reference.assetId });
			expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
			expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
			expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
		}
	});

	it("replays two simultaneous identical preparations with one quote, debit and job", async () => {
		const f = await fixture();
		const results = await Promise.all([
			createGenerationJobTransaction(f.input(), client),
			createGenerationJobTransaction(f.input(), client),
		]);
		expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
		expect(results.filter((result) => result.replayed)).toHaveLength(1);
		expect(await client.generationQuote.count({ where: { id: f.quoteId } })).toBe(1);
		expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(1);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
		expect(await getCreditInvariantReport(f.account.id, client)).toMatchObject({ valid: true });
	});

	it("rejects a simultaneous changed-input preparation instead of replaying the winner", async () => {
		const f = await fixture();
		const results = await Promise.allSettled([
			createGenerationJobTransaction(f.input(f.prepare("First reviewed prompt")), client),
			createGenerationJobTransaction(f.input(f.prepare("Changed reviewed prompt")), client),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const failure = results.find((result) => result.status === "rejected");
		expect(failure?.status === "rejected" ? failure.reason.message : undefined).toBe(
			"IDEMPOTENCY_CONFLICT",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(1);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(1);
	});

	it("continues a matching quote persisted by the previous receiver without replacing its evidence", async () => {
		const f = await fixture();
		const accepted = await createModeratedGenerationQuoteTransaction(f.prepare(), client);
		const nextPreparation = f.prepare();
		nextPreparation.expiresAt = new Date(accepted.expiresAt.getTime() + 1000);
		nextPreparation.moderation.inputFingerprint =
			fingerprintGenerationQuoteSecurityPayload(nextPreparation);
		await expect(
			createGenerationJobTransaction(f.input(nextPreparation), client),
		).resolves.toMatchObject({
			replayed: false,
			job: { creditsReserved: 5n },
			committedQuote: { expiresAt: accepted.expiresAt },
		});
		expect(await client.generationQuote.findUnique({ where: { id: f.quoteId } })).toMatchObject({
			inputFingerprint: accepted.inputFingerprint,
			expiresAt: accepted.expiresAt,
		});
		expect(await client.auditLog.count({ where: { targetId: f.quoteId } })).toBe(1);
	});

	it("does not admit an unconsumed legacy quote against a newly changed pricing contract", async () => {
		const f = await fixture();
		const oldQuote = f.prepare();
		oldQuote.pricingVersion = "outdated-pricing";
		oldQuote.moderation.inputFingerprint = fingerprintGenerationQuoteSecurityPayload(oldQuote);
		await createModeratedGenerationQuoteTransaction(oldQuote, client);
		await expect(createGenerationJobTransaction(f.input(), client)).rejects.toThrow(
			"PRICE_CHANGED",
		);
		expect(await client.generationJob.count({ where: { ownerId: f.ownerId } })).toBe(0);
		expect(await client.creditReservation.count({ where: { accountId: f.account.id } })).toBe(0);
	});
});
