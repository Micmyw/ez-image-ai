import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient, type Prisma } from "../../generated/client";
import { localSqlMetricsEnabled } from "../../query-metrics";
import {
	claimGenerationOutputTransferTransaction,
	createGenerationOutputAssetBindingTransaction,
	markMediaAssetDeletedTransaction,
} from "./assets";
import { isDatabaseSerializationConflict } from "./types";

let client: PrismaClient;
const prefix = `output-claim-${crypto.randomUUID()}`;
const owners: string[] = [];
const jobs: string[] = [];
const quotes: string[] = [];
type Claim = Parameters<typeof claimGenerationOutputTransferTransaction>[0];
const bindingWriters = ["fresh-read-claim", "serializable-claim", "legacy-binding"] as const;
type BindingWriter = (typeof bindingWriters)[number];

function writeBinding(writer: BindingWriter, input: Claim, database: PrismaClient) {
	vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", writer === "fresh-read-claim" ? "true" : "false");
	if (writer === "legacy-binding")
		return createGenerationOutputAssetBindingTransaction(
			{
				jobId: input.jobId,
				asset: {
					id: input.assetId,
					ownerId: input.ownerId,
					objectKey: input.objectKey,
					mimeType: input.mimeType,
					byteSize: 10n,
					checksum: "a".repeat(64),
					sourceUrl: input.sourceUrl,
				},
			},
			database,
		);
	return claimGenerationOutputTransferTransaction(
		{ ...input, streamingTransfersOnly: false },
		database,
	);
}

beforeAll(() => {
	const connectionString = process.env.TEST_DATABASE_URL;
	if (
		!connectionString ||
		connectionString === process.env.DATABASE_URL ||
		!localSqlMetricsEnabled(connectionString, "true")
	) {
		throw new Error("ISOLATED_LOCAL_TEST_DATABASE_REQUIRED");
	}
	client = new PrismaClient({
		adapter: new PrismaPg({ connectionString, max: 60, connectionTimeoutMillis: 5_000 }),
	});
});
beforeEach(() => vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
	if (!client) return;
	try {
		const assets = await client.mediaAsset.findMany({
			where: { ownerId: { in: owners } },
			select: { id: true },
		});
		await client.outboxEvent.deleteMany({
			where: { aggregateId: { in: [...jobs, ...assets.map((asset) => asset.id)] } },
		});
		await client.generationJobAsset.deleteMany({ where: { jobId: { in: jobs } } });
		await client.storageUsageReservation.deleteMany({ where: { ownerId: { in: owners } } });
		await client.mediaAsset.deleteMany({ where: { ownerId: { in: owners } } });
		await client.generationJob.deleteMany({ where: { id: { in: jobs } } });
		await client.generationQuote.deleteMany({ where: { id: { in: quotes } } });
		await client.guestMediaTrial.deleteMany({ where: { ownerId: { in: owners } } });
		await client.auditLog.deleteMany({ where: { actorUserId: { in: owners } } });
		await client.mediaOwnerStorageFence.deleteMany({ where: { ownerId: { in: owners } } });
		await client.user.deleteMany({ where: { id: { in: owners } } });
	} finally {
		await client.$disconnect();
	}
});

function deferred() {
	let resolve!: () => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<void>((done, failed) => {
		resolve = done;
		reject = failed;
	});
	return { promise, resolve, reject };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("CLAIM_CONCURRENCY_TIMEOUT")), 3_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function blockTransaction(hold: (tx: Prisma.TransactionClient) => Promise<unknown>) {
	const ready = deferred();
	const release = deferred();
	let pid = 0;
	const operation = client.$transaction(
		async (tx) => {
			const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
			pid = backend!.pid;
			await hold(tx);
			ready.resolve();
			await release.promise;
		},
		{ timeout: 10_000 },
	);
	void operation.catch(ready.reject);
	try {
		await bounded(ready.promise);
	} catch (error) {
		release.resolve();
		await Promise.allSettled([operation]);
		throw error;
	}
	return { pid, release: release.resolve, operation };
}

async function waitForBlocked(pid: number) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const [blocked] = await client.$queryRaw<Array<{ blocked: boolean }>>`
			SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
		`;
		if (blocked?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("CLAIM_DID_NOT_WAIT_FOR_EXPECTED_LOCK");
}

async function seedAsset(
	input: Claim,
	overrides: Partial<Prisma.MediaAssetUncheckedCreateInput> = {},
) {
	return client.mediaAsset.create({
		data: {
			id: input.assetId,
			ownerType: "USER",
			ownerId: input.ownerId,
			verificationEngine: "legacy",
			kind: "OUTPUT",
			status: "VERIFYING",
			objectKey: input.objectKey,
			mimeType: input.mimeType,
			byteSize: 0n,
			sourceUrl: input.sourceUrl,
			...overrides,
		},
	});
}

async function makeGuest(input: Claim, due: Date) {
	const trial = await client.guestMediaTrial.create({
		data: {
			ownerId: input.ownerId,
			promotionPeriod: "claim-concurrency",
			capabilityVersion: "test",
			abuseEvidenceExpiresAt: due,
			frozenQuotedRiskMicros: 1n,
			projectedDispatchAt: new Date(),
			estimateExpiresAt: due,
			expiresAt: due,
		},
	});
	await client.generationJob.update({
		where: { id: input.jobId },
		data: { serviceClass: "GUEST_SLOW", guestTrialId: trial.id },
	});
	return { ...input, streamingTransfersOnly: false, guest: { deleteAfter: due } };
}

async function fixtures(count: number): Promise<Claim[]> {
	const now = new Date();
	const batch = crypto.randomUUID();
	const rows = Array.from({ length: count }, (_, index) => ({
		ownerId: `${prefix}-${batch}-${index}`,
		jobId: crypto.randomUUID(),
		quoteId: crypto.randomUUID(),
		assetId: `${prefix}-${batch}-asset-${index}`,
	}));
	owners.push(...rows.map((row) => row.ownerId));
	jobs.push(...rows.map((row) => row.jobId));
	quotes.push(...rows.map((row) => row.quoteId));
	await client.user.createMany({
		data: rows.map((row) => ({
			id: row.ownerId,
			name: "Output claim fixture",
			email: `${row.ownerId}@example.test`,
			emailVerified: true,
			createdAt: now,
			updatedAt: now,
		})),
	});
	await client.generationQuote.createMany({
		data: rows.map((row) => ({
			id: row.quoteId,
			ownerType: "USER",
			ownerId: row.ownerId,
			submittedByUserId: row.ownerId,
			productKey: "nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
			credits: 1n,
			costMicros: 1n,
			inputSnapshot: {},
			pricingSnapshot: {},
			expiresAt: new Date(now.getTime() + 60_000),
		})),
	});
	await client.generationJob.createMany({
		data: rows.map((row) => ({
			id: row.jobId,
			quoteId: row.quoteId,
			ownerType: "USER",
			ownerId: row.ownerId,
			submittedByUserId: row.ownerId,
			idempotencyKey: row.jobId,
			productKey: "nano-banana-2-lite",
			catalogVersion: "test",
			pricingVersion: "test",
			creditsReserved: 1n,
			inputSnapshot: {},
			pricingSnapshot: {},
			status: "FINALIZING",
			executionEngine: "legacy",
		})),
	});
	return rows.map((row) => ({
		jobId: row.jobId,
		ownerId: row.ownerId,
		assetId: row.assetId,
		objectKey: `users/${row.ownerId}/output.png`,
		mimeType: "image/png",
		sourceUrl: `provider-output:${row.jobId}:0`,
		deferOutputReview: true,
		streamingTransfersOnly: true,
		createStagingObjectKey: (token) => `users/${row.ownerId}/staging/${token}.png`,
	}));
}

describe("fresh-read generation output claims", () => {
	it.each(bindingWriters)(
		"%s invalidates an old Serializable settlement snapshot without changing job business fields",
		async (writer) => {
			const [input] = await fixtures(1);
			const before = await client.generationJob.findUniqueOrThrow({ where: { id: input!.jobId } });
			const snapshot = deferred();
			const release = deferred();
			const staleSettlement = client.$transaction(
				async (tx) => {
					const job = await tx.generationJob.findUniqueOrThrow({
						where: { id: input!.jobId },
						include: { assets: true },
					});
					expect(job.status).toBe("FINALIZING");
					expect(job.assets).toHaveLength(0);
					snapshot.resolve();
					await release.promise;
					// This is the terminal write an old SSI settlement makes after reading
					// zero outputs. A mere row lock in the RC claim cannot invalidate it.
					await tx.generationJob.update({ where: { id: job.id }, data: { status: "FAILED" } });
				},
				{ isolationLevel: "Serializable", timeout: 10_000 },
			);
			void staleSettlement.catch(snapshot.reject);
			const outcome = staleSettlement.then(
				() => ({ failed: false, error: undefined }),
				(error: unknown) => ({ failed: true, error }),
			);
			try {
				await bounded(snapshot.promise);
				await writeBinding(writer, input!, client);
				expect(
					await client.generationJob.findUniqueOrThrow({ where: { id: input!.jobId } }),
				).toEqual(before);
				release.resolve();
				const result = await outcome;
				console.info(
					"output.claim.mixed-isolation",
					JSON.stringify({
						writer,
						oldSettlementRejected: result.failed,
						serializationConflict: result.error
							? isDatabaseSerializationConflict(result.error)
							: false,
					}),
				);
				expect(result.failed).toBe(true);
				expect(isDatabaseSerializationConflict(result.error)).toBe(true);
				expect(
					(await client.generationJob.findUniqueOrThrow({ where: { id: input!.jobId } })).status,
				).toBe("FINALIZING");
				expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(1);
			} finally {
				release.resolve();
				await outcome;
			}
		},
	);

	it.each(bindingWriters)(
		"%s cannot add an output after a ReadCommitted terminal writer wins",
		async (writer) => {
			const [input] = await fixtures(1);
			const snapshot = deferred();
			const release = deferred();
			let attempts = 0;
			let conflicts = 0;
			const observed = client.$extends({}) as unknown as PrismaClient;
			const transaction = observed.$transaction.bind(observed);
			vi.spyOn(observed, "$transaction").mockImplementation(((
				operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
				options: { isolationLevel: Prisma.TransactionIsolationLevel },
			) =>
				transaction(async (tx) => {
					attempts += 1;
					if (attempts === 1) {
						// Deliberately establish an older SSI snapshot before the writer's
						// first statement. RC must read fresh; SSI must abort and then retry.
						expect(
							(await tx.generationJob.findUniqueOrThrow({ where: { id: input!.jobId } })).status,
						).toBe("FINALIZING");
						snapshot.resolve();
						await release.promise;
					}
					try {
						return await operation(tx);
					} catch (error) {
						if (isDatabaseSerializationConflict(error)) conflicts += 1;
						throw error;
					}
				}, options)) as typeof observed.$transaction);
			const operation = writeBinding(writer, input!, observed);
			void operation.catch(snapshot.reject);
			const outcome = operation.then(
				() => ({ failed: false, error: undefined }),
				(error: unknown) => ({ failed: true, error }),
			);
			try {
				await bounded(snapshot.promise);
				await client.$transaction(
					async (tx) => {
						await tx.generationJob.update({
							where: { id: input!.jobId },
							data: { status: "FAILED", terminalAt: new Date(), version: { increment: 1 } },
						});
					},
					{ isolationLevel: "ReadCommitted" },
				);
				release.resolve();
				const result = await bounded(outcome);
				expect(result.failed).toBe(true);
				expect(result.error).toMatchObject({ message: "GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT" });
				expect(conflicts).toBe(writer === "fresh-read-claim" ? 0 : 1);
				expect(attempts).toBe(writer === "fresh-read-claim" ? 1 : 2);
				expect(await client.mediaAsset.findUnique({ where: { id: input!.assetId } })).toBeNull();
				expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(0);
				expect(
					(await client.generationJob.findUniqueOrThrow({ where: { id: input!.jobId } })).status,
				).toBe("FAILED");
			} finally {
				release.resolve();
				await outcome;
			}
		},
	);

	it("grants one lease for simultaneous claims of the same asset", async () => {
		const [input] = await fixtures(1);
		const results = await Promise.all(
			Array.from({ length: 12 }, () =>
				claimGenerationOutputTransferTransaction(
					{ ...input!, streamingTransfersOnly: false },
					client,
				),
			),
		);
		expect(results.filter((result) => result.outcome === "CLAIMED")).toHaveLength(1);
		expect(results.filter((result) => result.outcome === "IN_PROGRESS")).toHaveLength(11);
		expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(1);
		expect(await client.storageUsageReservation.count({ where: { ownerId: input!.ownerId } })).toBe(
			0,
		);
	});

	it("allows a different owner to progress while one job is locked", async () => {
		const [first, second] = await fixtures(2);
		const blocker = await blockTransaction(
			(tx) => tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${first!.jobId} FOR UPDATE`,
		);
		const waiting = claimGenerationOutputTransferTransaction(first!, client);
		try {
			await waitForBlocked(blocker.pid);
			expect(
				await bounded(claimGenerationOutputTransferTransaction(second!, client)),
			).toMatchObject({ outcome: "CLAIMED" });
			blocker.release();
			await blocker.operation;
			expect(await waiting).toMatchObject({ outcome: "CLAIMED" });
		} finally {
			blocker.release();
			await Promise.allSettled([blocker.operation, waiting]);
		}
	});

	it.each(["job", "binding", "asset"] as const)(
		"uses the wall clock after the %s lock when guest retention expires",
		async (lock) => {
			const [input] = await fixtures(1);
			const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
			const due = new Date(clock!.now.getTime() + 800);
			const guest = await makeGuest(input!, due);
			await seedAsset(guest, { retentionClass: "GUEST_TRIAL", deleteAfter: due });
			const blocker = await blockTransaction(async (tx) => {
				if (lock === "job")
					await tx.$queryRaw`SELECT id FROM generation_job WHERE id = ${guest.jobId} FOR UPDATE`;
				else if (lock === "binding")
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`media-asset-generation-binding:${guest.assetId}`}, 0))`;
				else await tx.$queryRaw`SELECT id FROM media_asset WHERE id = ${guest.assetId} FOR UPDATE`;
			});
			const waiting = claimGenerationOutputTransferTransaction(guest, client);
			const outcome = waiting.then(
				(value) => ({ value, error: undefined }),
				(error: unknown) => ({ value: undefined, error }),
			);
			try {
				await waitForBlocked(blocker.pid);
				await client.$queryRaw`SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM (${due}::timestamptz - clock_timestamp())), 0) + 0.02)::text`;
				blocker.release();
				await blocker.operation;
				expect((await outcome).error).toMatchObject({
					message: "GENERATION_OUTPUT_GUEST_RETENTION_INVALID",
				});
				expect(
					(await client.mediaAsset.findUniqueOrThrow({ where: { id: guest.assetId } }))
						.outputTransferToken,
				).toBeNull();
				expect(await client.generationJobAsset.count({ where: { jobId: guest.jobId } })).toBe(0);
			} finally {
				blocker.release();
				await Promise.allSettled([blocker.operation, outcome]);
			}
		},
	);

	it("reclaims an expired transfer with a fresh token after waiting for its asset row", async () => {
		const [input] = await fixtures(1);
		const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
		const due = new Date(clock!.now.getTime() + 800);
		const oldToken = crypto.randomUUID();
		await seedAsset(input!, {
			outputTransferToken: oldToken,
			outputTransferLeaseExpiresAt: due,
			outputStagingObjectKey: `old/${oldToken}.png`,
			outputPromotionMultipartUploadId: "old-multipart",
		});
		const blocker = await blockTransaction(
			(tx) => tx.$queryRaw`SELECT id FROM media_asset WHERE id = ${input!.assetId} FOR UPDATE`,
		);
		const waiting = claimGenerationOutputTransferTransaction(
			{ ...input!, streamingTransfersOnly: false },
			client,
		);
		try {
			await waitForBlocked(blocker.pid);
			await client.$queryRaw`SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM (${due}::timestamptz - clock_timestamp())), 0) + 0.02)::text`;
			blocker.release();
			await blocker.operation;
			const result = await waiting;
			expect(result.outcome).toBe("CLAIMED");
			if (result.outcome !== "CLAIMED") throw new Error("EXPECTED_NEW_CLAIM");
			expect(result.freshAsset).toBe(false);
			expect(result.transferToken).not.toBe(oldToken);
			const asset = await client.mediaAsset.findUniqueOrThrow({ where: { id: input!.assetId } });
			expect(asset.outputTransferToken).toBe(result.transferToken);
			expect(asset.outputTransferLeaseExpiresAt!.getTime()).toBeGreaterThan(due.getTime());
			expect(await client.outboxEvent.count({ where: { aggregateId: input!.assetId } })).toBe(2);
		} finally {
			blocker.release();
			await Promise.allSettled([blocker.operation, waiting]);
		}
	});

	it("does not bind an output after a concurrent terminal job transition", async () => {
		const [input] = await fixtures(1);
		const blocker = await blockTransaction((tx) =>
			tx.generationJob.update({ where: { id: input!.jobId }, data: { status: "FAILED" } }),
		);
		const waiting = claimGenerationOutputTransferTransaction(
			{ ...input!, streamingTransfersOnly: false },
			client,
		);
		const outcome = waiting.then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		try {
			await waitForBlocked(blocker.pid);
			blocker.release();
			await blocker.operation;
			expect((await outcome).error).toMatchObject({
				message: "GENERATION_JOB_NOT_FINALIZING_FOR_OUTPUT",
			});
			expect(await client.mediaAsset.findUnique({ where: { id: input!.assetId } })).toBeNull();
			expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(0);
		} finally {
			blocker.release();
			await Promise.allSettled([blocker.operation, outcome]);
		}
	});

	it("does not revive an output deleted before its claim acquires the binding lock", async () => {
		const [input] = await fixtures(1);
		await seedAsset(input!);
		const ready = deferred();
		const release = deferred();
		const deleting = client.$extends({
			query: {
				mediaAsset: {
					async update({ args, query }) {
						const result = await query(args);
						if (args.where.id === input!.assetId && args.data.status === "DELETED") {
							ready.resolve();
							await release.promise;
						}
						return result;
					},
				},
			},
		}) as unknown as PrismaClient;
		const deletion = markMediaAssetDeletedTransaction(
			{ assetId: input!.assetId, ownerId: input!.ownerId },
			deleting,
		);
		void deletion.catch(ready.reject);
		let waiting: Promise<unknown> | undefined;
		try {
			await bounded(ready.promise);
			waiting = claimGenerationOutputTransferTransaction(
				{ ...input!, streamingTransfersOnly: false },
				client,
			);
			const outcome = waiting.then(
				(value) => ({ value, error: undefined }),
				(error: unknown) => ({ value: undefined, error }),
			);
			release.resolve();
			await deletion;
			expect((await outcome).error).toMatchObject({ message: "GENERATION_OUTPUT_ASSET_DELETED" });
			expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(0);
		} finally {
			release.resolve();
			await Promise.allSettled([deletion, ...(waiting ? [waiting] : [])]);
		}
	});

	it.each(["owner", "engine", "identity"] as const)(
		"rejects an existing output with a foreign %s",
		async (conflict) => {
			const [input, other] = await fixtures(2);
			await seedAsset(
				input!,
				conflict === "owner"
					? { ownerId: other!.ownerId }
					: conflict === "engine"
						? { verificationEngine: "video-workflow-v1" }
						: { sourceUrl: "provider-output:foreign" },
			);
			await expect(claimGenerationOutputTransferTransaction(input!, client)).rejects.toThrow(
				"GENERATION_OUTPUT_ASSET_CONFLICT",
			);
			expect(
				(await client.mediaAsset.findUniqueOrThrow({ where: { id: input!.assetId } }))
					.outputTransferToken,
			).toBeNull();
			expect(await client.generationJobAsset.count({ where: { jobId: input!.jobId } })).toBe(0);
		},
	);

	it.each(bindingWriters)(
		"%s rolls the output and job fence back when binding fails",
		async (writer) => {
			const [input] = await fixtures(1);
			const [before] = await client.$queryRaw<
				Array<{ version: string }>
			>`SELECT xmin::text AS version FROM generation_job WHERE id = ${input!.jobId}`;
			const failing = client.$extends({
				query: {
					generationJobAsset: {
						async upsert() {
							throw new Error("CLAIM_BINDING_INSERT_FAILED");
						},
					},
				},
			}) as unknown as PrismaClient;
			await expect(writeBinding(writer, input!, failing)).rejects.toThrow(
				"CLAIM_BINDING_INSERT_FAILED",
			);
			expect(await client.mediaAsset.findUnique({ where: { id: input!.assetId } })).toBeNull();
			const [after] = await client.$queryRaw<
				Array<{ version: string }>
			>`SELECT xmin::text AS version FROM generation_job WHERE id = ${input!.jobId}`;
			expect(after).toEqual(before);
		},
	);

	it.each([undefined, "false", "TRUE"])(
		"keeps the Serializable default when the flag is %s",
		async (flag) => {
			vi.stubEnv("MEDIA_STORAGE_FRESH_READ_ENABLED", flag);
			const [input] = await fixtures(1);
			const levels: string[] = [];
			const observed = client.$extends({
				query: {
					generationJob: {
						async findFirst({ args, query }) {
							return query(args);
						},
					},
				},
			}) as unknown as PrismaClient;
			const transaction = observed.$transaction.bind(observed);
			vi.spyOn(observed, "$transaction").mockImplementation(((
				callback: unknown,
				options: { isolationLevel: string },
			) => {
				levels.push(options.isolationLevel);
				return transaction(callback as never, options as never);
			}) as typeof observed.$transaction);
			expect(await claimGenerationOutputTransferTransaction(input!, observed)).toMatchObject({
				outcome: "CLAIMED",
				freshAsset: true,
			});
			expect(levels).toEqual(["Serializable"]);
		},
	);

	it("claims outputs for 50 independent users without exhausting transaction retries", async () => {
		const inputs = await fixtures(50);
		const ids = new Set(inputs.map((input) => input.assetId));
		const observed = new Set<string>();
		const barrier = deferred();
		let statementConflicts = 0;
		const instrumented = client.$extends({
			query: {
				mediaAsset: {
					async findUnique({ args, query }) {
						const value = await query(args);
						if (
							args.where.id &&
							ids.has(args.where.id) &&
							value === null &&
							!observed.has(args.where.id)
						) {
							observed.add(args.where.id);
							if (observed.size === inputs.length) barrier.resolve();
							await barrier.promise;
						}
						return value;
					},
				},
				$allModels: {
					async $allOperations({ args, query }) {
						try {
							return await query(args);
						} catch (error) {
							if (isDatabaseSerializationConflict(error)) statementConflicts++;
							throw error;
						}
					},
				},
			},
		}) as unknown as PrismaClient;
		const timeout = setTimeout(barrier.resolve, 5_000);
		const startedAt = performance.now();
		const results = await Promise.allSettled(
			inputs.map((input) => claimGenerationOutputTransferTransaction(input, instrumented)),
		);
		clearTimeout(timeout);
		const rejected = results.filter((result) => result.status === "rejected");
		console.info(
			"output.claim.cohort",
			JSON.stringify({
				count: inputs.length,
				arrived: observed.size,
				statementConflicts,
				fulfilled: results.length - rejected.length,
				rejected: rejected.length,
				elapsedMs: performance.now() - startedAt,
				errors: rejected.map((result) => ({
					name: result.reason?.name,
					code: result.reason?.code,
					message: result.reason?.message,
				})),
			}),
		);
		expect(observed.size).toBe(50);
		expect(rejected).toEqual([]);
		expect(statementConflicts).toBe(0);
		expect(
			results.every(
				(result) => result.status === "fulfilled" && result.value.outcome === "CLAIMED",
			),
		).toBe(true);
		expect(
			await client.generationJobAsset.count({
				where: { jobId: { in: inputs.map((input) => input.jobId) }, role: "OUTPUT" },
			}),
		).toBe(50);
	});
});
