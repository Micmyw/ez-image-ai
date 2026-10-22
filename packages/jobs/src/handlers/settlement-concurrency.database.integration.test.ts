import { writeFile } from "node:fs/promises";

import { PrismaPg } from "@prisma/adapter-pg";
import { MEDIA_VERIFICATION_POLICY_VERSION, MEDIA_VERIFICATION_RULE_VERSION } from "@repo/ai";
import { OUTPUT_MODERATION_BILLING_POLICY } from "@repo/config";
import { getImagePassOfferSnapshot } from "@repo/config/image-pass";
import {
	createCreditGrant,
	createGenerationOutputAssetBindingTransaction,
	expireGuestMediaTransaction,
	isDatabaseLockNotAvailable,
	isDatabaseSerializationConflict,
	refundCreditGrant,
	reserveCredits,
	reserveImagePassForJobInTransaction,
} from "@repo/database";
import { PrismaClient, type Prisma } from "@repo/database/generated-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SettlementTransactionConflictError } from "../contracts";
import { createDatabaseSettlementStore } from "../runtime";
import { settleGeneration } from "./settle-generation";

let client: PrismaClient;
let connectionString: string;
const clients: PrismaClient[] = [];
const prefix = `settlement-concurrency-${crypto.randomUUID()}`;
const diagnostic = process.env.RUN_MEDIA_SETTLEMENT_DIAGNOSTICS === "true";
const diagnostics: Record<string, unknown> = {
	boundary:
		"Isolated PostgreSQL settlement only; no provider, storage, browser or one-second certification.",
};

beforeAll(() => {
	connectionString = process.env.TEST_DATABASE_URL ?? "";
	const target = new URL(connectionString);
	if (
		!["postgres:", "postgresql:"].includes(target.protocol) ||
		target.hostname !== "127.0.0.1" ||
		target.port !== "55432" ||
		!["/scanless_one_second_fence_test", "/ai_media_foundation_test"].includes(target.pathname) ||
		target.search ||
		target.hash
	)
		throw new Error("ISOLATED_SETTLEMENT_DATABASE_REQUIRED");
	if (diagnostic && target.pathname !== "/scanless_one_second_fence_test")
		throw new Error("SETTLEMENT_DIAGNOSTICS_REQUIRE_DEDICATED_FENCE_DATABASE");
	client = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 3 }) });
});
afterAll(async () => {
	await Promise.all([...clients, client].map((database) => database?.$disconnect()));
	if (process.env.MEDIA_SETTLEMENT_DIAGNOSTICS_FILE)
		await writeFile(
			process.env.MEDIA_SETTLEMENT_DIAGNOSTICS_FILE,
			JSON.stringify(diagnostics, null, 2),
		);
});

async function fixture(
	label: string,
	fundingSource: "CREDITS" | "IMAGE_PASS" = "CREDITS",
	shared?: { ownerId: string; accountId: string },
) {
	const caseKey = `${prefix}-${process.env.MEDIA_SETTLEMENT_FRESH_READ_ENABLED === "true" ? "fresh" : "ssi"}-${label}`;
	const ownerId = shared?.ownerId ?? caseKey;
	const account = shared
		? await client.creditAccount.findUniqueOrThrow({ where: { id: shared.accountId } })
		: await client.creditAccount.create({ data: { ownerType: "USER", ownerId } });
	if (fundingSource === "CREDITS" && !shared)
		await createCreditGrant(
			{ accountId: account.id, amount: 100n, referenceKey: `${ownerId}:grant` },
			client,
		);
	const common = {
		ownerType: "USER" as const,
		ownerId,
		submittedByUserId: ownerId,
		productKey: fundingSource === "IMAGE_PASS" ? "image-nano-banana-pro" : "image-fast",
		catalogVersion: "settlement-test",
		pricingVersion: "settlement-test",
		inputSnapshot: {},
		pricingSnapshot: {
			...(fundingSource === "IMAGE_PASS" ? { fundingSource, skuKey: "nano-banana-pro-4k" } : {}),
			settlementPolicy: { unitCredits: "5", requestedOutputCount: 1, maxCharge: "5" },
		},
	};
	const quote = await client.generationQuote.create({
		data: { ...common, credits: 5n, costMicros: 1n, expiresAt: new Date(Date.now() + 3_600_000) },
	});
	const job = await client.generationJob.create({
		data: {
			...common,
			quoteId: quote.id,
			idempotencyKey: caseKey,
			fundingSource,
			creditsReserved: fundingSource === "CREDITS" ? 5n : 0n,
			status: fundingSource === "CREDITS" ? "FINALIZING" : "RESERVED",
		},
	});
	let reservationId: string;
	let passUnitId: string | undefined;
	if (fundingSource === "CREDITS") {
		reservationId = (
			await reserveCredits(
				{ accountId: account.id, jobId: job.id, amount: 5n, referenceKey: `${caseKey}:reserve` },
				client,
			)
		).id;
	} else {
		const plan = await client.billingPlan.create({
			data: {
				provider: "paypal",
				providerPriceId: ownerId,
				productKind: "IMAGE_PASS",
				name: "image-pass-3",
				creditsPerPeriod: 0n,
				priceMicros: 1_000_000n,
				currency: "USD",
				metadata: {},
			},
		});
		const checkout = await client.paymentCheckoutIntent.create({
			data: {
				provider: "paypal",
				ownerType: "USER",
				ownerId,
				submittedByUserId: ownerId,
				productKind: "IMAGE_PASS",
				billingPlanId: plan.id,
				planKey: "image-pass-3",
				interval: "one-time",
				idempotencyKey: ownerId,
				status: "COMPLETED",
				imagePassOfferSnapshot: getImagePassOfferSnapshot(),
			},
		});
		await client.imagePassGrant.create({
			data: {
				checkoutIntentId: checkout.id,
				ownerId,
				provider: "paypal",
				providerOrderId: ownerId,
				providerPaymentId: ownerId,
				paidAmountMicros: 1_000_000n,
				currency: "USD",
				offerSnapshot: getImagePassOfferSnapshot(),
				paidAt: new Date(),
				units: { create: [1, 2, 3].map((ordinal) => ({ ordinal })) },
			},
		});
		reservationId = (
			await client.$transaction((tx) =>
				reserveImagePassForJobInTransaction(
					{
						ownerId,
						jobId: job.id,
					},
					tx,
				),
			)
		).id;
		passUnitId = (
			await client.imagePassReservation.findUniqueOrThrow({ where: { id: reservationId } })
		).unitId;
		await client.generationJob.update({ where: { id: job.id }, data: { status: "FINALIZING" } });
	}
	const validUntil = new Date(Date.now() + 3_600_000);
	const asset = await client.mediaAsset.create({
		data: {
			ownerType: "USER",
			ownerId,
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: `tests/${caseKey}/output.png`,
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
	await client.mediaAsset.update({ where: { id: asset.id }, data: { status: "READY" } });
	await client.generationJobAsset.create({
		data: { jobId: job.id, assetId: asset.id, assetChecksum: asset.checksum!, role: "OUTPUT" },
	});
	const event = await client.outboxEvent.create({
		data: {
			eventType: "GENERATION_SETTLE",
			aggregateType: "GENERATION_JOB",
			aggregateId: job.id,
			dedupeKey: `${caseKey}:settle`,
			payload: { jobId: job.id, version: 0 },
		},
	});
	return {
		jobId: job.id,
		accountId: account.id,
		reservationId,
		assetId: asset.id,
		ownerId,
		fundingSource,
		passUnitId,
		outboxId: event.id,
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// The baseline changes only the first query back to the pre-optimization graph.
// For credit-funded jobs the removed funding lookup used its included reservation
// and issued no query, so this reproduces the old settlement SQL without editing runtime.ts.
const legacyInclude = {
	reservation: true,
	assets: {
		where: { role: "OUTPUT" },
		include: {
			asset: {
				include: {
					moderationResults: {
						orderBy: [
							{ verificationGeneration: "desc" },
							{ attemptNumber: "desc" },
							{ createdAt: "desc" },
							{ id: "desc" },
						],
						take: 1,
					},
				},
			},
		},
	},
} satisfies Prisma.GenerationJobInclude;

function instrument(
	database: PrismaClient,
	legacy = false,
	pause?: (tx: Prisma.TransactionClient) => Promise<void>,
	afterLockSetRead?: () => void,
	knownNewSettlementReference?: string,
	beforeRaw?: (tx: Prisma.TransactionClient, sql: string) => Promise<void>,
) {
	const observations = {
		attempts: 0,
		conflicts: 0,
		fullReads: 0,
		skippedNewSettlementLookups: 0,
		lockNotAvailable: 0,
		terminalWrites: 0,
		fenceChecks: 0,
		failureCodes: [] as string[],
		isolation: [] as string[],
		failureStages: [] as string[],
	};
	const observed = new Proxy(database, {
		get(target, key, receiver) {
			if (key !== "$transaction") return Reflect.get(target, key, receiver);
			return async (
				operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
				options: { isolationLevel: string },
			) => {
				observations.attempts++;
				observations.isolation.push(options.isolationLevel);
				let stage = "begin";
				try {
					return await target.$transaction(async (tx) => {
						const wrapped = new Proxy(tx, {
							get(transaction, model, transactionReceiver) {
								const value = Reflect.get(transaction, model, transactionReceiver);
								if (model === "$queryRaw" || model === "$executeRaw")
									return async (...args: unknown[]) => {
										const sql = Array.isArray(args[0]) ? args[0].join("?") : "";
										stage = sql.replace(/\s+/g, " ").trim().slice(0, 160);
										await beforeRaw?.(tx, sql);
										if (sql.includes('FROM "media_asset"') && sql.includes("FOR UPDATE NOWAIT"))
											observations.fenceChecks++;
										const result = await Reflect.apply(value, transaction, args);
										if (pause && sql.includes('FROM "credit_reservation_allocation"'))
											await pause(tx);
										return result;
									};
								if (
									typeof model !== "string" ||
									![
										"generationJob",
										"creditAccount",
										"creditLot",
										"creditReservation",
										"creditReservationAllocation",
										"creditLedgerEntry",
									].includes(model)
								)
									return value;
								return new Proxy(value, {
									get(delegate, method, delegateReceiver) {
										const operation = Reflect.get(delegate, method, delegateReceiver);
										if (typeof operation !== "function") return operation;
										return async (...args: unknown[]) => {
											stage = `${model}.${String(method)}`;
											if (
												knownNewSettlementReference &&
												model === "creditLedgerEntry" &&
												method === "findUnique" &&
												(args[0] as Prisma.CreditLedgerEntryFindUniqueArgs).where.referenceKey ===
													knownNewSettlementReference
											) {
												// Diagnostic-only counterfactual for a freshly seeded reservation.
												// Production and correctness cases retain the actual replay lookup.
												observations.skippedNewSettlementLookups++;
												return null;
											}
											let lockSetRead = false;
											if (model === "generationJob" && method === "findFirst") {
												let query = args[0] as Prisma.GenerationJobFindFirstArgs;
												lockSetRead = Boolean(query.select);
												if (legacy && query.select)
													query = { where: query.where, include: legacyInclude };
												if (query.include) observations.fullReads++;
												args[0] = query;
											}
											const result = await Reflect.apply(operation, delegate, args);
											if (model === "generationJob" && method === "updateMany")
												observations.terminalWrites++;
											if (lockSetRead) afterLockSetRead?.();
											return result;
										};
									},
								});
							},
						});
						const result = await operation(wrapped);
						stage = "commit";
						return result;
					}, options as never);
				} catch (error) {
					if (isDatabaseSerializationConflict(error)) observations.conflicts++;
					if (isDatabaseLockNotAvailable(error)) observations.lockNotAvailable++;
					const e = error as {
						code?: string;
						cause?: { originalCode?: string };
						meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
					};
					observations.failureCodes.push(
						e.meta?.driverAdapterError?.cause?.originalCode ??
							e.cause?.originalCode ??
							e.code ??
							"unknown",
					);
					observations.failureStages.push(stage);
					throw error;
				}
			};
		},
	});
	return { observed, observations };
}

async function assertOutcome(f: Fixture, settled: boolean) {
	const job = await client.generationJob.findUniqueOrThrow({
		where: { id: f.jobId },
		include: { reservation: true },
	});
	const account = await client.creditAccount.findUniqueOrThrow({ where: { id: f.accountId } });
	const lots = await client.creditLot.findMany({ where: { accountId: f.accountId } });
	expect(job.status).toBe(settled ? "SUCCEEDED" : "FINALIZING");
	expect(job.reservation).toMatchObject({
		status: settled ? "SETTLED" : "ACTIVE",
		settledAmount: settled ? 5n : 0n,
		releasedAmount: 0n,
	});
	expect(account).toMatchObject({
		spendableCredits: 95n,
		reservedCredits: settled ? 0n : 5n,
		creditDebt: 0n,
	});
	expect(lots).toHaveLength(1);
	expect(lots[0]).toMatchObject({ remainingAmount: 95n, reservedAmount: settled ? 0n : 5n });
	expect(
		await client.creditLedgerEntry.count({ where: { referenceKey: `settle:${f.jobId}` } }),
	).toBe(settled ? 1 : 0);
}

async function financialState(f: Fixture) {
	return {
		job: await client.generationJob.findUniqueOrThrow({ where: { id: f.jobId } }),
		account: await client.creditAccount.findUniqueOrThrow({ where: { id: f.accountId } }),
		lots: await client.creditLot.findMany({
			where: { accountId: f.accountId },
			orderBy: { id: "asc" },
		}),
		reservation: await client.creditReservation.findUnique({ where: { jobId: f.jobId } }),
		allocations: await client.creditReservationAllocation.findMany({
			where: { reservationId: f.reservationId },
			orderBy: { id: "asc" },
		}),
		ledger: await client.creditLedgerEntry.findMany({
			where: { accountId: f.accountId },
			orderBy: { id: "asc" },
		}),
		pass: await client.imagePassReservation.findUnique({ where: { jobId: f.jobId } }),
		passUnit: f.passUnitId
			? await client.imagePassUnit.findUnique({ where: { id: f.passUnitId } })
			: null,
		passLedger: await client.imagePassLedgerEntry.findMany({
			where: { jobId: f.jobId },
			orderBy: { id: "asc" },
		}),
		outbox: await client.outboxEvent.findMany({
			where: { aggregateId: f.jobId },
			orderBy: { id: "asc" },
		}),
	};
}

async function assertPassOutcome(f: Fixture, settled: boolean) {
	const state = await financialState(f);
	expect(state.job.status).toBe(settled ? "SUCCEEDED" : "FINALIZING");
	expect(state.pass?.status).toBe(settled ? "SETTLED" : "ACTIVE");
	expect(state.passUnit?.status).toBe(settled ? "CONSUMED" : "RESERVED");
	expect(state.passLedger.filter((entry) => entry.operation === "CONSUME")).toHaveLength(
		settled ? 1 : 0,
	);
	expect(state.account).toMatchObject({
		spendableCredits: 0n,
		reservedCredits: 0n,
		creditDebt: 0n,
	});
	expect(state.ledger).toHaveLength(0);
}

async function waitForBlockedBy(blockerPid: number) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const [state] = await client.$queryRaw<Array<{ waiting: boolean }>>`
		SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
		if (state?.waiting) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("SETTLEMENT_EXPECTED_DATABASE_WAIT_NOT_OBSERVED");
}

async function guestCleanupFixture() {
	const f = await fixture("guest-cleanup");
	// An old cutoff isolates this sweep from unrelated fixture rows in the shared
	// test database. PostgreSQL evidence validity still uses its real wall clock.
	const now = new Date("2001-01-01T00:00:00Z");
	const expired = new Date(now.getTime() - 1_000);
	await client.user.create({
		data: {
			id: f.ownerId,
			name: "settlement guest fixture",
			email: `${crypto.randomUUID()}@test.invalid`,
			emailVerified: false,
			isAnonymous: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await client.session.create({
		data: {
			id: crypto.randomUUID(),
			token: crypto.randomUUID(),
			userId: f.ownerId,
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await client.mediaAsset.update({
		where: { id: f.assetId },
		data: {
			retentionClass: "GUEST_TRIAL",
			deleteAfter: expired,
		},
	});
	const trialData = {
		ownerId: f.ownerId,
		promotionPeriod: f.ownerId,
		capabilityVersion: "settlement-test",
		eligibility: "IN_FLIGHT" as const,
		sponsorCredits: 5n,
		frozenQuotedRiskMicros: 1n,
		projectedDispatchAt: expired,
		estimateExpiresAt: expired,
		expiresAt: expired,
		abuseEvidenceExpiresAt: new Date("2002-01-01T00:00:00Z"),
		createdAt: new Date("2000-12-30T00:00:00Z"),
		updatedAt: new Date("2000-12-30T00:00:00Z"),
	};
	await client.guestRiskBudgetBucket.create({
		data: {
			promotionPeriod: f.ownerId,
			subjectHash: "global",
			reservedMicros: 1n,
			consumedMicros: 1n,
			expiresAt: new Date("2002-01-01T00:00:00Z"),
		},
	});
	const activeTrial = await client.guestMediaTrial.create({
		data: {
			...trialData,
			riskState: "COMMITTED",
			currentJobId: f.jobId,
			providerBoundaryAt: expired,
		},
	});
	await client.generationJob.update({
		where: { id: f.jobId },
		data: {
			guestTrialId: activeTrial.id,
			serviceClass: "GUEST_SLOW",
		},
	});
	const waitingTrial = await client.guestMediaTrial.create({
		data: {
			...trialData,
			riskState: "HELD",
		},
	});
	const common = {
		ownerType: "USER" as const,
		ownerId: f.ownerId,
		submittedByUserId: f.ownerId,
		productKey: "image-fast",
		catalogVersion: "settlement-test",
		pricingVersion: "settlement-test",
		inputSnapshot: {},
		pricingSnapshot: { settlementPolicy: { maxCharge: "5" } },
	};
	const quote = await client.generationQuote.create({
		data: { ...common, credits: 5n, costMicros: 1n, expiresAt: expired },
	});
	const waitingJob = await client.generationJob.create({
		data: {
			...common,
			quoteId: quote.id,
			idempotencyKey: `${f.ownerId}:waiting`,
			creditsReserved: 5n,
			status: "DISPATCH_QUEUED",
			serviceClass: "GUEST_SLOW",
			guestTrialId: waitingTrial.id,
		},
	});
	await client.guestMediaTrial.update({
		where: { id: waitingTrial.id },
		data: { currentJobId: waitingJob.id },
	});
	const waitingReservation = await reserveCredits(
		{
			accountId: f.accountId,
			jobId: waitingJob.id,
			amount: 5n,
			referenceKey: `${f.ownerId}:waiting:reserve`,
		},
		client,
	);
	return { ...f, now, waitingJobId: waitingJob.id, waitingReservationId: waitingReservation.id };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
async function bounded<T>(pending: Promise<T>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("SETTLEMENT_DIAGNOSTIC_GATE_TIMEOUT")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
function planNodes(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const plan = value as Record<string, unknown>;
	return [
		{
			node: plan["Node Type"],
			relation: plan["Relation Name"],
			index: plan["Index Name"],
			rows: plan["Plan Rows"],
		},
		...(Array.isArray(plan.Plans) ? plan.Plans.flatMap(planNodes) : []),
	];
}

async function rejectOutput(f: Fixture) {
	await client.$transaction(async (tx) => {
		await tx.mediaAsset.update({
			where: { id: f.assetId },
			data: { status: "VERIFYING", verificationGeneration: 2 },
		});
		await tx.assetModerationResult.create({
			data: {
				assetId: f.assetId,
				assetChecksum: "c".repeat(64),
				verificationGeneration: 2,
				attemptNumber: 1,
				evidenceKind: "OUTPUT",
				provider: "test",
				ruleVersion: MEDIA_VERIFICATION_RULE_VERSION,
				policyVersion: MEDIA_VERIFICATION_POLICY_VERSION,
				status: "REJECTED",
				reasonCode: "SEXUAL_CONTENT",
				categories: {},
				rawEnvelope: {},
				validUntil: new Date(Date.now() + 3_600_000),
			},
		});
		await tx.mediaAsset.update({ where: { id: f.assetId }, data: { status: "QUARANTINED" } });
		const job = await tx.generationJob.findUniqueOrThrow({ where: { id: f.jobId } });
		await tx.generationJob.update({
			where: { id: f.jobId },
			data: {
				pricingSnapshot: {
					...(job.pricingSnapshot as Record<string, Prisma.JsonValue>),
					outputModerationBillingPolicy: OUTPUT_MODERATION_BILLING_POLICY,
				},
			},
		});
	});
}

describe.each([false, true])("settlement on PostgreSQL with fresh-read %s", (fresh) => {
	const results: Record<string, unknown> = fresh ? {} : diagnostics;
	if (fresh) diagnostics.freshRead = results;
	beforeAll(() => vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", fresh ? "true" : undefined));
	afterAll(() => vi.unstubAllEnvs());
	it("retains its selected isolation, current evidence and idempotent financial settlement", async () => {
		const f = await fixture("correctness");
		const { observed, observations } = instrument(client);
		const store = createDatabaseSettlementStore(observed);
		const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
		expect(claim).not.toBeNull();
		await client.mediaAsset.update({ where: { id: f.assetId }, data: { status: "VERIFYING" } });
		await store.settle(claim!);
		await assertOutcome(f, false);
		await client.mediaAsset.update({ where: { id: f.assetId }, data: { status: "READY" } });
		await Promise.all([store.settle(claim!), store.settle(claim!)]);
		await assertOutcome(f, true);
		const terminal = await financialState(f);
		await store.settle(claim!);
		expect(await financialState(f)).toEqual(terminal);
		expect(new Set(observations.isolation)).toEqual(
			new Set([fresh ? "ReadCommitted" : "Serializable"]),
		);
		expect(observations.fullReads).toBeLessThanOrEqual(observations.attempts);
	});

	it.each(["CREDITS", "IMAGE_PASS"] as const)(
		"rolls back stale %s approval after waiting for a ReadCommitted moderation writer",
		async (fundingSource) => {
			const f = await fixture(`mixed-moderation-${fundingSource}`, fundingSource);
			const blockerReady = deferred<number>();
			const release = deferred<void>();
			const snapshotRead = deferred<void>();
			const measured = instrument(client, false, undefined, () => snapshotRead.resolve());
			const store = createDatabaseSettlementStore(measured.observed);
			const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
			expect(claim).not.toBeNull();
			const before = await financialState(f);
			const blocker = client.$transaction(
				async (tx) => {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.assetId}`}, 0))`;
					await tx.mediaAsset.update({
						where: { id: f.assetId },
						data: {
							status: "VERIFYING",
							verificationGeneration: { increment: 1 },
							verificationAttemptCount: 0,
						},
					});
					const [backend] = await tx.$queryRaw<
						Array<{ pid: number }>
					>`SELECT pg_backend_pid() AS pid`;
					blockerReady.resolve(backend!.pid);
					await release.promise;
				},
				{ isolationLevel: "ReadCommitted", timeout: 10_000 },
			);
			void blocker.catch(blockerReady.reject);
			let pending: Promise<void> | undefined;
			try {
				const pid = await bounded(blockerReady.promise);
				pending = store.settle(claim!);
				void pending.catch(snapshotRead.reject);
				await bounded(snapshotRead.promise);
				await bounded(waitForBlockedBy(pid));
			} finally {
				release.resolve();
				await blocker;
				await pending;
			}
			results[`mixedModeration${fundingSource}`] = {
				...measured.observations,
			};
			expect(await financialState(f)).toEqual(before);
			const freshCredits = fresh && fundingSource === "CREDITS";
			expect(measured.observations).toMatchObject({
				attempts: freshCredits ? 1 : 2,
				conflicts: freshCredits ? 0 : 1,
				terminalWrites: freshCredits ? 0 : 1,
				fenceChecks: 1,
				failureCodes: freshCredits ? [] : ["40001"],
			});
			if (fundingSource === "CREDITS") await assertOutcome(f, false);
			else await assertPassOutcome(f, false);
		},
	);

	it("keeps image-pass terminal replay free of new ledger, job or Outbox side effects", async () => {
		const f = await fixture("pass-replay", "IMAGE_PASS");
		const store = createDatabaseSettlementStore(client);
		const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
		expect(claim).not.toBeNull();
		await store.settle(claim!);
		await assertPassOutcome(f, true);
		const before = await financialState(f);
		await store.settle(claim!);
		expect(await financialState(f)).toEqual(before);
	});

	it("rolls back all four NOWAIT failures and preserves the durable event for retry", async () => {
		const f = await fixture("busy-fence");
		const measured = instrument(client);
		const store = createDatabaseSettlementStore(measured.observed);
		const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
		expect(claim).not.toBeNull();
		const before = await financialState(f);
		const held = deferred<void>();
		const release = deferred<void>();
		const blocker = client.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "media_asset" WHERE "id" = ${f.assetId} FOR UPDATE`;
				held.resolve();
				await release.promise;
			},
			{ isolationLevel: "ReadCommitted", timeout: 10_000 },
		);
		void blocker.catch(held.reject);
		try {
			await bounded(held.promise);
			await expect(bounded(store.settle(claim!))).rejects.toBeInstanceOf(
				SettlementTransactionConflictError,
			);
			expect(await financialState(f)).toEqual(before);
			expect(measured.observations).toMatchObject({
				attempts: 4,
				lockNotAvailable: 4,
				terminalWrites: fresh ? 0 : 4,
				fenceChecks: 4,
			});
			expect(measured.observations.failureCodes).toEqual(["55P03", "55P03", "55P03", "55P03"]);
		} finally {
			release.resolve();
			await blocker;
		}
		results.exhaustedFence = measured.observations;
		await createDatabaseSettlementStore(client).settle(claim!);
		await assertOutcome(f, true);
	});

	it("does not deadlock with guest cleanup holding output A while releasing waiting job B", async () => {
		const f = await guestCleanupFixture();
		const heldAccount = deferred<number>();
		const cleanupAtAccount = deferred<void>();
		const release = deferred<void>();
		let paused = false;
		const pauseForCleanup = async (tx: Prisma.TransactionClient) => {
			if (paused) return;
			paused = true;
			const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			heldAccount.resolve(backend!.pid);
			await release.promise;
		};
		const measured = instrument(
			client,
			false,
			fresh ? undefined : pauseForCleanup,
			undefined,
			undefined,
			fresh
				? async (tx, sql) => {
						if (sql.includes('FROM "media_asset"') && sql.includes("FOR UPDATE NOWAIT"))
							await pauseForCleanup(tx);
					}
				: undefined,
		);
		const cleanup = instrument(client, false, undefined, undefined, undefined, async (_tx, sql) => {
			if (sql.includes('FROM "credit_account"') && sql.includes("FOR UPDATE"))
				cleanupAtAccount.resolve();
		});
		const store = createDatabaseSettlementStore(measured.observed);
		const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
		expect(claim).not.toBeNull();
		const settling = store.settle(claim!);
		void settling.catch(heldAccount.reject);
		let cleaning: ReturnType<typeof expireGuestMediaTransaction> | undefined;
		try {
			const pid = await bounded(heldAccount.promise);
			cleaning = expireGuestMediaTransaction({ now: f.now, limit: 25 }, cleanup.observed);
			void cleaning.catch(cleanupAtAccount.reject);
			await bounded(cleanupAtAccount.promise);
			await bounded(waitForBlockedBy(pid));
		} finally {
			release.resolve();
			await bounded(Promise.all([settling, cleaning]));
		}
		results.guestCleanup = measured.observations;
		expect(measured.observations.lockNotAvailable).toBeGreaterThanOrEqual(1);
		expect(measured.observations.attempts).toBeLessThanOrEqual(4);
		expect(measured.observations.failureCodes).not.toContain("40P01");
		expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: f.assetId } })).toMatchObject({
			status: "DELETED",
		});
		expect(await client.generationJob.findUniqueOrThrow({ where: { id: f.jobId } })).toMatchObject({
			status: "FAILED",
		});
		expect(
			await client.generationJob.findUniqueOrThrow({ where: { id: f.waitingJobId } }),
		).toMatchObject({ status: "FAILED", failureCode: "GUEST_QUEUE_EXPIRED" });
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.accountId } }),
		).toMatchObject({ spendableCredits: 100n, reservedCredits: 0n, creditDebt: 0n });
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { id: f.reservationId } }),
		).toMatchObject({ status: "SETTLED", settledAmount: 0n, releasedAmount: 5n });
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { id: f.waitingReservationId } }),
		).toMatchObject({ status: "RELEASED", settledAmount: 0n, releasedAmount: 5n });
	});

	it.each(["refund-first", "settlement-first"] as const)(
		"preserves refund accounting without deadlock when %s",
		async (order) => {
			const f = await fixture(order);
			const refund = {
				accountId: f.accountId,
				amount: 100n,
				grantReferenceKey: `${f.ownerId}:grant`,
				referenceKey: `${f.ownerId}:refund`,
			};
			const held = deferred<number>();
			const release = deferred<void>();
			let paused = false;
			const measured = instrument(
				client,
				false,
				order === "settlement-first"
					? async (tx) => {
							if (paused) return;
							paused = true;
							const [backend] = await tx.$queryRaw<
								Array<{ pid: number }>
							>`SELECT pg_backend_pid() AS pid`;
							held.resolve(backend!.pid);
							await release.promise;
						}
					: undefined,
			);
			const store = createDatabaseSettlementStore(measured.observed);
			const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
			expect(claim).not.toBeNull();
			let settling: Promise<void> | undefined;
			let refunding: Promise<unknown> | undefined;
			try {
				if (order === "refund-first") {
					refunding = client.$transaction(
						async (tx) => {
							await refundCreditGrant(refund, tx);
							const [backend] = await tx.$queryRaw<
								Array<{ pid: number }>
							>`SELECT pg_backend_pid() AS pid`;
							held.resolve(backend!.pid);
							await release.promise;
						},
						{ isolationLevel: "Serializable", timeout: 10_000 },
					);
					void refunding.catch(held.reject);
					const pid = await bounded(held.promise);
					settling = store.settle(claim!);
					await bounded(waitForBlockedBy(pid));
				} else {
					settling = store.settle(claim!);
					void settling.catch(held.reject);
					const pid = await bounded(held.promise);
					refunding = refundCreditGrant(refund, client);
					await bounded(waitForBlockedBy(pid));
				}
			} finally {
				release.resolve();
				await bounded(Promise.all([settling, refunding]));
			}
			results[order] = measured.observations;
			expect(measured.observations.failureCodes).not.toContain("40P01");
			expect(
				await client.creditAccount.findUniqueOrThrow({ where: { id: f.accountId } }),
			).toMatchObject({ spendableCredits: 0n, reservedCredits: 0n, creditDebt: 5n });
			expect(
				await client.creditReservation.findUniqueOrThrow({ where: { id: f.reservationId } }),
			).toMatchObject({ status: "SETTLED", settledAmount: 5n, releasedAmount: 0n });
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: f.accountId, type: "SETTLE" } }),
			).toBe(1);
			expect(
				await client.creditLedgerEntry.count({ where: { accountId: f.accountId, type: "REFUND" } }),
			).toBe(1);
		},
	);

	it("retries a committed cancellation and releases the reservation without stale charges", async () => {
		const f = await fixture("cancellation");
		const held = deferred<void>();
		const release = deferred<void>();
		let paused = false;
		const pauseForCancellation = async () => {
			if (paused) return;
			paused = true;
			held.resolve();
			await release.promise;
		};
		const measured = instrument(
			client,
			false,
			fresh ? undefined : pauseForCancellation,
			undefined,
			undefined,
			fresh
				? async (_tx, sql) => {
						if (sql.includes('FROM "generation_job"') && sql.includes("FOR UPDATE NOWAIT"))
							await pauseForCancellation();
					}
				: undefined,
		);
		const store = createDatabaseSettlementStore(measured.observed);
		const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
		expect(claim).not.toBeNull();
		const settling = store.settle(claim!);
		void settling.catch(held.reject);
		try {
			await bounded(held.promise);
			await client.$transaction(async (tx) => {
				await tx.generationJob.update({
					where: { id: f.jobId },
					data: { status: "CANCELED", version: { increment: 1 }, terminalAt: new Date() },
				});
				await tx.outboxEvent.create({
					data: {
						eventType: "GENERATION_SETTLE",
						aggregateType: "GENERATION_JOB",
						aggregateId: f.jobId,
						dedupeKey: `${f.ownerId}:cancel-settle`,
						payload: { jobId: f.jobId, version: 1 },
					},
				});
			});
		} finally {
			release.resolve();
			await bounded(settling);
		}
		results.cancellation = measured.observations;
		expect(measured.observations.conflicts).toBe(fresh ? 0 : 1);
		expect(await client.generationJob.findUniqueOrThrow({ where: { id: f.jobId } })).toMatchObject({
			status: "CANCELED",
		});
		expect(
			await client.creditAccount.findUniqueOrThrow({ where: { id: f.accountId } }),
		).toMatchObject({ spendableCredits: 100n, reservedCredits: 0n, creditDebt: 0n });
		expect(
			await client.creditReservation.findUniqueOrThrow({ where: { id: f.reservationId } }),
		).toMatchObject({ status: "SETTLED", settledAmount: 0n, releasedAmount: 5n });
		expect(
			await client.creditLedgerEntry.count({ where: { accountId: f.accountId, type: "SETTLE" } }),
		).toBe(1);
	});

	it("serializes the one-time moderation grace across two jobs on one account", async () => {
		const first = await fixture("grace-first");
		const second = await fixture("grace-second", "CREDITS", first);
		await rejectOutput(first);
		await rejectOutput(second);
		const store = createDatabaseSettlementStore(client);
		await Promise.all(
			[first, second].map((f) => settleGeneration({ jobId: f.jobId, version: 0 }, { store })),
		);
		const states = await Promise.all([first, second].map(financialState));
		expect(states.map(({ reservation }) => reservation!.settledAmount)).toEqual(
			expect.arrayContaining([0n, 5n]),
		);
		expect(states.map(({ job }) => job.failureCode)).toEqual(
			expect.arrayContaining(["OUTPUT_CONTENT_BLOCKED_CHARGED", "OUTPUT_CONTENT_BLOCKED_WAIVED"]),
		);
		expect(states[0]!.account).toMatchObject({
			spendableCredits: 95n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect([first.jobId, second.jobId]).toContain(states[0]!.account.outputModerationGraceJobId);
		expect(states[0]!.ledger.filter(({ type }) => type === "SETTLE")).toHaveLength(2);
		results.grace = {
			charged: states.map(({ reservation }) => reservation!.settledAmount.toString()),
			ledgerCount: states[0]!.ledger.length,
		};
	});

	it("preserves credit expiry without restoring expired released credits", async () => {
		const f = await fixture("credit-expiry");
		await client.creditLot.updateMany({
			where: { accountId: f.accountId },
			data: { expiresAt: new Date("2001-01-01T00:00:00Z") },
		});
		await client.mediaAsset.update({
			where: { id: f.assetId },
			data: { status: "DELETED", deletedAt: new Date() },
		});
		await settleGeneration(
			{ jobId: f.jobId, version: 0 },
			{ store: createDatabaseSettlementStore(client) },
		);
		const state = await financialState(f);
		expect(state.job.status).toBe("FAILED");
		expect(state.account).toMatchObject({
			spendableCredits: 0n,
			reservedCredits: 0n,
			creditDebt: 0n,
		});
		expect(state.reservation).toMatchObject({
			status: "SETTLED",
			settledAmount: 0n,
			releasedAmount: 5n,
		});
		expect(state.lots[0]).toMatchObject({
			remainingAmount: 0n,
			reservedAmount: 0n,
			expiredUnrefundedAmount: 100n,
		});
		expect(state.ledger.filter(({ type }) => type === "EXPIRE")).toHaveLength(1);
		expect(state.ledger.filter(({ type }) => type === "SETTLE")).toHaveLength(1);
	});

	it("repairs a non-active reservation under current evidence without another ledger mutation", async () => {
		const f = await fixture("non-active-repair");
		const store = createDatabaseSettlementStore(client);
		await settleGeneration({ jobId: f.jobId, version: 0 }, { store });
		const terminal = await financialState(f);
		await client.generationJob.update({
			where: { id: f.jobId },
			data: { status: "FINALIZING", terminalAt: null, version: { increment: 1 } },
		});
		await client.mediaAsset.update({ where: { id: f.assetId }, data: { status: "VERIFYING" } });
		expect(await settleGeneration({ jobId: f.jobId, version: 0 }, { store })).toEqual({
			outcome: "SKIPPED",
		});
		expect((await financialState(f)).job.status).toBe("FINALIZING");
		await client.mediaAsset.update({ where: { id: f.assetId }, data: { status: "READY" } });
		expect(await settleGeneration({ jobId: f.jobId, version: 0 }, { store })).toEqual({
			outcome: "SKIPPED",
		});
		const repaired = await financialState(f);
		expect(repaired.job.status).toBe("SUCCEEDED");
		expect(repaired.ledger).toEqual(terminal.ledger);
		expect(repaired.account).toEqual(terminal.account);
	});

	it("never repairs from an outer non-active claim snapshot invalidated by moderation", async () => {
		const f = await fixture("non-active-claim-race");
		await settleGeneration(
			{ jobId: f.jobId, version: 0 },
			{ store: createDatabaseSettlementStore(client) },
		);
		await client.generationJob.update({
			where: { id: f.jobId },
			data: { status: "FINALIZING", terminalAt: null, version: { increment: 1 } },
		});
		const before = await financialState(f);
		const read = deferred<void>();
		const release = deferred<void>();
		const database = new Proxy(client, {
			get(target, key, receiver) {
				if (key !== "generationJob") return Reflect.get(target, key, receiver);
				return new Proxy(target.generationJob, {
					get(delegate, method, delegateReceiver) {
						if (method !== "findFirst") return Reflect.get(delegate, method, delegateReceiver);
						return async (args: Prisma.GenerationJobFindFirstArgs) => {
							const result = await delegate.findFirst(args);
							read.resolve();
							await release.promise;
							return result;
						};
					},
				});
			},
		});
		const claiming = createDatabaseSettlementStore(database).claimSettlement({
			jobId: f.jobId,
			version: 0,
		});
		void claiming.catch(read.reject);
		try {
			await bounded(read.promise);
			await client.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-verification:${f.assetId}`}, 0))`;
				await tx.mediaAsset.update({
					where: { id: f.assetId },
					data: { status: "VERIFYING", verificationGeneration: { increment: 1 } },
				});
			});
		} finally {
			release.resolve();
			await bounded(claiming);
		}
		expect(await financialState(f)).toEqual(before);
	});

	it.runIf(fresh).each(["legacy-first", "fresh-first"] as const)(
		"keeps the old SSI settlement compatible on one account when %s",
		async (order) => {
			const legacy = await fixture(`mixed-${order}-legacy`);
			const current = await fixture(`mixed-${order}-current`, "CREDITS", legacy);
			const held = deferred<number>();
			const release = deferred<void>();
			let paused = false;
			const pause = async (tx: Prisma.TransactionClient) => {
				if (paused) return;
				paused = true;
				const [backend] = await tx.$queryRaw<
					Array<{ pid: number }>
				>`SELECT pg_backend_pid() AS pid`;
				held.resolve(backend!.pid);
				await release.promise;
			};
			const oldMeasured = instrument(client, false, order === "legacy-first" ? pause : undefined);
			const newMeasured = instrument(client, false, order === "fresh-first" ? pause : undefined);
			const oldStore = createDatabaseSettlementStore(oldMeasured.observed);
			const newStore = createDatabaseSettlementStore(newMeasured.observed);
			const oldClaim = await oldStore.claimSettlement({ jobId: legacy.jobId, version: 0 });
			let oldPending: Promise<void> | undefined;
			let newPending: ReturnType<typeof settleGeneration> | undefined;
			const startOld = () => {
				vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", "false");
				const pending = oldStore.settle(oldClaim!);
				vi.stubEnv("MEDIA_SETTLEMENT_FRESH_READ_ENABLED", "true");
				return pending;
			};
			try {
				if (order === "legacy-first") oldPending = startOld();
				else
					newPending = settleGeneration({ jobId: current.jobId, version: 0 }, { store: newStore });
				void (oldPending ?? newPending)!.catch(held.reject);
				const pid = await bounded(held.promise);
				if (order === "legacy-first")
					newPending = settleGeneration({ jobId: current.jobId, version: 0 }, { store: newStore });
				else oldPending = startOld();
				await bounded(waitForBlockedBy(pid));
			} finally {
				release.resolve();
				await bounded(Promise.all([oldPending, newPending]));
			}
			const state = await financialState(legacy);
			expect(state.account).toMatchObject({
				spendableCredits: 90n,
				reservedCredits: 0n,
				creditDebt: 0n,
			});
			expect(state.ledger.filter(({ type }) => type === "SETTLE")).toHaveLength(2);
			for (const f of [legacy, current]) {
				const job = await client.generationJob.findUniqueOrThrow({
					where: { id: f.jobId },
					include: { reservation: true },
				});
				expect(job.status).toBe("SUCCEEDED");
				expect(job.reservation).toMatchObject({ status: "SETTLED", settledAmount: 5n });
			}
			expect(new Set(oldMeasured.observations.isolation)).toEqual(new Set(["Serializable"]));
			expect(new Set(newMeasured.observations.isolation)).toEqual(new Set(["ReadCommitted"]));
			results[order] = { legacy: oldMeasured.observations, fresh: newMeasured.observations };
		},
	);

	it.runIf(fresh).each(["binding-first", "settlement-first"] as const)(
		"protects an empty OUTPUT set from the compatible old SSI binder when %s",
		async (order) => {
			const f = await fixture(`empty-${order}`);
			await client.generationJobAsset.deleteMany({ where: { jobId: f.jobId } });
			const held = deferred<number>();
			const release = deferred<void>();
			let paused = false;
			const measured = instrument(
				client,
				false,
				undefined,
				undefined,
				undefined,
				async (tx, sql) => {
					if (
						paused ||
						!sql.includes(order === "binding-first" ? 'FROM "credit_account"' : "clock_timestamp()")
					)
						return;
					paused = true;
					const [backend] = await tx.$queryRaw<
						Array<{ pid: number }>
					>`SELECT pg_backend_pid() AS pid`;
					held.resolve(backend!.pid);
					await release.promise;
				},
			);
			const assetId = `${f.assetId}-late`;
			const binding = {
				jobId: f.jobId,
				asset: {
					id: assetId,
					ownerId: f.ownerId,
					objectKey: `tests/${f.ownerId}/late.png`,
					mimeType: "image/png",
					byteSize: 128n,
					checksum: "a".repeat(64),
					sourceUrl: "https://example.test/late.png",
				},
			};
			const settling = settleGeneration(
				{ jobId: f.jobId, version: 0 },
				{ store: createDatabaseSettlementStore(measured.observed) },
			);
			void settling.catch(held.reject);
			let bindingResult: Promise<unknown> | undefined;
			try {
				const pid = await bounded(held.promise);
				if (order === "binding-first")
					await createGenerationOutputAssetBindingTransaction(binding, client);
				else {
					// Start an old SSI snapshot before the new terminal commit. The
					// compatible no-op job UPDATE must conflict or fail eligibility.
					bindingResult = createGenerationOutputAssetBindingTransaction(binding, client).catch(
						(error) => error,
					);
					await bounded(waitForBlockedBy(pid));
				}
			} finally {
				release.resolve();
				await bounded(settling);
			}
			const state = await financialState(f);
			if (order === "binding-first") {
				expect(measured.observations.attempts).toBe(2);
				expect(measured.observations.failureCodes).toEqual(["SETTLEMENT_FRESH_READ_CONFLICT"]);
				expect(state.job.status).toBe("FINALIZING");
				expect(state.reservation?.status).toBe("ACTIVE");
				expect(state.ledger.filter(({ type }) => type === "SETTLE")).toHaveLength(0);
			} else {
				expect(await bounded(bindingResult!)).toMatchObject({
					message: "GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT",
				});
				expect(state.job.status).toBe("FAILED");
				expect(state.reservation).toMatchObject({
					status: "SETTLED",
					settledAmount: 0n,
					releasedAmount: 5n,
				});
				expect(await client.mediaAsset.findUnique({ where: { id: assetId } })).toBeNull();
				expect(await client.generationJobAsset.count({ where: { jobId: f.jobId } })).toBe(0);
			}
			results[`empty-${order}`] = measured.observations;
		},
	);

	it.runIf(diagnostic)(
		"compares 50 independent owners with original, projected and diagnostic replay reads",
		async () => {
			const cohorts = {
				original: [] as Fixture[],
				projected: [] as Fixture[],
				knownNewNoReplay: [] as Fixture[],
			};
			const modes = fresh
				? (["projected"] as const)
				: (["original", "projected", "knownNewNoReplay"] as const);
			for (const mode of modes)
				for (let i = 0; i < 50; i++) cohorts[mode].push(await fixture(`${mode}-${i}`));
			const measurements: Record<string, unknown> = {};
			for (const mode of modes) {
				const jobs = [];
				for (const f of cohorts[mode]) {
					const database = new PrismaClient({
						adapter: new PrismaPg({ connectionString, max: 1 }),
					});
					clients.push(database);
					await database.$queryRaw`SELECT 1`;
					const measured = instrument(
						database,
						mode === "original",
						undefined,
						undefined,
						mode === "knownNewNoReplay" ? `settle:${f.jobId}` : undefined,
					);
					const store = createDatabaseSettlementStore(measured.observed);
					const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
					expect(claim).not.toBeNull();
					jobs.push({ f, database, ...measured, store, claim: claim! });
				}
				const rows = await Promise.all(
					jobs.map(async (entry, index) => {
						const started = performance.now();
						try {
							if (fresh)
								await settleGeneration(
									{ jobId: entry.f.jobId, version: 0 },
									{ store: entry.store },
								);
							else await entry.store.settle(entry.claim);
							return {
								index,
								status: "fulfilled",
								durationMs: performance.now() - started,
								...entry.observations,
							};
						} catch (error) {
							const transactionError =
								error instanceof SettlementTransactionConflictError ? error.cause : error;
							return {
								index,
								status: "rejected",
								durationMs: performance.now() - started,
								serializationFailure: isDatabaseSerializationConflict(transactionError),
								...entry.observations,
							};
						}
					}),
				);
				await Promise.all(jobs.map(({ database }) => database.$disconnect()));
				measurements[mode] = {
					diagnosticOnly: mode === "knownNewNoReplay",
					count: rows.length,
					fulfilled: rows.filter((row) => row.status === "fulfilled").length,
					conflicts: rows.reduce((sum, row) => sum + row.conflicts, 0),
					rows,
				};
				// Failed initial attempts remain visible in the report. Explicit serial
				// recovery below is not counted as first-attempt success or latency.
				for (const row of rows) {
					const entry = jobs[row.index]!;
					await assertOutcome(entry.f, row.status === "fulfilled");
					if (row.status === "rejected")
						await createDatabaseSettlementStore(client).settle(entry.claim);
					await assertOutcome(entry.f, true);
					if (fresh) {
						const committed = await financialState(entry.f);
						await settleGeneration(
							{ jobId: entry.f.jobId, version: 0 },
							{ store: createDatabaseSettlementStore(client) },
						);
						expect(await financialState(entry.f)).toEqual(committed);
						expect(
							await client.generationJobAsset.count({
								where: { jobId: entry.f.jobId, role: "OUTPUT" },
							}),
						).toBe(1);
						expect(
							await client.mediaAsset.count({
								where: { ownerId: entry.f.ownerId, kind: "OUTPUT" },
							}),
						).toBe(1);
					}
				}
			}
			results.cohorts = measurements;
		},
		90_000,
	);

	it.runIf(diagnostic && !fresh)(
		"captures exact settlement SELECT plans and held predicate locks",
		async () => {
			const reports = [];
			for (const mode of ["original", "projected"] as const) {
				const f = await fixture(`locks-${mode}`);
				const samples = new Map<string, { query: string; params: unknown[] }>();
				let capturing = false;
				const database = new PrismaClient({
					adapter: new PrismaPg({ connectionString, max: 1 }),
					log: [{ level: "query", emit: "event" }],
				});
				clients.push(database);
				database.$on("query", (event) => {
					if (
						!capturing ||
						!/^\s*SELECT\b/i.test(event.query) ||
						/pg_advisory|pg_backend_pid/.test(event.query)
					)
						return;
					const params: unknown = JSON.parse(event.params);
					if (!Array.isArray(params)) throw new Error("UNSUPPORTED_QUERY_PARAMETERS");
					if (!samples.has(event.query)) samples.set(event.query, { query: event.query, params });
				});
				const reached = deferred<number>();
				const release = deferred<void>();
				let paused = false;
				const measured = instrument(database, mode === "original", async (tx) => {
					if (paused) return;
					paused = true;
					const [backend] = await tx.$queryRaw<
						Array<{ pid: number }>
					>`SELECT pg_backend_pid() AS pid`;
					reached.resolve(backend!.pid);
					await release.promise;
				});
				const store = createDatabaseSettlementStore(measured.observed);
				const claim = await store.claimSettlement({ jobId: f.jobId, version: 0 });
				expect(claim).not.toBeNull();
				capturing = true;
				const pending = store.settle(claim!);
				void pending.catch(reached.reject);
				let locks: unknown;
				try {
					const pid = await bounded(reached.promise);
					locks = await client.$queryRaw`
					SELECT locktype, mode, relation::regclass::text AS relation, page, tuple
					FROM pg_locks WHERE pid = ${pid} AND mode = 'SIReadLock'
					ORDER BY relation, locktype, page, tuple`;
				} finally {
					release.resolve();
					await pending;
					capturing = false;
				}
				const plans = [];
				for (const { query, params } of samples.values()) {
					const rows = await client.$queryRawUnsafe<
						Array<{ "QUERY PLAN": Array<{ Plan: unknown }> }>
					>(`EXPLAIN (FORMAT JSON) ${query}`, ...params);
					plans.push({ query, nodes: planNodes(rows[0]!["QUERY PLAN"][0]!.Plan) });
				}
				expect(plans.length).toBeGreaterThan(5);
				expect(Array.isArray(locks)).toBe(true);
				reports.push({ mode, locks, plans });
				await database.$disconnect();
			}
			diagnostics.predicateLocksAndPlans = reports;
		},
		30_000,
	);
});
