import { writeFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import {
	createCreditGrant,
	isDatabaseSerializationConflict,
	reserveCredits,
	settleCreditsInTransaction,
} from "@repo/database";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseSettlementStore } from "../runtime";

// Opt-in diagnostic only. No production settings, isolation, constraints or
// indexes are changed. The ordinary test command discovers but skips this file.
const enabled = process.env.RUN_MEDIA_SETTLEMENT_PREDICATE_PROBE === "true";
const prefix = `settlement-predicate-${crypto.randomUUID()}`;
const tables = [
	"generation_job",
	"generation_job_asset",
	"media_asset",
	"asset_moderation_result",
	"credit_account",
	"credit_lot",
	"credit_reservation",
	"credit_reservation_allocation",
	"credit_ledger_entry",
];
let observer: PrismaClient;
let connectionString: string;
let outputFile: string;
const clients: PrismaClient[] = [];
const report: Record<string, unknown> = {
	boundary:
		"Disposable local PostgreSQL diagnostic. Real schema and financial/settlement functions; two independent owners. Barriers and observations intentionally change timing. No latency, production, provider or browser certification. EXPLAIN never executes the sampled statement; it is planned immediately after the matching stage unless an abort forced final collection. First transaction outcomes are retained without replay.",
	fixturePrefix: prefix,
	cases: [] as unknown[],
};

type PredicateLock = {
	pid: number;
	locktype: string;
	relation: string;
	page: number | null;
	tuple: number | null;
};
type Sample = { stage: string; query: string; params: unknown[]; durationMs: number };
type Step = {
	label: string;
	phase: "before" | "after" | "commit" | "finished";
	release: () => void;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`PROBE_TIMEOUT:${label}`)), 8_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

class Stepper {
	private queue: Step[] = [];
	private waiter: ReturnType<typeof deferred<Step>> | undefined;
	private gates = new Set<() => void>();
	private free = false;

	async pause(label: string, phase: Step["phase"]) {
		if (this.free) return;
		const gate = deferred<void>();
		const release = () => gate.resolve();
		this.gates.add(release);
		this.push({ label, phase, release });
		await gate.promise;
		this.gates.delete(release);
	}

	finish() {
		this.push({ label: "finished", phase: "finished", release() {} });
	}

	private push(step: Step) {
		if (this.waiter) {
			this.waiter.resolve(step);
			this.waiter = undefined;
		} else this.queue.push(step);
	}

	next() {
		const next = this.queue.shift();
		if (next) return Promise.resolve(next);
		if (this.waiter) throw new Error("PROBE_ALREADY_WAITING");
		this.waiter = deferred<Step>();
		return bounded(this.waiter.promise, "next-step");
	}

	drain() {
		this.free = true;
		for (const release of this.gates) release();
	}
}

function errorDetails(error: unknown) {
	const value = error as {
		name?: string;
		message?: string;
		code?: string;
		cause?: unknown;
		meta?: unknown;
	};
	return {
		name: value.name,
		message: value.message,
		code: value.code,
		cause: value.cause,
		meta: value.meta,
		serializationConflict: isDatabaseSerializationConflict(error),
	};
}

async function fixture(label: string) {
	const ownerId = `${prefix}-${label}`;
	const account = await observer.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	await createCreditGrant(
		{ accountId: account.id, amount: 100n, referenceKey: `${ownerId}:grant` },
		observer,
	);
	const common = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: "image-fast",
		catalogVersion: "settlement-predicate-diagnostic",
		pricingVersion: "settlement-predicate-diagnostic",
		inputSnapshot: {},
		pricingSnapshot: {
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
		},
	};
	const quote = await observer.generationQuote.create({
		data: { ...common, credits: 5n, costMicros: 1n, expiresAt: new Date(Date.now() + 3_600_000) },
	});
	const job = await observer.generationJob.create({
		data: {
			...common,
			quoteId: quote.id,
			idempotencyKey: ownerId,
			fundingSource: "CREDITS",
			creditsReserved: 5n,
			status: "FINALIZING",
		},
	});
	const reservation = await reserveCredits(
		{ accountId: account.id, jobId: job.id, amount: 5n, referenceKey: `${ownerId}:reserve` },
		observer,
	);
	const validUntil = new Date(Date.now() + 3_600_000);
	const asset = await observer.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `tests/${ownerId}/output.png`,
			mimeType: "image/png",
			byteSize: 512_000n,
			checksum: "c".repeat(64),
			finalizedAt: new Date(),
			verificationGeneration: 1,
			verificationAttemptCount: 1,
			verificationProvider: "test",
			verificationRuleVersion: MEDIA_VERIFICATION_RULE_VERSION,
			verificationPolicyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
			verificationValidUntil: validUntil,
			moderationResults: {
				create: {
					assetChecksum: "c".repeat(64),
					verificationGeneration: 1,
					attemptNumber: 1,
					evidenceKind: "OUTPUT",
					provider: "test",
					ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
					policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
					status: "APPROVED",
					reasonCode: "TEST_ALLOW",
					categories: {},
					rawEnvelope: { decision: "ALLOW" },
					validUntil,
				},
			},
		},
	});
	await observer.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	await observer.generationJobAsset.create({
		data: { jobId: job.id, assetId: asset.id, assetChecksum: asset.checksum!, role: "OUTPUT" },
	});
	return { ownerId, accountId: account.id, jobId: job.id, reservationId: reservation.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function observe(database: PrismaClient, owner: "a" | "b", samples: Sample[]) {
	const stepper = new Stepper();
	const state = {
		owner,
		pid: 0,
		stage: "outside-transaction",
		transactionAttempts: 0,
		isolation: "",
		outcome: "pending",
		failure: undefined as ReturnType<typeof errorDetails> | undefined,
		failureStage: undefined as string | undefined,
	};
	const observed = new Proxy(database, {
		get(target, key, receiver) {
			if (key !== "$transaction") return Reflect.get(target, key, receiver);
			return async (
				operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
				options: { isolationLevel: "Serializable"; maxWait?: number; timeout?: number },
			) => {
				state.transactionAttempts++;
				state.isolation = options.isolationLevel;
				try {
					const result = await target.$transaction(
						async (tx) => {
							const [backend] = await tx.$queryRaw<
								Array<{ pid: number }>
							>`SELECT pg_backend_pid() AS pid`;
							state.pid = backend!.pid;
							async function call(label: string, invoke: () => Promise<unknown>) {
								state.stage = label;
								await stepper.pause(label, "before");
								const result = await invoke();
								await stepper.pause(label, "after");
								return result;
							}
							const wrapped = new Proxy(tx, {
								get(transaction, model, transactionReceiver) {
									const value = Reflect.get(transaction, model, transactionReceiver);
									if (model === "$queryRaw" || model === "$executeRaw")
										return (...args: unknown[]) => {
											const sql = Array.isArray(args[0]) ? args[0].join("?") : "unknown-raw";
											return call(sql.replace(/\s+/g, " ").trim(), () =>
												Reflect.apply(value, transaction, args),
											);
										};
									if (
										typeof model !== "string" ||
										model.startsWith("$") ||
										!value ||
										typeof value !== "object"
									)
										return value;
									return new Proxy(value, {
										get(delegate, method, delegateReceiver) {
											const invoke = Reflect.get(delegate, method, delegateReceiver);
											if (typeof invoke !== "function") return invoke;
											return (...args: unknown[]) =>
												call(`${model}.${String(method)}`, () =>
													Reflect.apply(invoke, delegate, args),
												);
										},
									});
								},
							});
							const result = await operation(wrapped);
							state.stage = "commit";
							await stepper.pause("commit", "commit");
							return result;
						},
						{ ...options, timeout: 60_000 },
					);
					state.outcome = "committed";
					return result;
				} catch (error) {
					state.outcome = "aborted";
					state.failure = errorDetails(error);
					state.failureStage = state.stage;
					// The real transaction has already rolled back. Suppress only the
					// outer automatic replay, preserving the first causal outcome.
					throw new Error("DIAGNOSTIC_FIRST_ATTEMPT_RECORDED");
				} finally {
					stepper.finish();
				}
			};
		},
	});
	return { observed, state, stepper, samples };
}
type Observed = ReturnType<typeof observe>;

function overlap(left: PredicateLock, right: PredicateLock) {
	if (left.relation !== right.relation) return false;
	if (left.locktype === "relation" || right.locktype === "relation") return true;
	if (left.page !== right.page) return false;
	return left.locktype === "page" || right.locktype === "page" || left.tuple === right.tuple;
}

async function locksFor(pair: Observed[]) {
	const pids = pair.map(({ state }) => state.pid).filter(Boolean);
	const locks = await observer.$queryRaw<PredicateLock[]>`
		SELECT pid, locktype, relation::regclass::text AS relation, page, tuple
		FROM pg_locks WHERE pid = ANY(${pids}::integer[]) AND mode = 'SIReadLock'
		ORDER BY pid, relation, locktype, page, tuple`;
	const shared = locks
		.filter((entry) => entry.pid === pids[0])
		.flatMap((left) =>
			locks
				.filter((entry) => entry.pid === pids[1] && overlap(left, entry))
				.map((right) => ({ left, right })),
		);
	return { locks, shared };
}

async function plansFor(samples: Sample[], from: number) {
	const plans: unknown[] = [];
	for (let index = from; index < samples.length; index++) {
		const sample = samples[index]!;
		if (
			!/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sample.query) ||
			/pg_backend_pid|pg_advisory/.test(sample.query)
		)
			continue;
		try {
			const plan = await observer.$queryRawUnsafe(
				`EXPLAIN (FORMAT JSON) ${sample.query}`,
				...sample.params,
			);
			plans.push({ sampleIndex: index, stage: sample.stage, plan });
		} catch (error) {
			plans.push({ sampleIndex: index, stage: sample.stage, error: errorDetails(error) });
		}
	}
	return plans;
}

type Mode = "full" | "financial-only" | "job-status" | "job-unindexed-version";

async function runCase(mode: Mode) {
	const fixtures = [await fixture(`${mode}-a`), await fixture(`${mode}-b`)];
	const financial = (tx: Prisma.TransactionClient, f: Fixture) =>
		settleCreditsInTransaction(
			{ reservationId: f.reservationId, amount: 5n, referenceKey: `settle:${f.jobId}` },
			tx,
		);
	if (mode === "job-status" || mode === "job-unindexed-version") {
		// These jobs have genuinely settled reservations before the terminal-only
		// probe; no unpaid job is made successful by a diagnostic control arm.
		for (const f of fixtures)
			await observer.$transaction((tx) => financial(tx, f), { isolationLevel: "Serializable" });
	}
	const pair: Observed[] = [];
	const starts: Array<() => Promise<unknown>> = [];
	for (const [index, f] of fixtures.entries()) {
		const database = new PrismaClient({
			adapter: new PrismaPg({ connectionString, max: 1 }),
			log: [{ level: "query", emit: "event" }],
		});
		clients.push(database);
		const samples: Sample[] = [];
		const measured = observe(database, index === 0 ? "a" : "b", samples);
		database.$on("query", (event) => {
			if (measured.state.stage === "outside-transaction") return;
			const params: unknown = JSON.parse(event.params);
			if (!Array.isArray(params)) throw new Error("PROBE_QUERY_PARAMETERS_INVALID");
			samples.push({
				stage: measured.state.stage,
				query: event.query,
				params,
				durationMs: event.duration,
			});
		});
		pair.push(measured);
		if (mode === "full") {
			const store = createDatabaseSettlementStore(measured.observed);
			const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
			if (!claim) throw new Error("PROBE_SETTLEMENT_CLAIM_MISSING");
			starts.push(() => store.settle(claim));
		} else {
			starts.push(() =>
				measured.observed.$transaction(
					async (tx) => {
						if (mode === "financial-only") return financial(tx, f);
						const job = await tx.generationJob.findFirst({
							where: { executionEngine: "legacy", id: f.jobId, status: "FINALIZING" },
							select: { id: true },
						});
						if (!job) throw new Error("PROBE_JOB_MISSING");
						if (mode === "job-status")
							return tx.generationJob.updateMany({
								where: { executionEngine: "legacy", id: f.jobId, status: "FINALIZING" },
								data: {
									status: "SUCCEEDED",
									failureCode: null,
									terminalAt: new Date(),
									version: { increment: 1 },
								},
							});
						// Raw SQL intentionally avoids Prisma's indexed updatedAt mutation.
						// Same target predicate; only the non-indexed version value changes.
						return tx.$executeRaw`UPDATE "generation_job" SET "version" = "version" + 1
					WHERE "executionEngine" = 'legacy' AND "id" = ${f.jobId} AND "status" = 'FINALIZING'`;
					},
					{ isolationLevel: "Serializable", maxWait: 5_000, timeout: 60_000 },
				),
			);
		}
	}
	const stages: unknown[] = [];
	const plans: unknown[] = [];
	const planned = [0, 0];
	const pending = starts.map((start) =>
		start().then(
			() => null,
			(error: unknown) => errorDetails(error),
		),
	);
	let scheduleError: ReturnType<typeof errorDetails> | undefined;
	try {
		for (let round = 0; round < 40; round++) {
			const steps = await Promise.all(pair.map(({ stepper }) => stepper.next()));
			if (steps.some((step) => step.phase === "finished")) break;
			if (steps[0]!.label !== steps[1]!.label || steps[0]!.phase !== steps[1]!.phase)
				throw new Error(
					`PROBE_STAGE_MISMATCH:${JSON.stringify(steps.map(({ label, phase }) => ({ label, phase })))}`,
				);
			const label = steps[0]!.label;
			const phase = steps[0]!.phase;
			stages.push({ round, phase, label, ...(await locksFor(pair)) });
			if (phase === "commit") {
				steps[0]!.release();
				await pair[0]!.stepper.next();
				stages.push({ round, phase: "after-first-commit", label, ...(await locksFor(pair)) });
				steps[1]!.release();
				await pair[1]!.stepper.next();
				break;
			}
			if (phase !== "before") throw new Error(`PROBE_UNEXPECTED_PHASE:${phase}`);
			// Both transactions have reached this stage before either is advanced.
			// Execute A then B deterministically while both transactions stay open.
			steps[0]!.release();
			const afterA = await pair[0]!.stepper.next();
			stages.push({
				round,
				phase: "after-a",
				label,
				result: afterA.phase,
				...(await locksFor(pair)),
			});
			steps[1]!.release();
			const afterB = await pair[1]!.stepper.next();
			stages.push({
				round,
				phase: "after",
				label,
				results: [afterA.phase, afterB.phase],
				...(await locksFor(pair)),
			});
			for (const [index, entry] of pair.entries()) {
				plans.push({
					round,
					owner: entry.state.owner,
					plans: await plansFor(entry.samples, planned[index]!),
				});
				planned[index] = entry.samples.length;
			}
			if (afterA.phase === "finished" || afterB.phase === "finished") break;
			afterA.release();
			afterB.release();
			if (round === 39) throw new Error("PROBE_STAGE_LIMIT_EXCEEDED");
		}
	} catch (error) {
		scheduleError = errorDetails(error);
	} finally {
		for (const { stepper } of pair) stepper.drain();
		await bounded(Promise.all(pending), "drain-transactions");
		for (const [index, entry] of pair.entries())
			plans.push({
				phase: "after-drain",
				owner: entry.state.owner,
				plans: await plansFor(entry.samples, planned[index]!),
			});
	}
	const outcomes = [];
	for (const f of fixtures) {
		const [job, reservation, account, ledgers] = await Promise.all([
			observer.generationJob.findUnique({
				where: { id: f.jobId },
				select: { id: true, status: true, version: true },
			}),
			observer.creditReservation.findUnique({ where: { id: f.reservationId } }),
			observer.creditAccount.findUnique({ where: { id: f.accountId } }),
			observer.creditLedgerEntry.findMany({ where: { referenceKey: `settle:${f.jobId}` } }),
		]);
		outcomes.push({ ...f, job, reservation, account, settlementLedgerCount: ledgers.length });
	}
	const result = {
		mode,
		scheduleError,
		stages,
		plans,
		transactions: pair.map(({ state, samples }) => ({ ...state, samples })),
		outcomes,
	};
	(report.cases as unknown[]).push(result);
	for (const entry of pair) expect(entry.state.transactionAttempts).toBe(1);
	expect(scheduleError).toBeUndefined();
	return result;
}

describe.runIf(enabled)("settlement predicate conflict diagnostic", () => {
	beforeAll(async () => {
		connectionString = process.env.TEST_DATABASE_URL ?? "";
		const target = new URL(connectionString);
		if (
			!["postgres:", "postgresql:"].includes(target.protocol) ||
			target.hostname !== "127.0.0.1" ||
			target.port !== "55432" ||
			target.pathname !== "/scanless_one_second_fence_test" ||
			target.search ||
			target.hash
		)
			throw new Error("ISOLATED_SETTLEMENT_DATABASE_REQUIRED");
		outputFile = path.resolve(process.env.MEDIA_SETTLEMENT_PREDICATE_FILE ?? "");
		const evidenceRoot = path.resolve(
			import.meta.dirname,
			"../../../..",
			".cache/generation-one-second-20261022",
		);
		if (
			path.dirname(outputFile) !== evidenceRoot ||
			!/^settlement-predicate-[a-zA-Z0-9_-]+\.json$/.test(path.basename(outputFile))
		)
			throw new Error("SCOPED_PREDICATE_EVIDENCE_FILE_REQUIRED");
		observer = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) });
		report.settings = await observer.$queryRaw`
			SELECT version(), current_setting('default_transaction_isolation') AS default_isolation,
			current_setting('max_pred_locks_per_transaction') AS max_pred_locks_per_transaction,
			current_setting('max_pred_locks_per_relation') AS max_pred_locks_per_relation,
			current_setting('max_pred_locks_per_page') AS max_pred_locks_per_page`;
		report.tableStatsBefore = await observer.$queryRaw`
			SELECT relname, n_live_tup, n_dead_tup, last_analyze, last_autoanalyze, n_tup_upd, n_tup_hot_upd
			FROM pg_stat_user_tables WHERE relname = ANY(${tables}::text[]) ORDER BY relname`;
		report.indexes = await observer.$queryRaw`
			SELECT tablename, indexname, indexdef FROM pg_indexes
			WHERE schemaname = 'public' AND tablename = ANY(${tables}::text[]) ORDER BY tablename, indexname`;
		report.triggers = await observer.$queryRaw`
			SELECT c.relname, t.tgname, t.tgisinternal, t.tgdeferrable, t.tginitdeferred,
			pg_get_triggerdef(t.oid) AS definition
			FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relname = ANY(${tables}::text[]) ORDER BY c.relname, t.tgname`;
	});

	afterAll(async () => {
		await Promise.all([...clients, observer].map((database) => database?.$disconnect()));
		if (outputFile)
			await writeFile(
				outputFile,
				JSON.stringify(
					report,
					(_key, value) => (typeof value === "bigint" ? value.toString() : value),
					2,
				),
				{ flag: "wx" },
			);
	});

	for (const mode of ["full", "financial-only", "job-status", "job-unindexed-version"] as const)
		it(`captures two independent owners: ${mode}`, async () => {
			await runCase(mode);
		}, 120_000);
});
